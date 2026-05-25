/**
 * `agentbench head <trace>` — preview the first N steps of a recorded trace.
 *
 * The Unix-`head` analogue for trace files. `cat trace.json` is too noisy and
 * `agentbench replay … | head -n 5` mixes two contracts (NDJSON + line count
 * that doesn't map cleanly to "steps"). `head` is the dedicated peek: read
 * the trace, return its metadata plus the first N steps, let the caller
 * render. Same posture as the rest of the toolchain — read once, validate
 * against `TraceSchema`, refuse on broken input.
 *
 * Behaviour:
 *
 *   - Reads the trace and schema-validates it. Refuses on invalid the same
 *     way `export` / `replay` / `merge` do (`InvalidTraceError`).
 *   - Default `n = 5` — matches Unix `head` muscle memory.
 *   - `n > total` returns every step (no padding, no surprise).
 *   - `n = 0` is valid: zero shown, total preserved. Useful when callers
 *     just want the metadata.
 *   - Negative `n` is an error — `head -n -1` in real Unix means "all but
 *     the last line", and we don't want to silently disagree with that
 *     reading. Reject up front.
 *   - Returns metadata only; the CLI is responsible for rendering. Steps
 *     beyond `n` are dropped from the returned array, not nulled — the
 *     caller asked for N, the caller gets N.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TraceStep } from "./trace.js";
import { TraceSchema } from "./trace.js";

/** Default step count when `n` is omitted — same as Unix `head -n`. */
export const DEFAULT_HEAD_LINES = 5;

export interface HeadOptions {
  /** Path to the trace file to read. */
  tracePath: string;
  /**
   * How many steps to include in the result. Defaults to
   * {@link DEFAULT_HEAD_LINES} (5). `0` is valid — the caller gets metadata
   * with an empty `steps` array. Negative values throw.
   */
  n?: number;
}

export interface HeadResult {
  /** Trace `name`, mirrored from the source. */
  name: string;
  /** Trace `model`, mirrored from the source (may be `undefined`). */
  model?: string;
  /** How many steps actually made it into `steps[]` — `min(n, totalSteps)`. */
  stepsShown: number;
  /** Total step count in the source trace. */
  totalSteps: number;
  /**
   * The first `stepsShown` steps of the source trace, in order. Steps
   * beyond `n` are omitted entirely — the caller asked for N, they get N,
   * not N + a tail of `null`s.
   */
  steps: TraceStep[];
}

/** Thrown when the trace JSON parses but isn't a valid Trace. */
export class InvalidTraceError extends Error {
  constructor(tracePath: string, summary: string) {
    super(
      `refusing to head an invalid trace: ${tracePath}\n  ${summary}\n  rendering a preview from a broken trace would just produce confusing output — fix the file (or re-record) before previewing`,
    );
    this.name = "InvalidTraceError";
  }
}

/**
 * Preview the first `n` steps of a trace file. See {@link HeadOptions}.
 *
 * Order of operations:
 *
 *   1. Validate `n` — non-negative integer or `undefined`. Reject early so
 *      the caller never gets a partial result with a stale count.
 *   2. Read the trace file. Surface a clear error on ENOENT / permission
 *      failures rather than letting the raw `ENOENT: …` leak through.
 *   3. JSON-parse + schema-validate. Refuse on invalid the same way every
 *      other consuming subcommand does.
 *   4. Slice the first `n` steps. `Math.min(n, total)` so `n > total`
 *      degrades gracefully to "show everything we have".
 *   5. Return the metadata. The CLI is responsible for rendering; this
 *      module stays pure / testable / no-stdout.
 */
