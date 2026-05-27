import { realpathSync } from "node:fs";
import { mkdtemp, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { InvalidTraceError, type WatchEvent, type WatchHandle, watchTrace } from "./watch.js";

let workDir: string;

beforeEach(async () => {
  // macOS quirk: `mkdtemp(tmpdir())` returns a `/var/folders/...` path that
  // is actually a symlink to `/private/var/...`. Without `realpathSync`,
  // `fs.watch` subscribes against one inode and writes hit the other, so
  // events never arrive in CI. Documented trap from mcp-devtools#61 — the
  // same pattern the rest of the suite uses.
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-watch-")));
});

/**
 * Wait until `predicate()` returns true, polling every `step` ms up to
 * `timeoutMs`. Used to bridge the gap between an append and the `fs.watch`
 * event landing in our re-read — there's no exposed "drained" signal.
 */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 2000, step = 10 }: { timeoutMs?: number; step?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(step);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function writeTrace(name: string, body: unknown): Promise<string> {
  const full = path.join(workDir, name);
  await writeFile(full, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return full;
}

const threeStep = {
  name: "three-step",
  model: "claude-sonnet-4-6",
  steps: [
    { kind: "user", content: "hello" },
    { kind: "assistant", content: "hi there", toolCalls: [] },
    { kind: "user", content: "thanks" },
  ],
};

describe("watchTrace — initial drain", () => {
  it("emits every existing step when fromStart=true (default) and follow=false", async () => {
    const t = await writeTrace("t.json", threeStep);
    const events: WatchEvent[] = [];

    const handle = await watchTrace({
      tracePath: t,
      follow: false,
      onStep: (e) => events.push(e),
    });

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.kind)).toEqual(["user", "assistant", "user"]);
    handle.stop();
  });

  it("skips the existing prefix when fromStart=false", async () => {
    const t = await writeTrace("t.json", threeStep);
    const events: WatchEvent[] = [];

    const handle = await watchTrace({
      tracePath: t,
      fromStart: false,
      follow: false,
      onStep: (e) => events.push(e),
    });

    // Initial 3 steps are skipped — `fromStart=false` is "tail-from-now".
    expect(events).toHaveLength(0);
    handle.stop();
  });

  it("preserves toolCalls on assistant events during the initial drain", async () => {
    const trace = {
      name: "tool",
      steps: [
        {
          kind: "assistant",
          content: "looking",
          toolCalls: [{ name: "search_kb", arguments: { q: "x" }, result: "ok", latencyMs: 7 }],
        },
      ],
    };
    const t = await writeTrace("t.json", trace);
    const events: WatchEvent[] = [];

    const handle = await watchTrace({
      tracePath: t,
      follow: false,
      onStep: (e) => events.push(e),
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("assistant");
    expect(events[0]?.toolCalls).toHaveLength(1);
    expect(events[0]?.toolCalls?.[0]).toMatchObject({
      name: "search_kb",
      arguments: { q: "x" },
      result: "ok",
      latencyMs: 7,
    });
    handle.stop();
  });
});

describe("watchTrace — following live appends", () => {
  it("emits new steps when the trace grows by one", async () => {
    const t = await writeTrace("t.json", threeStep);
    const events: WatchEvent[] = [];

    const handle = await watchTrace({
      tracePath: t,
      onStep: (e) => events.push(e),
    });

    // macOS FSEvents subscribe delay — without this sleep the first
    // append after `watchTrace` resolves can race past the subscription
    // and never trigger a `change` event. Documented trap from
    // mcp-devtools#61's `.mcptrace` tail.
    await sleep(80);

    // Initial 3 already drained.
    expect(events).toHaveLength(3);

    // Append a 4th step by rewriting the file with one more entry.
    const grown = {
      ...threeStep,
      steps: [...threeStep.steps, { kind: "assistant", content: "you're welcome", toolCalls: [] }],
    };
    await writeFile(path.join(workDir, "t.json"), JSON.stringify(grown, null, 2), "utf8");

    await waitFor(() => events.length >= 4);

    expect(events).toHaveLength(4);
    expect(events[3]?.index).toBe(4);
    expect(events[3]?.kind).toBe("assistant");
    expect(events[3]?.content).toBe("you're welcome");
    handle.stop();
  });

  it("emits both new steps when the file grows by two in one fs event", async () => {
    const t = await writeTrace("t.json", threeStep);
    const events: WatchEvent[] = [];

    const handle = await watchTrace({
      tracePath: t,
      onStep: (e) => events.push(e),
    });

    await sleep(80);
    expect(events).toHaveLength(3);

    const grown = {
      ...threeStep,
      steps: [
        ...threeStep.steps,
        { kind: "assistant", content: "step 4", toolCalls: [] },
        { kind: "user", content: "step 5" },
      ],
    };
    await writeFile(path.join(workDir, "t.json"), JSON.stringify(grown, null, 2), "utf8");

    await waitFor(() => events.length >= 5);

    expect(events).toHaveLength(5);
    expect(events.map((e) => e.index)).toEqual([1, 2, 3, 4, 5]);
    expect(events[3]?.content).toBe("step 4");
    expect(events[4]?.content).toBe("step 5");
    handle.stop();
  });

  it("restarts emission from the beginning when the file is truncated", async () => {
    const t = await writeTrace("t.json", threeStep);
    const events: WatchEvent[] = [];

    const handle = await watchTrace({
      tracePath: t,
      onStep: (e) => events.push(e),
    });

    await sleep(80);
    expect(events).toHaveLength(3);

    // Truncate to a fresh single-step trace — the cursor should reset and
    // we should see the new step 1 emitted as index 1.
    const fresh = {
      name: "fresh",
      steps: [{ kind: "user", content: "started over" }],
    };
    // Truncate first to make the shrink unambiguous, then write the new
    // content. Some filesystems coalesce these into a single fs.watch
    // event, which is exactly the path we want to exercise.
    await truncate(path.join(workDir, "t.json"), 0);
    await writeFile(path.join(workDir, "t.json"), JSON.stringify(fresh, null, 2), "utf8");

    await waitFor(() => events.length >= 4);

    // 3 initial + 1 from the restart. The restart step should carry index 1.
    expect(events).toHaveLength(4);
    expect(events[3]?.index).toBe(1);
    expect(events[3]?.content).toBe("started over");
    handle.stop();
  });

  it("swallows a malformed mid-write and recovers on the next event", async () => {
    const t = await writeTrace("t.json", threeStep);
    const events: WatchEvent[] = [];
    const initialErrors: unknown[] = [];

    const handle = await watchTrace({
      tracePath: t,
      onStep: (e) => events.push(e),
    });

    await sleep(80);
    expect(events).toHaveLength(3);

    // Write a deliberately half-written JSON file — what an in-progress
    // writer would leave on disk between flushes. The watcher should
    // *not* throw; it should silently retry on the next event.
    await writeFile(path.join(workDir, "t.json"), '{ "name": "broken", "steps": [', "utf8");

    // Give the watcher a tick to attempt the re-read and fail.
    await sleep(120);
    expect(initialErrors).toHaveLength(0);
    expect(events).toHaveLength(3); // still 3 — broken read didn't emit.

    // Now write a recovered file with a 4th step.
    const recovered = {
      ...threeStep,
      steps: [...threeStep.steps, { kind: "user", content: "recovered" }],
    };
    await writeFile(path.join(workDir, "t.json"), JSON.stringify(recovered, null, 2), "utf8");

    await waitFor(() => events.length >= 4);

    expect(events).toHaveLength(4);
    expect(events[3]?.content).toBe("recovered");
    handle.stop();
  });

  it("stop() cleans up the watcher — further appends don't emit", async () => {
    const t = await writeTrace("t.json", threeStep);
    const events: WatchEvent[] = [];

    const handle: WatchHandle = await watchTrace({
      tracePath: t,
      onStep: (e) => events.push(e),
    });

    await sleep(80);
    expect(events).toHaveLength(3);

    handle.stop();

    // Append after stopping — the listener is gone; no new emit should
    // happen even if the file changes.
    const grown = {
      ...threeStep,
      steps: [...threeStep.steps, { kind: "user", content: "after stop" }],
    };
    await writeFile(path.join(workDir, "t.json"), JSON.stringify(grown, null, 2), "utf8");

    // Give any in-flight handler a fair chance to fire. If `stop` works
    // we'll see exactly 3 events; if it doesn't we'll see 4.
    await sleep(150);
    expect(events).toHaveLength(3);

    // Double-stop is safe.
    expect(() => handle.stop()).not.toThrow();
  });
});

describe("watchTrace — error handling", () => {
  it("refuses to start on an invalid initial trace", async () => {
    const broken = await writeTrace("broken.json", { name: "broken" /* no steps */ });

    await expect(
      watchTrace({ tracePath: broken, follow: false, onStep: () => {} }),
    ).rejects.toBeInstanceOf(InvalidTraceError);
  });

  it("emits a clear error when the trace file does not exist", async () => {
    const missing = path.join(workDir, "does-not-exist.json");

    await expect(
      watchTrace({ tracePath: missing, follow: false, onStep: () => {} }),
    ).rejects.toThrow(/could not read trace/);
  });

  it("emits a clear error on malformed initial JSON", async () => {
    const broken = path.join(workDir, "broken.json");
    await writeFile(broken, "{ not valid json", "utf8");

    await expect(
      watchTrace({ tracePath: broken, follow: false, onStep: () => {} }),
    ).rejects.toThrow(/not valid JSON/);
  });
});
