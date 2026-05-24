/**
 * `agentbench merge <trace1> <trace2> [...]` — concatenate multiple traces
 * into a single trace.
 *
 * When you're building a regression suite or assembling a canonical baseline
 * from a handful of short multi-turn runs, you eventually want them as one
 * trace: easier to compare, easier to bless, easier to share. `merge` does
 * exactly that — read N traces, concatenate their `steps[]` in input order,
 * write one trace.
 *
 * Behaviour:
 *
 *   - Every input is read AND validated against `TraceSchema` before any
 *     work happens. One invalid source aborts the whole run — we never
 *     write a partially-merged file.
 *   - Output `name` defaults to the first source's `name`. `--name`
 *     overrides.
 *   - Output `model` defaults to the first source's `model`. If sources
 *     disagree, a warning is emitted on stderr and the first wins.
 *     `--model` overrides everything (no warning — it's an explicit choice).
 *   - `meta` is merged shallowly. Later sources can append non-conflicting
 *     keys. On key conflict the first occurrence wins and a warning is
 *     emitted on stderr.
 *   - The merged trace is re-validated against `TraceSchema` before write —
 *     the same shape guarantee `bless` / `redact` / `export` give.
 *
 * The output is a derived artifact. We don't atomic-rename here (unlike
 * `bless`); a plain `writeFile` is fine and matches `export`'s posture.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Trace, TraceSchema } from "./trace.js";

export interface MergeOptions {
  /** Paths to the trace files to merge, in concatenation order. */
  inputPaths: string[];
  /**
   * Where to write the merged trace. Defaults to `merged.json` in cwd.
   * Always resolved to an absolute path on the result.
   */
  outPath?: string;
  /** Override the output trace's `name`. Defaults to the first source's name. */
  name?: string;
  /** Override the output trace's `model`. Defaults to the first source's model. */
  model?: string;
  /**
   * Sink for non-fatal warnings (model disagreement, meta-key conflicts).
   * Defaults to `process.stderr.write`. Tests inject their own to capture.
   */
  warn?: (message: string) => void;
}

export interface MergeResult {
  /** Absolute path the merged trace was written to. */
  outPath: string;
  /** Total step count across the merged trace. */
  totalSteps: number;
  /** Number of source traces that contributed. */
  sourceCount: number;
}

/** Thrown when one of the input traces fails schema validation. */
export class InvalidSourceError extends Error {
  constructor(tracePath: string, summary: string) {
    super(`refusing to merge an invalid source trace: ${tracePath}\n  ${summary}`);
    this.name = "InvalidSourceError";
  }
}

/** Thrown when zero inputs were supplied. */
export class NoSourcesError extends Error {
  constructor() {
    super("merge requires at least one input trace");
    this.name = "NoSourcesError";
  }
}

/**
 * Merge `inputPaths` into a single trace. See {@link MergeOptions}.
 *
 * Order of operations:
 *
 *   1. Validate the input list itself — refuse empty.
 *   2. For every input: read, JSON-parse, schema-validate. Bail on the
 *      first failure with `InvalidSourceError` — never write a partial
 *      mess.
 *   3. Resolve effective `name` / `model` (overrides win; otherwise the
 *      first source; warn on model disagreement).
 *   4. Concatenate `steps[]` in input order. Merge `meta` shallowly with
 *      first-wins conflict resolution.
 *   5. Re-validate the merged trace. Refuse to write something the rest of
 *      the toolchain couldn't consume.
 *   6. Write. Plain `writeFile` — derived artifact, no atomic-rename dance.
 */
