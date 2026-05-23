/**
 * `agentbench validate <path>` — schema-check a trace file (or every trace
 * file in a directory) before compare runs against it.
 *
 * The compare module in v0.0.1 expects a `Trace` shape: `{ name, steps[] }`
 * with each step a discriminated union on `kind: "user" | "assistant"`. If a
 * baseline is hand-edited and the JSON drifts off that shape, `compare`
 * fails mid-run with a confusing zod stack. `validate` catches it up front
 * and reports every problem in one pass — without re-implementing the
 * schema. We re-use `TraceSchema` from `trace.ts` so the validator and the
 * comparer can never disagree.
 *
 * Directory mode: walk the dir for any file ending in `.json` or
 * `.agentbench` and validate each one. Aggregate per-file results so
 * callers can render a summary table.
 */
import type { Dirent, Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TraceSchema } from "./trace.js";

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: IssueSeverity;
  /** Dot-path into the trace where the issue was found (e.g. `steps.0.content`). */
  path: string;
  /** Human-readable message. */
  message: string;
}

export interface FileValidationResult {
  /** Absolute path to the file that was validated. */
  path: string;
  /** True if no `error`-severity issues were found. Warnings still allow `ok: true`. */
  ok: boolean;
  issues: ValidationIssue[];
  /** Brief one-line summary suitable for table rendering. */
  summary: string;
}

export interface ValidateResult {
  /** True if every file under `path` passed (no `error`-severity issues anywhere). */
  ok: boolean;
  /** Absolute path passed in. */
  path: string;
  /** One entry per file checked. In file mode, exactly one entry. */
  files: FileValidationResult[];
  /** Top-level summary (e.g. `3 files: 2 ok, 1 failed`). */
  summary: string;
}

const TRACE_EXTENSIONS = new Set([".json", ".agentbench"]);

/**
 * Validate a single `.agentbench` / `.json` trace file, or every trace file
 * in a directory. Never throws on validation problems — those are reported
 * via `issues`. Throws only on filesystem errors that prevent the check
 * from running at all (path missing, unreadable).
 */
export async function validateAgentbenchFile(target: string): Promise<ValidateResult> {
  const absPath = path.resolve(target);

  let s: Stats;
  try {
    s = await stat(absPath);
  } catch {
    throw new Error(`path does not exist: ${absPath}`);
  }

  if (s.isDirectory()) {
    return validateDirectory(absPath);
  }

  if (s.isFile()) {
    const fileResult = await validateOneFile(absPath);
    return {
      ok: fileResult.ok,
      path: absPath,
      files: [fileResult],
      summary: fileResult.ok
        ? `1 file: 1 ok${countWarnings(fileResult.issues) ? `, ${countWarnings(fileResult.issues)} warning(s)` : ""}`
        : "1 file: 1 failed",
    };
  }

  throw new Error(`not a file or directory: ${absPath}`);
}

async function validateDirectory(absDir: string): Promise<ValidateResult> {
  const candidates = await collectTraceFiles(absDir);
  candidates.sort();

  const files = await Promise.all(candidates.map((p) => validateOneFile(p)));

  const okCount = files.filter((f) => f.ok).length;
  const failCount = files.length - okCount;
  const warnCount = files.reduce((acc, f) => acc + countWarnings(f.issues), 0);

  let summary: string;
  if (files.length === 0) {
    summary = `0 files: nothing to validate (no .json or .agentbench files under ${absDir})`;
  } else {
    const parts = [`${files.length} files: ${okCount} ok`];
    if (failCount > 0) parts.push(`${failCount} failed`);
    if (warnCount > 0) parts.push(`${warnCount} warning(s)`);
    summary = parts.join(", ");
  }

  return {
    ok: failCount === 0,
    path: absDir,
    files,
    summary,
  };
}