export async function headTrace(options: HeadOptions): Promise<HeadResult> {
  // 1. Validate `n`. `undefined` falls back to the default; negative or
  //    non-finite values are a user error (Unix `head -n -1` means "all but
  //    last line", which we don't implement — better to reject than disagree
  //    silently).
  const rawN = options.n;
  const n = rawN === undefined ? DEFAULT_HEAD_LINES : rawN;
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`invalid n: ${rawN} (expected a non-negative integer)`);
  }

  const tracePath = path.resolve(options.tracePath);

  // 2. Read. Be explicit about which file we couldn't reach.
  let raw: string;
  try {
    raw = await readFile(tracePath, "utf8");
  } catch (err) {
    throw new Error(`could not read trace ${tracePath}: ${(err as Error).message}`);
  }

  // 3. Parse + validate. Same posture as `export` / `replay` — refuse to
  //    return anything if the source isn't a real trace.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`trace is not valid JSON: ${tracePath}: ${(err as Error).message}`);
  }
  const validation = TraceSchema.safeParse(parsed);
  if (!validation.success) {
    throw new InvalidTraceError(tracePath, summariseZodIssues(validation.error.issues));
  }
  const trace = validation.data;

  // 4. Slice. `Math.min` so `n > total` returns every step rather than
  //    overshooting or padding.
  const totalSteps = trace.steps.length;
  const stepsShown = Math.min(n, totalSteps);
  const steps = trace.steps.slice(0, stepsShown);

  // 5. Mirror metadata back. `model` is optional on the source; preserve
  //    that optionality on the result rather than forcing `string | null`.
  return {
    name: trace.name,
    ...(trace.model !== undefined ? { model: trace.model } : {}),
    stepsShown,
    totalSteps,
    steps,
  };
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

// ---------- Rendering ------------------------------------------------------

/** Inline preview cap for step content rendering. */
const CONTENT_PREVIEW_LIMIT = 120;
/** Real ellipsis. Use this — never `...`. */
const ELLIPSIS = "…";

/**
 * Render a `HeadResult` as a human-friendly multi-line string. Used by the
 * CLI default output. Format:
 *
 *   <name> · <model | n/a>
 *   <stepsShown> of <totalSteps> steps
 *
 *   [1] user: hello there
 *   [2] assistant: looking that up · tools: search_kb, fetch_doc
 *
 * Content is truncated to `CONTENT_PREVIEW_LIMIT` chars with a real
 * ellipsis. Assistant tool-call names are listed inline; arguments are
 * omitted to keep the preview scannable — use `agentbench export` or
 * `agentbench replay` for full fidelity.
 */
export function formatHead(result: HeadResult): string {
  const lines: string[] = [];
  const modelLabel = result.model ?? "n/a";
  // Header — name first, model + step count on a second line. Sentence case,
  // numerics rendered as digits (tabular-nums kicks in in HTML; in a TTY
  // we just present plain digits and let the terminal do the alignment).
  lines.push(`${result.name} · ${modelLabel}`);
  lines.push(`${result.stepsShown} of ${result.totalSteps} steps`);
  lines.push("");

  if (result.stepsShown === 0) {
    lines.push("_(no steps shown)_");
    return `${lines.join("\n").replace(/\n+$/, "")}\n`;
  }

  for (let i = 0; i < result.steps.length; i++) {
    const step = result.steps[i];
    if (!step) continue;
    const index = i + 1;
    const preview = previewContent(step.content);
    if (step.kind === "user") {
      lines.push(`[${index}] user: ${preview}`);
      continue;
    }
    // Assistant. List tool call names inline — args are omitted on purpose
    // (use `export` / `replay` for full fidelity). When there are no tool
    // calls, just the content preview; no dangling " · tools: " suffix.
    if (step.toolCalls.length === 0) {
      lines.push(`[${index}] assistant: ${preview}`);
    } else {
      const names = step.toolCalls.map((c) => c.name).join(", ");
      lines.push(`[${index}] assistant: ${preview} · tools: ${names}`);
    }
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * Render a `HeadResult` as stable JSON for `--json`. Includes the metadata
 * AND the sliced `steps[]` so the consumer can pipe `… | jq .steps` without
 * a follow-up read.
 */
export function formatHeadJson(result: HeadResult): string {
  return `${JSON.stringify(
    {
      name: result.name,
      ...(result.model !== undefined ? { model: result.model } : {}),
      stepsShown: result.stepsShown,
      totalSteps: result.totalSteps,
      steps: result.steps,
    },
    null,
    2,
  )}\n`;
}

/**
 * Truncate step content to the preview limit. Multi-line content is
 * collapsed to a single line first (newlines → spaces) so the preview
 * always fits on one terminal row. Empty content surfaces as `(empty)` —
 * better than a trailing space that looks like a layout bug.
 */
function previewContent(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "(empty)";
  if (collapsed.length > CONTENT_PREVIEW_LIMIT) {
    return `${collapsed.slice(0, CONTENT_PREVIEW_LIMIT)}${ELLIPSIS}`;
  }
  return collapsed;
}
