import { realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { InvalidTraceError, replayTrace } from "./replay.js";

let workDir: string;

beforeEach(async () => {
  // macOS quirk: `mkdtemp(tmpdir())` returns a `/var/folders/...` path that
  // is actually a symlink to `/private/var/...`. Without `realpathSync`,
  // path-equality assertions break on the macOS CI matrix. Same trap the
  // other test files hit.
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-replay-")));
});

/** Collect NDJSON output from `replayTrace` into a string for assertions. */
class CollectStream extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error) => void): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
  lines(): string[] {
    const t = this.text();
    if (t === "") return [];
    // NDJSON convention: no trailing blank line. Split on `\n` and drop
    // the empty tail produced by the final newline-terminated record.
    const parts = t.split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  }
}

async function writeTrace(name: string, body: unknown): Promise<string> {
  const full = path.join(workDir, name);
  await writeFile(full, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return full;
}

// A 5-step trace: user, assistant (with a tool call), user, assistant, user.
// Mixes kinds + tool calls so we can exercise the kind filter and the
// toolCalls-on-assistant-only shape.
const fiveStep = {
  name: "five-step",
  model: "claude-sonnet-4-6",
  steps: [
    { kind: "user", content: "hello" },
    {
      kind: "assistant",
      content: "looking",
      toolCalls: [
        { name: "search_kb", arguments: { q: "refund" }, result: "found", latencyMs: 12 },
      ],
    },
    { kind: "user", content: "more please" },
    { kind: "assistant", content: "here you go", toolCalls: [] },
    { kind: "user", content: "thanks" },
  ],
};

describe("replayTrace — happy path", () => {
  it("emits one JSON line per step, in order", async () => {
    const t = await writeTrace("t.json", fiveStep);
    const out = new CollectStream();

    const result = await replayTrace({ tracePath: t, out });

    expect(result.stepsEmitted).toBe(5);
    const lines = out.lines();
    expect(lines).toHaveLength(5);
    // Each line parses cleanly — this is the NDJSON contract.
    const events = lines.map((l) => JSON.parse(l));
    expect(events.map((e) => e.index)).toEqual([1, 2, 3, 4, 5]);
    expect(events.map((e) => e.kind)).toEqual(["user", "assistant", "user", "assistant", "user"]);
  });

  it("preserves toolCalls verbatim on assistant events", async () => {
    const t = await writeTrace("t.json", fiveStep);
    const out = new CollectStream();

    await replayTrace({ tracePath: t, out });

    const events = out.lines().map((l) => JSON.parse(l));
    expect(events[1].toolCalls).toHaveLength(1);
    expect(events[1].toolCalls[0]).toMatchObject({
      name: "search_kb",
      arguments: { q: "refund" },
      result: "found",
      latencyMs: 12,
    });
  });

  it("omits toolCalls on user events (they don't have any)", async () => {
    const t = await writeTrace("t.json", fiveStep);
    const out = new CollectStream();

    await replayTrace({ tracePath: t, out });

    const events = out.lines().map((l) => JSON.parse(l));
    // User events should not carry a `toolCalls` field at all — including
    // an empty array on every user step would just be noise on the pipe.
    expect(Object.hasOwn(events[0], "toolCalls")).toBe(false);
    expect(Object.hasOwn(events[2], "toolCalls")).toBe(false);
    // Assistants still have toolCalls, even when empty (shape consistency).
    expect(Object.hasOwn(events[3], "toolCalls")).toBe(true);
    expect(events[3].toolCalls).toEqual([]);
  });
});

describe("replayTrace — windowing (since/until)", () => {
  it("--since=3 skips the first two steps but keeps original indices", async () => {
    const t = await writeTrace("t.json", fiveStep);
    const out = new CollectStream();

    const result = await replayTrace({ tracePath: t, since: 3, out });

    expect(result.stepsEmitted).toBe(3);
    const events = out.lines().map((l) => JSON.parse(l));
    expect(events.map((e) => e.index)).toEqual([3, 4, 5]);
  });

  it("--until=2 stops after step 2", async () => {
    const t = await writeTrace("t.json", fiveStep);
    const out = new CollectStream();

    const result = await replayTrace({ tracePath: t, until: 2, out });

    expect(result.stepsEmitted).toBe(2);
    const events = out.lines().map((l) => JSON.parse(l));
    expect(events.map((e) => e.index)).toEqual([1, 2]);
  });

  it("--since + --until describes an inclusive window", async () => {
    const t = await writeTrace("t.json", fiveStep);
    const out = new CollectStream();

    const result = await replayTrace({ tracePath: t, since: 2, until: 4, out });

    expect(result.stepsEmitted).toBe(3);
    const events = out.lines().map((l) => JSON.parse(l));
    expect(events.map((e) => e.index)).toEqual([2, 3, 4]);
  });

  it("out-of-range window (since > total) emits zero lines and resolves", async () => {
    const t = await writeTrace("t.json", fiveStep);
    const out = new CollectStream();

    // since > total — empty window. Not an error: the whole point of
    // accepting a window is letting CI scripts ask for "steps 50..60"
    // without knowing the trace length up front.
    const result = await replayTrace({ tracePath: t, since: 50, until: 60, out });

    expect(result.stepsEmitted).toBe(0);
    expect(out.text()).toBe("");
  });
});

describe("replayTrace — kind filter", () => {
  it("kind=user emits only user steps", async () => {
    const t = await writeTrace("t.json", fiveStep);
    const out = new CollectStream();

    const result = await replayTrace({ tracePath: t, kind: "user", out });

    expect(result.stepsEmitted).toBe(3);
    const events = out.lines().map((l) => JSON.parse(l));
    expect(events.every((e) => e.kind === "user")).toBe(true);
    // Indices reflect the original positions in the source trace.
    expect(events.map((e) => e.index)).toEqual([1, 3, 5]);
  });

  it("kind=assistant emits only assistant steps", async () => {
    const t = await writeTrace("t.json", fiveStep);
    const out = new CollectStream();

    const result = await replayTrace({ tracePath: t, kind: "assistant", out });

    expect(result.stepsEmitted).toBe(2);
    const events = out.lines().map((l) => JSON.parse(l));
    expect(events.every((e) => e.kind === "assistant")).toBe(true);
    expect(events.map((e) => e.index)).toEqual([2, 4]);
  });
});

describe("replayTrace — error handling", () => {
  it("refuses to replay an invalid trace (missing steps)", async () => {
    const broken = await writeTrace("broken.json", { name: "broken" /* no steps */ });
    const out = new CollectStream();

    await expect(replayTrace({ tracePath: broken, out })).rejects.toBeInstanceOf(InvalidTraceError);
    // Nothing emitted on the failure path.
    expect(out.text()).toBe("");
  });

  it("emits a clear error when the trace file does not exist", async () => {
    const missing = path.join(workDir, "does-not-exist.json");
    const out = new CollectStream();

    await expect(replayTrace({ tracePath: missing, out })).rejects.toThrow(/could not read trace/);
  });

  it("emits a clear error on malformed JSON", async () => {
    const broken = path.join(workDir, "broken.json");
    await writeFile(broken, "{ not valid json", "utf8");
    const out = new CollectStream();

    await expect(replayTrace({ tracePath: broken, out })).rejects.toThrow(/not valid JSON/);
  });
});

describe("replayTrace — wire-format hygiene", () => {
  it("output is parseable as NDJSON — each line is a complete JSON object", async () => {
    const t = await writeTrace("t.json", fiveStep);
    const out = new CollectStream();

    await replayTrace({ tracePath: t, out });

    // Every line round-trips through JSON.parse without throwing — the
    // contract a downstream `jq -c .` consumer relies on.
    const lines = out.lines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("no trailing blank line — exactly one `\\n` per record", async () => {
    const t = await writeTrace("t.json", fiveStep);
    const out = new CollectStream();

    await replayTrace({ tracePath: t, out });

    const text = out.text();
    // Ends with a single newline (terminating the last record), not two.
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    // Newline count equals record count.
    const newlines = text.split("\n").length - 1;
    expect(newlines).toBe(5);
  });

  it("handles an empty trace cleanly — zero lines, no error", async () => {
    const empty = await writeTrace("empty.json", { name: "empty", steps: [] });
    const out = new CollectStream();

    const result = await replayTrace({ tracePath: empty, out });

    expect(result.stepsEmitted).toBe(0);
    expect(out.text()).toBe("");
  });
});