async function collectTraceFiles(absDir: string): Promise<string[]> {
  const out: string[] = [];
  let dirents: Dirent[];
  try {
    dirents = await readdir(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of dirents) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(absDir, ent.name);
    if (ent.isDirectory()) {
      // Recurse — users organise traces by flow under baselines/<flow>/.
      out.push(...(await collectTraceFiles(full)));
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (TRACE_EXTENSIONS.has(ext) && ent.name !== "bench.json") {
      out.push(full);
    }
  }
  return out;
}

async function validateOneFile(absPath: string): Promise<FileValidationResult> {
  const issues: ValidationIssue[] = [];

  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch (err) {
    issues.push({
      severity: "error",
      path: "",
      message: `unreadable: ${(err as Error).message}`,
    });
    return finalise(absPath, issues);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    issues.push({
      severity: "error",
      path: "",
      message: `malformed JSON: ${(err as Error).message}`,
    });
    return finalise(absPath, issues);
  }

  const result = TraceSchema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push({
        severity: "error",
        path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
        message: zodIssueMessage(issue),
      });
    }
    return finalise(absPath, issues);
  }

  // Schema passed. Look for the soft warnings.
  const trace = result.data;

  if (trace.steps.length === 0) {
    issues.push({
      severity: "warning",
      path: "steps",
      message: "trace has no steps — nothing for compare to diff against",
    });
  }

  // Duplicate tool-call names within a single assistant step are legal but
  // usually a paste mistake. Flag, don't fail.
  for (let i = 0; i < trace.steps.length; i++) {
    const step = trace.steps[i];
    if (!step || step.kind !== "assistant") continue;
    const seen = new Map<string, number>();
    for (let j = 0; j < step.toolCalls.length; j++) {
      const name = step.toolCalls[j]?.name;
      if (!name) continue;
      const prior = seen.get(name);
      if (prior !== undefined) {
        issues.push({
          severity: "warning",
          path: `steps.${i}.toolCalls.${j}.name`,
          message: `duplicate tool call name '${name}' at indexes ${prior} and ${j} within the same step`,
        });
      } else {
        seen.set(name, j);
      }
    }
  }

  return finalise(absPath, issues);
}

function finalise(absPath: string, issues: ValidationIssue[]): FileValidationResult {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  const ok = errors === 0;
  const display = path.basename(absPath);
  let summary: string;
  if (ok && warnings === 0) {
    summary = `${display}: ok`;
  } else if (ok) {
    summary = `${display}: ok (${warnings} warning${warnings === 1 ? "" : "s"})`;
  } else {
    summary = `${display}: ${errors} error${errors === 1 ? "" : "s"}${
      warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""
    }`;
  }
  return { path: absPath, ok, issues, summary };
}

function countWarnings(issues: ValidationIssue[]): number {
  return issues.filter((i) => i.severity === "warning").length;
}

/**
 * Translate a single zod issue into a short, readable message. Zod's
 * default `message` is fine, but for the common `invalid_type` /
 * `invalid_union` cases we want compact phrasing that fits one terminal
 * row.
 */
function zodIssueMessage(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return `expected ${issue.expected}, got ${issue.received}`;
    case z.ZodIssueCode.invalid_literal:
      return `expected literal ${JSON.stringify(issue.expected)}`;
    case z.ZodIssueCode.too_small:
      return `value is too small (${issue.message})`;
    case z.ZodIssueCode.unrecognized_keys:
      return `unrecognised keys: ${issue.keys.join(", ")}`;
    case z.ZodIssueCode.invalid_union:
      return "value matched no allowed shape (expected user step or assistant step)";
    case z.ZodIssueCode.invalid_union_discriminator:
      return `invalid 'kind' — expected one of: ${issue.options.join(", ")}`;
    default:
      return issue.message;
  }
}

/**
 * Render a `ValidateResult` as a human-friendly multi-line string.
 * Pure — no I/O. Mirrors the style of `formatReport` / `formatList`.
 */
export function formatValidate(result: ValidateResult): string {
  const lines: string[] = [];
  for (const file of result.files) {
    lines.push(file.summary);
    for (const issue of file.issues) {
      const where = issue.path ? ` at ${issue.path}` : "";
      const label = issue.severity === "error" ? "error" : "warn";
      lines.push(`  · ${label}${where}: ${issue.message}`);
    }
  }
  lines.push("");
  lines.push(result.summary);
  return lines.join("\n");
}

/**
 * Render a `ValidateResult` as stable JSON, trailing newline included so
 * it pipes cleanly into `jq`.
 */
export function formatValidateJson(result: ValidateResult): string {
  return `${JSON.stringify(
    {
      ok: result.ok,
      path: result.path,
      summary: result.summary,
      files: result.files.map((f) => ({
        path: f.path,
        ok: f.ok,
        summary: f.summary,
        issues: f.issues,
      })),
    },
    null,
    2,
  )}\n`;
}
