/**
 * `agentbench watch <trace>` — follow a trace file being appended live, like
 * `tail -f` for `.agentbench` JSON files.
 *
 * When you're recording a long-running agent session (a CrewAI multi-agent
 * workflow, a LangGraph loop, an OpenAI Agents SDK run), you want to see
 * what the agent is doing *now*, not wait until the run finishes and
 * `cat trace.json`. `watch` is the live streamer: open the trace, print
 * existing steps, then poll for changes and print new steps as they land.
 * Same NDJSON wire format as `replay` so output is pipe-compatible.
 *
 * Note: an `.agentbench` file is JSON (not JSONL), so this isn't a simple
 * line-tail. Strategy: re-parse the whole file on each fs event and emit
 * only the steps that weren't emitted before. Cheap — these files are KB,
 * not GB — and robust against partial writes (a half-written file fails
 * `JSON.parse` and we just wait for the next event).
 *
 * Behaviour:
 *
 *   - Initial pass reads + schema-validates the trace and (if `fromStart`)
 *     emits every step it finds.
 *   - `fs.watch` subscribes for change events; on each event we re-read
 *     and re-validate. If the step count grew, emit only the new tail. If
 *     the file shrank or was rotated (new content shorter than what we've
 *     already emitted), restart — emit everything from the new beginning.
 *   - Malformed JSON mid-write is *not* an error — the writer may have
 *     flushed half a step. Swallow, wait for the next event, try again.
 *   - Returns `{ stop }` for cleanup. Tests use it; the CLI wires SIGINT.
 *
 * Same NDJSON event shape as `replay`:
 *
 *   {"index": 1, "kind": "user", "content": "…"}
 *   {"index": 2, "kind": "assistant", "content": "…", "toolCalls": [...]}
 */
import { type FSWatcher, watch as fsWatch } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolCall, TraceStep } from "./trace.js";
import { TraceSchema } from "./trace.js";

export interface WatchEvent {
  /** 1-based step position in the source trace. */
  index: number;
  /** Step kind, mirroring `TraceStep.kind`. */
  kind: "user" | "assistant";
  /** Step content. Always present, may be empty for tool-only assistants. */
  content: string;
  /** Tool calls — present on assistant steps only. */
  toolCalls?: ToolCall[];
}

export interface WatchOptions {
  /** Path to the trace file to follow. */
  tracePath: string;
  /**
   * If `true` (the default), emit every step already in the file when
   * `watchTrace` is first called. If `false`, skip the initial content and
   * emit only steps that land *after* the watch starts — useful when the
   * caller is tailing a long-running run and already has the prefix.
   */
  fromStart?: boolean;
  /**
   * If `true` (the default), keep watching the file via `fs.watch` after
   * the initial drain. If `false`, drain once and resolve — useful for
   * "just give me the current state and exit" callers.
   */
  follow?: boolean;
  /**
   * Per-step emit callback. Called once per new step in source order.
   * Errors thrown by `onStep` propagate out of `watchTrace` (initial
   * drain) but are swallowed during `follow` to keep the watcher alive —
   * one bad downstream consumer shouldn't tear down the whole stream.
   */
  onStep?: (event: WatchEvent) => void;
}

export interface WatchHandle {
  /**
   * Stop following and close the underlying `fs.watch` handle. Safe to call
   * more than once. Idempotent. Always sync — there's no async work to
   * unwind.
   */
  stop: () => void;
}

/** Thrown when the initial trace read parses but isn't a valid Trace. */
export class InvalidTraceError extends Error {
  constructor(tracePath: string, summary: string) {
    super(
      `refusing to watch an invalid trace: ${tracePath}\n  ${summary}\n  emitting half-rendered steps from a broken trace would just produce confusing output downstream — fix the file (or re-record) before watching`,
    );
    this.name = "InvalidTraceError";
  }
}

/**
 * Start watching a trace file. Returns a `{ stop }` handle for cleanup.
 *
 * Order of operations:
 *
 *   1. Read + validate the initial file. If it's invalid up front, throw
 *      `InvalidTraceError` — same posture as `replay` / `head` / `export`.
 *      Once we're past the initial drain, validation failures are silent
 *      (the writer may be mid-flush), and we'll retry on the next event.
 *   2. If `fromStart` (default), emit every existing step via `onStep`. If
 *      not, just remember the current step count as our "already emitted"
 *      cursor so we skip the prefix.
 *   3. If `follow` (default), subscribe via `fs.watch`. On each event,
 *      re-read + re-validate. If the new step count is greater, emit only
 *      the tail (`steps[emitted .. new.length]`). If the new count is less
 *      (truncation / rotation), reset the cursor to 0 and emit everything
 *      from the new beginning.
 *   4. Return `{ stop }`. Stopping closes the watcher; the initial drain is
 *      already complete and can't be unwound.
 */
