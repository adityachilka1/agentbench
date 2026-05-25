/**
 * `agentbench replay <trace>` — stream a recorded trace step-by-step over
 * stdout as JSON Lines (NDJSON).
 *
 * Most agentbench subcommands consume or transform a whole trace. `replay`
 * is the *emitter*: it walks the trace one step at a time and prints each
 * step as a single JSON object on its own line. That makes traces trivially
 * pipe-able into anything that already speaks NDJSON — `jq`, log
 * aggregators, a test-runner that scrubs assertions out of agent output,
 * `grep`, `awk`, you name it.
 *
 * Wire format — one JSON object per line, no trailing blank line:
 *
 *   {"index": 1, "kind": "user", "content": "…"}
 *   {"index": 2, "kind": "assistant", "content": "…", "toolCalls": [...]}
 *
 * `index` is the 1-based step position in the *source* trace, so a `since`
 * window still tells the consumer which step they're seeing. `toolCalls`
 * is omitted on user steps (they don't have any) and present on every
 * assistant step (even when empty — clients can rely on the shape).
 *
 * Behaviour:
 *
 *   - Reads + schema-validates the trace via `TraceSchema`. Refuses on
 *     invalid input the same way `export` / `bless` / `merge` do — emitting
 *     half-rendered "steps" from a broken trace would be worse than no
 *     output at all.
 *   - `since` / `until` are 1-based inclusive step bounds. An out-of-range
 *     window (`since > total`) is *not* an error — empty output, exit 0,
 *     so a CI script can ask for "steps 50–60" without knowing the trace
 *     length in advance.
 *   - `kind` filters to a single step kind (`"user"` or `"assistant"`).
 *     Skipped steps still have their original `index` preserved on the
 *     emitted neighbours.
 *   - Output goes to `out` (default `process.stdout`) — never stderr.
 *     `log.info` chatter (if any) is reserved for stderr so the user can
 *     pipe stdout into `jq` cleanly.
 *   - NDJSON convention: no trailing blank line. Each line is a complete
 *     JSON object terminated by exactly one `\n`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import type { ToolCall, TraceStep } from "./trace.js";
import { TraceSchema } from "./trace.js";

export interface ReplayOptions {
  /** Path to the trace file to read. */
  tracePath: string;
  /**
   * 1-based inclusive lower bound on step index. Steps before this index
   * are skipped. Omit to start at the first step. Non-positive values are
   * treated as 1 (the caller asked for "from the start").
   */
  since?: number;
  /**
   * 1-based inclusive upper bound on step index. Steps after this index
   * are skipped. Omit to stream to the end.
   */
  until?: number;
  /**
   * Filter to a single step kind. Omit to emit both. Anything other than
   * `"user"` / `"assistant"` is rejected by the CLI layer before we get
   * here, so the runtime type is narrow.
   */
  kind?: "user" | "assistant";
  /**
   * Where to write the NDJSON. Defaults to `process.stdout`. Tests inject
   * an in-memory writable so we can assert the exact bytes without
   * shelling out.
   */
  out?: Writable;
}

export interface ReplayResult {
  /** How many steps actually made it to the output stream. */
  stepsEmitted: number;
}

/** Shape of a single NDJSON event emitted by `replay`. */
export interface ReplayEvent {
  /** 1-based step position in the source trace. */
  index: number;
  /** Step kind, mirroring `TraceStep.kind`. */
  kind: "user" | "assistant";
  /** Step content. Always present, may be empty for tool-only assistants. */
  content: string;
  /** Tool calls — present on assistant steps only. */
  toolCalls?: ToolCall[];
}

/** Thrown when the trace JSON parses but isn't a valid Trace. */
export class InvalidTraceError extends Error {
  constructor(tracePath: string, summary: string) {
    super(
      `refusing to replay an invalid trace: ${tracePath}\n  ${summary}\n  emitting half-rendered steps from a broken trace would just produce confusing output downstream`,
    );
    this.name = "InvalidTraceError";
  }
}

/**
 * Stream the steps of a trace file as NDJSON. See {@link ReplayOptions}.
 *
 * Order of operations:
 *
 *   1. Read the trace file. Surface a clear error on ENOENT / permission
 *      failures — we never want a generic "ENOENT: …" leaking through the
 *      consumer's pipe.
 *   2. JSON-parse + schema-validate. Refuse on invalid the same way every
 *      other agentbench subcommand that *consumes* a trace does.
 *   3. Walk steps. For each step in range and matching the kind filter,
 *      serialise as `ReplayEvent`, write `JSON.stringify(event) + "\n"`.
 *   4. Return a count. Useful for callers that want to assert without
 *      capturing the stream.
 *
 * The `out` writable is *not* closed at the end — `process.stdout` outlives
 * a single `replay` call (the CLI exits the process itself), and tests
 * that pass a fresh writable will close it themselves.
 */
export async function replayTrace(options: ReplayOptions): Promise<ReplayResult> {
  const tracePath = path.resolve(options.tracePath);
  const out: Writable = options.out ?? process.stdout;

  // 1. Read. Be explicit about which file we couldn't reach — the
  //    downstream consumer may have no other signal.
  let raw: string;
  try {
    raw = await readFile(tracePath, "utf8");
  } catch (err) {
    throw new Error(`could not read trace ${tracePath}: ${(err as Error).message}`);
  }

  // 2. Parse + validate. Same posture as `export` — refuse to emit
  //    anything if the source isn't a real trace.
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

  // 3. Resolve window. `since`/`until` are 1-based inclusive. Clamp `since`
  //    up to 1 so a stray `--since 0` doesn't underflow. An empty window
  //    (since > until, or since > total) is intentional: return 0 lines,
  //    exit 0. The whole point of accepting a window is letting CI scripts
  //    ask for "steps 50..60" without knowing the trace length up front.
  const total = trace.steps.length;
  const sinceRaw = options.since;
  const untilRaw = options.until;
  const since = sinceRaw === undefined ? 1 : Math.max(1, Math.floor(sinceRaw));
  const until = untilRaw === undefined ? total : Math.min(total, Math.floor(untilRaw));

  let stepsEmitted = 0;
  // Iterate by 1-based index for readability — matches the wire format.
  for (let i = since; i <= until; i++) {
    const step = trace.steps[i - 1];
    if (!step) continue;
    if (options.kind && step.kind !== options.kind) continue;
    const event = toEvent(i, step);
    out.write(`${JSON.stringify(event)}\n`);
    stepsEmitted++;
  }

  return { stepsEmitted };
}

/**
 * Convert a `TraceStep` to its wire-format `ReplayEvent`. `toolCalls` is
 * only present on assistant steps — user steps don't have them, and
 * including an empty array on every user step would just be noise on the
 * pipe.
 */
function toEvent(index: number, step: TraceStep): ReplayEvent {
  if (step.kind === "user") {
    return { index, kind: "user", content: step.content };
  }
  // Assistant. Always include `toolCalls` — even when empty — so consumers
  // can rely on the field being present rather than `?.length ?? 0`-ing it.
  return {
    index,
    kind: "assistant",
    content: step.content,
    toolCalls: step.toolCalls,
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
