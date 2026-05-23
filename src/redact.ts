/**
 * `agentbench redact <trace>` — strip sensitive fields from a recorded trace
 * before sharing.
 *
 * `agentbench` traces capture real agent runs: tool inputs, tool outputs,
 * prompts, assistant content. Before that JSON can be attached to a bug
 * report, copied into a public regression test, or pasted into a blog post,
 * any embedded PII / auth material has to go. `redact` is the deliberate
 * step between "I have a trace" and "I can share this trace."
 *
 * What's redacted by default:
 *
 *   - String values matching common secret/PII shapes:
 *       · email addresses
 *       · API-key prefixes (`sk-...`, `xoxb-...`, `ghp_...`, `ghs_...`,
 *         `npm_...`, `Bearer ...`)
 *       · JWT-shaped strings (`eyJ...` three base64 segments, >80 chars)
 *   - Whole field values for object keys named `email`, `phone`, `ssn`,
 *     `password`, `token`, `secret`, `apiKey`, `api_key`, `authorization`,
 *     `auth`.
 *
 * UUIDs are NOT redacted — they're frequently legitimate test identifiers
 * and over-redacting them strips useful debugging context. Same reason we
 * deliberately do NOT try to detect names, addresses, phone numbers via
 * regex: that's a losing arms race and would shred real trace content.
 *
 * IMPORTANT: regex-based PII detection is fundamentally a best-effort
 * heuristic. The default rules catch the most common foot-guns; they do
 * NOT guarantee a redacted trace contains no sensitive data. Always eyeball
 * the output before sharing.
 *
 * The redacted file must still be a valid trace — `redactTrace` re-validates
 * the output against `TraceSchema`, the same schema `compare` and `bless`
 * use. Structure is preserved exactly: step ordering, kinds, tool-call
 * sequence. Only string values change, and only via local replacement.
 */
import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { TraceSchema } from "./trace.js";
import { validateAgentbenchFile } from "./validate.js";

export interface RedactRules {
  /**
   * String patterns to match inside any string value. Each pattern is paired
   * with the reason label that gets stamped into the `<REDACTED:reason>`
   * placeholder. Defaults are merged with user-supplied patterns — user
   * patterns extend, never replace, the defaults.
   */
  patterns?: RedactPattern[];
  /**
   * Object keys whose VALUES are wholesale replaced with `<REDACTED:pii>`,
   * regardless of the value's shape (string, number, nested object). Match
   * is case-insensitive and exact on the key name.
   */
  piiKeys?: string[];
}

export interface RedactPattern {
  /** Compiled regex; expected to have the `g` flag for global replace. */
  pattern: RegExp;
  /** Short label, e.g. `"email"`, `"api-key"`, used in `<REDACTED:label>`. */
  reason: string;
}

export interface RedactOptions {
  /** Path to the trace file to read. */
  tracePath: string;
  /**
   * Where to write the redacted file. Defaults to a sibling named
   * `<basename>.redacted.<ext>`. Ignored when `dryRun: true`.
   */
  outPath?: string;
  /**
   * User-supplied rules layered on top of the defaults. The defaults always
   * apply; these only add to them.
   */
  rules?: RedactRules;
  /**
   * When true, report counts but write nothing. `outPath` is still resolved
   * and surfaced in the result so callers can render a plan.
   */
  dryRun?: boolean;
}

export interface RedactCounts {
  /** Total number of redactions across every reason. */
  total: number;
  /** Counts per `<REDACTED:reason>` reason. */
  byReason: Record<string, number>;
}

export interface RedactResult {
  /** Absolute path of the input file. */
  tracePath: string;
  /** Absolute path the redacted file was (or would be) written to. */
  outPath: string;
  /** Counts of replacements applied. */
  counts: RedactCounts;
  /** True if `--dry-run` was set: nothing was written. */
  dryRun: boolean;
}

/** Thrown when the trace JSON parses but isn't a valid Trace. */
export class NotATraceError extends Error {
  constructor(tracePath: string, summary: string) {
    super(`not a valid trace: ${tracePath}\n  ${summary}`);
    this.name = "NotATraceError";
  }
}

/**
 * Default string patterns. Order matters: more-specific patterns run before
 * more-general ones, otherwise a JWT-looking string could swallow an email
 * inside it (it can't, in practice — `@` is not a base64 char — but it's
 * cheap insurance for future patterns).
 */
export const DEFAULT_PATTERNS: ReadonlyArray<RedactPattern> = [
  // Email — RFC 5322 is a swamp; this is the "good enough for stripping
  // contact info out of trace strings" shape.
  {
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    reason: "email",
  },
  // `Bearer <token>` — match before bare token patterns so the whole
  // `Bearer xxx` chunk goes together (more legible in the redacted output).
  {
    pattern: /Bearer\s+[A-Za-z0-9._-]+/g,
    reason: "api-key",
  },
  // OpenAI-style `sk-...` keys (project keys, classic keys, etc.).
  {
    pattern: /sk-[A-Za-z0-9_-]{20,}/g,
    reason: "api-key",
  },
  // Slack bot tokens.
  {
    pattern: /xoxb-[A-Za-z0-9-]{10,}/g,
    reason: "api-key",
  },
  // GitHub personal access / server-to-server tokens.
  {
    pattern: /gh[ps]_[A-Za-z0-9]{20,}/g,
    reason: "api-key",
  },
  // npm automation tokens.
  {
    pattern: /npm_[A-Za-z0-9]{20,}/g,
    reason: "api-key",
  },
  // JWT — three base64 segments joined by dots, total length > 80, leading
  // `eyJ` (the canonical `{"` header prefix). Anchored on the eyJ start so
  // we don't catch a base64 fragment that happens to live in tool output.
  {
    pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    reason: "jwt",
  },
];