export async function watchTrace(options: WatchOptions): Promise<WatchHandle> {
  const tracePath = path.resolve(options.tracePath);
  const fromStart = options.fromStart ?? true;
  const follow = options.follow ?? true;
  const onStep = options.onStep ?? (() => {});

  // 1. Initial read + validate. Strict here — if the caller pointed us at
  //    a broken file we want to fail loudly, not silently retry forever.
  //    The "swallow malformed mid-write" policy only kicks in on follow-up
  //    events, where the writer is presumed to be live.
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
  const validation = TraceSchema.safeParse(parsed);
  if (!validation.success) {
    throw new InvalidTraceError(tracePath, summariseZodIssues(validation.error.issues));
  }
  const initial = validation.data;

  // 2. Cursor — how many steps we've already emitted. If `fromStart`,
  //    we'll emit the initial batch below and then bump the cursor. If
  //    not, we just remember the prefix length so the first follow-up
  //    re-read knows where the "new" steps start.
  let emitted = 0;
  if (fromStart) {
    for (let i = 0; i < initial.steps.length; i++) {
      const step = initial.steps[i];
      if (!step) continue;
      onStep(toEvent(i + 1, step));
    }
    emitted = initial.steps.length;
  } else {
    emitted = initial.steps.length;
  }

  // 3. Follow or bail out. `follow=false` is the "drain once and exit"
  //    mode — the CLI exposes this as `--no-follow`. The handle still
  //    works (calling `.stop()` is a no-op), so the caller doesn't have
  //    to branch on it.
  if (!follow) {
    return { stop: () => {} };
  }

  let watcher: FSWatcher | undefined;
  let stopped = false;
  // Re-read serialisation: `fs.watch` can fire several events in quick
  // succession (one for the inode change, one for the size change, etc.).
  // If we kick off a re-read on each, we can end up double-emitting when
  // the second read finishes before the first one has updated `emitted`.
  // Track an in-flight flag and a pending bit; if a new event lands while
  // we're already reading, just remember to read again afterwards.
  let inFlight = false;
  let pending = false;

  const reread = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      let nextRaw: string;
      try {
        nextRaw = await readFile(tracePath, "utf8");
      } catch {
        // File vanished or unreadable — could be a rotation in progress.
        // Don't tear down the watcher; the next event will tell us if
        // it's permanent or transient.
        return;
      }
      let nextParsed: unknown;
      try {
        nextParsed = JSON.parse(nextRaw);
      } catch {
        // Half-written JSON (the writer is mid-flush). Documented trap —
        // swallow, retry on the next event. Same posture mcp-devtools'
        // `.mcptrace` tail uses for partial writes.
        return;
      }
      const nextValidation = TraceSchema.safeParse(nextParsed);
      if (!nextValidation.success) {
        // Parsed JSON but doesn't fit the Trace shape — could be a writer
        // that's serialising a partial object. Same posture as malformed:
        // swallow and retry. We already strict-validated the initial read,
        // so this shouldn't be a sustained state.
        return;
      }
      const next = nextValidation.data;
      const total = next.steps.length;

      if (total < emitted) {
        // File shrank or was rotated. Treat as a fresh start — reset the
        // cursor and emit everything from the new beginning.
        emitted = 0;
      }

      // Emit the new tail. `emitted` is the count we've already written
      // out, so `steps[emitted]` is the first un-emitted step (0-based
      // array index = 1-based step index minus 1).
      for (let i = emitted; i < total; i++) {
        if (stopped) return;
        const step = next.steps[i];
        if (!step) continue;
        try {
          onStep(toEvent(i + 1, step));
        } catch {
          // Don't let a downstream consumer's throw kill the watcher.
          // The initial drain already ran `onStep` synchronously, so any
          // caller that wants to fail fast can throw there.
        }
      }
      emitted = total;
    } finally {
      inFlight = false;
      if (pending && !stopped) {
        pending = false;
        // Schedule the follow-up read on the next tick so we don't
        // unbounded-recurse if events keep landing during the read.
        setImmediate(() => {
          void reread();
        });
      }
    }
  };

  try {
    watcher = fsWatch(tracePath, { persistent: true }, () => {
      void reread();
    });
  } catch (err) {
    throw new Error(`could not watch trace ${tracePath}: ${(err as Error).message}`);
  }

  // Some platforms (macOS FSEvents in particular) coalesce events such
  // that a write right after `fs.watch` subscribes can be missed. The
  // watcher's `change` callback is also fired for the file's metadata
  // updates, not the contents — handle errors there too.
  watcher.on("error", () => {
    // Filesystem errors (unlinked file, permission flip) shouldn't tear
    // down the watcher — just log and let the next event retry. We have
    // no logger here on purpose; the CLI layer can wrap if needed.
  });

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // Already closed or never opened — fine.
        }
      }
    },
  };
}

/**
 * Convert a `TraceStep` to its wire-format `WatchEvent`. Same shape as
 * `replay`'s `ReplayEvent` so output is pipe-compatible: a consumer can
 * `agentbench watch x.json | jq .` exactly the way they would `replay`.
 */
function toEvent(index: number, step: TraceStep): WatchEvent {
  if (step.kind === "user") {
    return { index, kind: "user", content: step.content };
  }
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