export async function mergeTraces(options: MergeOptions): Promise<MergeResult> {
  const warn = options.warn ?? ((m) => process.stderr.write(`${m}\n`));

  // 1. Input-list sanity.
  if (!options.inputPaths || options.inputPaths.length === 0) {
    throw new NoSourcesError();
  }

  // 2. Read + validate every source up front. If any fail, abort BEFORE
  //    writing — a half-merged output is worse than no output.
  const sources: { absPath: string; trace: Trace }[] = [];
  for (const raw of options.inputPaths) {
    const absPath = path.resolve(raw);
    let body: string;
    try {
      body = await readFile(absPath, "utf8");
    } catch (err) {
      throw new Error(`could not read trace ${absPath}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      throw new Error(`trace is not valid JSON: ${absPath}: ${(err as Error).message}`);
    }
    const validation = TraceSchema.safeParse(parsed);
    if (!validation.success) {
      throw new InvalidSourceError(absPath, summariseZodIssues(validation.error.issues));
    }
    sources.push({ absPath, trace: validation.data });
  }

  // 3. Resolve name + model. The first source is the default; explicit
  //    overrides win. Model disagreement across sources earns a warning.
  // sources.length >= 1 — guaranteed by the empty-list check above.
  const first = sources[0] as { absPath: string; trace: Trace };
  const effectiveName = options.name ?? first.trace.name;

  let effectiveModel: string | undefined;
  if (options.model !== undefined) {
    // Explicit override — no disagreement warning, the user picked.
    effectiveModel = options.model;
  } else {
    effectiveModel = first.trace.model;
    const distinctModels = new Set<string>();
    for (const s of sources) {
      if (s.trace.model !== undefined) distinctModels.add(s.trace.model);
    }
    if (distinctModels.size > 1) {
      const list = [...distinctModels].sort().join(", ");
      warn(
        `warn: source traces disagree on model (${list}); using ${
          effectiveModel ?? "(none)"
        } from ${path.basename(first.absPath)}`,
      );
    }
  }

  // 4. Concatenate steps. Plain in-order push — no de-duplication, no
  //    re-ordering. The whole point of merge is that the caller controls
  //    the sequence by listing files in the order they want them.
  const mergedSteps = sources.flatMap((s) => s.trace.steps);

  // Shallow meta merge with first-wins conflict resolution.
  let mergedMeta: Record<string, unknown> | undefined;
  const metaSourceFor = new Map<string, string>();
  for (const s of sources) {
    if (!s.trace.meta) continue;
    if (!mergedMeta) mergedMeta = {};
    for (const [key, value] of Object.entries(s.trace.meta)) {
      if (Object.hasOwn(mergedMeta, key)) {
        // First wins. Warn so the user knows their later source's value
        // was silently dropped.
        const firstFrom = metaSourceFor.get(key) ?? "(unknown)";
        warn(
          `warn: meta key "${key}" conflicts between ${firstFrom} and ${path.basename(
            s.absPath,
          )}; keeping value from ${firstFrom}`,
        );
        continue;
      }
      mergedMeta[key] = value;
      metaSourceFor.set(key, path.basename(s.absPath));
    }
  }

  // 5. Build + re-validate. The constituent parts already passed
  //    `TraceSchema`; the only way the merged trace fails is a degenerate
  //    `--name=""` override (Trace.name has `min(1)`). Catch that BEFORE
  //    writing.
  const merged: Trace = {
    name: effectiveName,
    steps: mergedSteps,
    ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
    ...(mergedMeta !== undefined ? { meta: mergedMeta } : {}),
  };
  const outValidation = TraceSchema.safeParse(merged);
  if (!outValidation.success) {
    throw new Error(
      `merge would produce an invalid trace: ${summariseZodIssues(outValidation.error.issues)}`,
    );
  }

  // 6. Resolve output path + write. Default `merged.json` in cwd matches
  //    the docs.
  const outPath = options.outPath
    ? path.resolve(options.outPath)
    : path.resolve(process.cwd(), "merged.json");
  const serialized = `${JSON.stringify(outValidation.data, null, 2)}\n`;
  await writeFile(outPath, serialized, "utf8");

  return {
    outPath,
    totalSteps: mergedSteps.length,
    sourceCount: sources.length,
  };
}

/** Render a `MergeResult` as a human-friendly multi-line string. */
export function formatMerge(result: MergeResult): string {
  return [
    `wrote ${result.outPath}`,
    `sources: ${result.sourceCount}`,
    `steps: ${result.totalSteps}`,
  ].join("\n");
}

/** Render a `MergeResult` as stable JSON, trailing newline included. */
export function formatMergeJson(result: MergeResult): string {
  return `${JSON.stringify(
    {
      outPath: result.outPath,
      sourceCount: result.sourceCount,
      totalSteps: result.totalSteps,
    },
    null,
    2,
  )}\n`;
}

function summariseZodIssues(
  issues: ReadonlyArray<{ path: (string | number)[]; message: string }>,
): string {
  if (issues.length === 0) return "unknown schema error";
  const first = issues[0];
  if (!first) return "unknown schema error";
  const where = first.path.length === 0 ? "(root)" : first.path.join(".");
  const rest = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  return `${where}: ${first.message}${rest}`;
}