/**
 * Default PII key names. Matched case-insensitively, exact match (no
 * substring). E.g. `userEmail` is NOT caught here on purpose — its string
 * value still goes through the email-shape pattern.
 */
export const DEFAULT_PII_KEYS: ReadonlyArray<string> = [
  "email",
  "phone",
  "ssn",
  "password",
  "token",
  "secret",
  "apiKey",
  "api_key",
  "authorization",
  "auth",
];

const REDACTED_PII = "<REDACTED:pii>";
const JWT_MIN_LENGTH = 80;

/**
 * Read a JSON `RedactRules` file from disk. The expected shape is:
 *
 *   { "patterns": ["regex source", ...], "piiKeys": ["fieldname", ...] }
 *
 * Patterns are compiled with the `g` flag and tagged with a `custom-<n>`
 * reason so users can tell custom hits apart from built-ins in the counter.
 * Throws a clear error if the file is missing, malformed, or has the wrong
 * shape — never silently accepts garbage.
 */
export async function loadRulesFile(rulesPath: string): Promise<RedactRules> {
  let raw: string;
  try {
    raw = await readFile(rulesPath, "utf8");
  } catch (err) {
    throw new Error(`could not read rules file ${rulesPath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`rules file ${rulesPath} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`rules file ${rulesPath} must be a JSON object`);
  }
  const obj = parsed as { patterns?: unknown; piiKeys?: unknown };
  const out: RedactRules = {};
  if (obj.patterns !== undefined) {
    if (!Array.isArray(obj.patterns) || !obj.patterns.every((p) => typeof p === "string")) {
      throw new Error(`rules file ${rulesPath}: \`patterns\` must be an array of strings`);
    }
    out.patterns = (obj.patterns as string[]).map((src, i) => {
      try {
        return { pattern: new RegExp(src, "g"), reason: `custom-${i + 1}` };
      } catch (err) {
        throw new Error(
          `rules file ${rulesPath}: invalid regex at patterns[${i}]: ${(err as Error).message}`,
        );
      }
    });
  }
  if (obj.piiKeys !== undefined) {
    if (!Array.isArray(obj.piiKeys) || !obj.piiKeys.every((k) => typeof k === "string")) {
      throw new Error(`rules file ${rulesPath}: \`piiKeys\` must be an array of strings`);
    }
    out.piiKeys = obj.piiKeys as string[];
  }
  return out;
}

/**
 * Redact sensitive content from a trace file. See module JSDoc for what's
 * caught by default. See {@link RedactOptions} for flags.
 *
 * Order of operations:
 *
 *   1. Read + JSON-parse the input.
 *   2. Validate against `TraceSchema` — refuse to redact non-traces, since
 *      "I redacted some JSON" promises an output the rest of the toolchain
 *      can still consume.
 *   3. Walk the parsed tree. For every object key matching a PII-key,
 *      replace its whole value with `<REDACTED:pii>`. For every string
 *      value, run all string patterns and replace matches with
 *      `<REDACTED:<reason>>`.
 *   4. Re-validate the redacted tree against `TraceSchema` — if a custom
 *      rule somehow broke the shape, fail loud instead of writing a file
 *      that no longer parses.
 *   5. Atomic write (tmp + rename) unless `dryRun`.
 */
export async function redactTrace(options: RedactOptions): Promise<RedactResult> {
  const tracePath = path.resolve(options.tracePath);

  // 1. Read + parse.
  let raw: string;
  try {
    raw = await readFile(tracePath, "utf8");
  } catch (err) {
    throw new Error(`could not read trace ${tracePath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`trace is not valid JSON: ${tracePath}: ${(err as Error).message}`);
  }

  // 2. Validate input shape — never claim to "redact" something that wasn't
  //    a trace to begin with.
  const inputValidation = TraceSchema.safeParse(parsed);
  if (!inputValidation.success) {
    throw new NotATraceError(tracePath, summariseZodIssues(inputValidation.error.issues));
  }

  // 3. Walk + redact.
  const patterns: RedactPattern[] = [...DEFAULT_PATTERNS, ...(options.rules?.patterns ?? [])];
  const piiKeys = new Set(
    [...DEFAULT_PII_KEYS, ...(options.rules?.piiKeys ?? [])].map((k) => k.toLowerCase()),
  );
  const counts: RedactCounts = { total: 0, byReason: {} };
  const redacted = walk(parsed, patterns, piiKeys, counts);

  // 4. Re-validate. The redactor only ever replaces string values, never
  //    removes or reorders, so this should be impossible to fail with the
  //    default rules — but custom-key rules from `--rules` could in
  //    principle blank out a required string. Catch it before we write.
  const outputValidation = TraceSchema.safeParse(redacted);
  if (!outputValidation.success) {
    throw new Error(
      `redaction would produce an invalid trace (this is a bug or a too-aggressive custom rule): ${summariseZodIssues(
        outputValidation.error.issues,
      )}`,
    );
  }

  // Resolve outPath now so we can report it in dry-run too.
  const outPath = options.outPath ? path.resolve(options.outPath) : defaultOutPath(tracePath);

  // 5. Dry run — report and stop.
  if (options.dryRun) {
    return { tracePath, outPath, counts, dryRun: true };
  }

  // Atomic write: tmp sibling + rename. Same pattern bless uses.
  const serialized = `${JSON.stringify(redacted, null, 2)}\n`;
  const tmpPath = path.join(
    path.dirname(outPath),
    `.${path.basename(outPath)}.redact-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(tmpPath, serialized, "utf8");
    await rename(tmpPath, outPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  return { tracePath, outPath, counts, dryRun: false };
}

/**
 * Compute the default output path for a redacted trace. Inserts
 * `.redacted` before the final extension. `refund.json` → `refund.redacted.json`.
 * Files without an extension get `.redacted` appended.
 */
function defaultOutPath(tracePath: string): string {
  const dir = path.dirname(tracePath);
  const base = path.basename(tracePath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return path.join(dir, ext ? `${stem}.redacted${ext}` : `${stem}.redacted`);
}

/**
 * Recursive walker. Pure on the input — returns a NEW tree (we never mutate
 * the caller's parsed object). Counts are accumulated into `counts`.
 *
 * For arrays we walk each element. For objects we walk each entry, but if
 * the key is a PII key we short-circuit: replace the whole value with the
 * PII sentinel and bump the counter, without recursing into a nested
 * object. That's the whole point of marking a key as PII — we don't want
 * to leak a redacted-looking object structure either.
 */
function walk(
  node: unknown,
  patterns: RedactPattern[],
  piiKeys: Set<string>,
  counts: RedactCounts,
): unknown {
  if (typeof node === "string") {
    return redactString(node, patterns, counts);
  }
  if (Array.isArray(node)) {
    return node.map((el) => walk(el, patterns, piiKeys, counts));
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (piiKeys.has(key.toLowerCase())) {
        out[key] = REDACTED_PII;
        bump(counts, "pii");
        continue;
      }
      out[key] = walk(value, patterns, piiKeys, counts);
    }
    return out;
  }
  // numbers, booleans, null — passed through untouched.
  return node;
}

/**
 * Apply every string pattern to a single string value. JWT pattern enforces
 * a length floor here (rather than embedding it in the regex) because the
 * shape itself is too cheap to express without false positives — there's no
 * way to write "three base64 segments AND total length > 80" purely in a
 * single regex without making the source unreadable.
 */
function redactString(value: string, patterns: RedactPattern[], counts: RedactCounts): string {
  let out = value;
  for (const { pattern, reason } of patterns) {
    // Reset lastIndex defensively — these are shared module-level RegExps
    // with the `g` flag, and a previous run could leave lastIndex non-zero.
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match) => {
      if (reason === "jwt" && match.length < JWT_MIN_LENGTH) {
        return match;
      }
      bump(counts, reason);
      return `<REDACTED:${reason}>`;
    });
  }
  return out;
}

function bump(counts: RedactCounts, reason: string): void {
  counts.byReason[reason] = (counts.byReason[reason] ?? 0) + 1;
  counts.total += 1;
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

/**
 * Re-validate a file on disk against the same schema `compare` / `validate`
 * use. Re-uses the existing module so the validator and the redactor can
 * never disagree on what counts as a valid trace.
 *
 * Exposed for tests that want to assert the redacted file still passes
 * `agentbench validate`.
 */
export async function validateRedactedFile(filePath: string): Promise<boolean> {
  const result = await validateAgentbenchFile(filePath);
  return result.ok;
}

/** Render `RedactResult` as a human-friendly multi-line string. */
export function formatRedact(result: RedactResult): string {
  const lines: string[] = [];
  if (result.dryRun) {
    lines.push(`dry-run: would write ${result.outPath}`);
  } else {
    lines.push(`wrote ${result.outPath}`);
  }
  lines.push(`redactions: ${result.counts.total}`);
  const reasons = Object.entries(result.counts.byReason).sort(([a], [b]) => a.localeCompare(b));
  for (const [reason, count] of reasons) {
    lines.push(`  · ${reason}: ${count}`);
  }
  return lines.join("\n");
}

/** Render `RedactResult` as stable JSON, trailing newline included. */
export function formatRedactJson(result: RedactResult): string {
  return `${JSON.stringify(
    {
      tracePath: result.tracePath,
      outPath: result.outPath,
      dryRun: result.dryRun,
      counts: result.counts,
    },
    null,
    2,
  )}\n`;
}
