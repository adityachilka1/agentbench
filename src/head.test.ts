import { realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { InvalidTraceError, formatHead, formatHeadJson, headTrace } from "./head.js";

let workDir: string;

beforeEach(async () => {
  // macOS quirk: `mkdtemp(tmpdir())` returns a `/var/folders/...` path that
  // is actually a symlink to `/private/var/...`. Without `realpathSync`,
  // path-equality assertions break on the macOS CI matrix. Same trap the
  // other test files hit.
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-head-")));
});

async function writeTrace(name: string, body: unknown): Promise<string> {
  const full = path.join(workDir, name);
  await writeFile(full, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return full;
}

/** Build an N-step trace alternating user/assistant. Used by the size tests. */
function makeNStepTrace(n: number, opts: { name?: string; model?: string } = {}) {
  const steps: unknown[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      steps.push({ kind: "user", content: `user-${i + 1}` });
    } else {
      steps.push({ kind: "assistant", content: `assistant-${i + 1}`, toolCalls: [] });
    }
  }
  return {
    name: opts.name ?? `n-step-${n}`,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    steps,
  };
}

describe("headTrace — defaults and sizing", () => {
  it("default n=5 on a 10-step trace returns 5 shown, 10 total", async () => {
    const t = await writeTrace("ten.json", makeNStepTrace(10, { model: "claude-sonnet-4-6" }));

    const result = await headTrace({ tracePath: t });

    expect(result.stepsShown).toBe(5);
    expect(result.totalSteps).toBe(10);
    expect(result.steps).toHaveLength(5);
    expect(result.name).toBe("n-step-10");
    expect(result.model).toBe("claude-sonnet-4-6");
    // Order preserved — first five steps of the source, no shuffle.
    expect((result.steps[0] as { content: string }).content).toBe("user-1");
    expect((result.steps[4] as { content: string }).content).toBe("user-5");
  });

  it("explicit n=3 returns 3 shown out of 10", async () => {
    const t = await writeTrace("ten.json", makeNStepTrace(10));

    const result = await headTrace({ tracePath: t, n: 3 });

    expect(result.stepsShown).toBe(3);
    expect(result.totalSteps).toBe(10);
    expect(result.steps).toHaveLength(3);
  });

  it("n > totalSteps returns every step (no padding, no overshoot)", async () => {
    const t = await writeTrace("three.json", makeNStepTrace(3));

    const result = await headTrace({ tracePath: t, n: 99 });

    expect(result.stepsShown).toBe(3);
    expect(result.totalSteps).toBe(3);
    expect(result.steps).toHaveLength(3);
  });

  it("n=0 returns metadata only — zero steps shown, total preserved", async () => {
    const t = await writeTrace("ten.json", makeNStepTrace(10));

    const result = await headTrace({ tracePath: t, n: 0 });

    expect(result.stepsShown).toBe(0);
    expect(result.totalSteps).toBe(10);
    expect(result.steps).toEqual([]);
  });
});

describe("headTrace — input validation", () => {
  it("rejects a negative n with a clear error", async () => {
    const t = await writeTrace("ten.json", makeNStepTrace(10));

    await expect(headTrace({ tracePath: t, n: -1 })).rejects.toThrow(/non-negative integer/);
  });

  it("rejects a non-integer n", async () => {
    const t = await writeTrace("ten.json", makeNStepTrace(10));

    await expect(headTrace({ tracePath: t, n: 2.5 })).rejects.toThrow(/non-negative integer/);
  });

  it("refuses an invalid trace (missing steps) via InvalidTraceError", async () => {
    const broken = await writeTrace("broken.json", { name: "broken" /* no steps */ });

    await expect(headTrace({ tracePath: broken })).rejects.toBeInstanceOf(InvalidTraceError);
  });

  it("emits a clear error when the trace file does not exist", async () => {
    const missing = path.join(workDir, "does-not-exist.json");

    await expect(headTrace({ tracePath: missing })).rejects.toThrow(/could not read trace/);
  });

  it("emits a clear error on malformed JSON", async () => {
    const broken = path.join(workDir, "broken.json");
    await writeFile(broken, "{ not valid json", "utf8");

    await expect(headTrace({ tracePath: broken })).rejects.toThrow(/not valid JSON/);
  });
});

describe("headTrace — edge cases", () => {
  it("empty trace returns 0 shown, 0 total — no error", async () => {
    const empty = await writeTrace("empty.json", { name: "empty", steps: [] });

    const result = await headTrace({ tracePath: empty });

    expect(result.stepsShown).toBe(0);
    expect(result.totalSteps).toBe(0);
    expect(result.steps).toEqual([]);
    expect(result.name).toBe("empty");
  });

  it("preserves assistant toolCalls verbatim in the sliced window", async () => {
    const trace = {
      name: "with-tools",
      steps: [
        { kind: "user", content: "find it" },
        {
          kind: "assistant",
          content: "looking",
          toolCalls: [
            { name: "search_kb", arguments: { q: "refund" }, result: "found", latencyMs: 12 },
          ],
        },
        { kind: "user", content: "thanks" },
      ],
    };
    const t = await writeTrace("tools.json", trace);

    const result = await headTrace({ tracePath: t, n: 2 });

    expect(result.stepsShown).toBe(2);
    const second = result.steps[1] as {
      kind: "assistant";
      toolCalls: { name: string; arguments: Record<string, unknown>; latencyMs?: number }[];
    };
    expect(second.kind).toBe("assistant");
    expect(second.toolCalls).toHaveLength(1);
    expect(second.toolCalls[0]).toMatchObject({
      name: "search_kb",
      arguments: { q: "refund" },
      latencyMs: 12,
    });
  });

  it("omits `model` from the result when the source has none", async () => {
    const trace = {
      name: "no-model",
      // No `model` field — Trace.model is optional.
      steps: [{ kind: "user", content: "hi" }],
    };
    const t = await writeTrace("no-model.json", trace);

    const result = await headTrace({ tracePath: t });

    expect(result.name).toBe("no-model");
    expect(result.model).toBeUndefined();
    // The field shouldn't materialise on the object — undefined-vs-missing
    // matters for `JSON.stringify` consumers.
    expect(Object.hasOwn(result, "model")).toBe(false);
  });
});

describe("formatHead — human renderer", () => {
  it("renders a header line plus one bracketed line per step", async () => {
    const t = await writeTrace(
      "five.json",
      makeNStepTrace(5, { name: "preview", model: "claude-sonnet-4-6" }),
    );
    const result = await headTrace({ tracePath: t, n: 3 });

    const out = formatHead(result);

    expect(out).toContain("preview · claude-sonnet-4-6");
    expect(out).toContain("3 of 5 steps");
    // Bracketed indices, in order.
    expect(out).toContain("[1] user: user-1");
    expect(out).toContain("[2] assistant: assistant-2");
    expect(out).toContain("[3] user: user-3");
    // No fourth step rendered — the slice cap means it's not there.
    expect(out).not.toContain("[4]");
  });

  it("lists tool call names inline on assistant steps", async () => {
    const trace = {
      name: "tools",
      steps: [
        {
          kind: "assistant",
          content: "checking",
          toolCalls: [
            { name: "search_kb", arguments: {} },
            { name: "fetch_doc", arguments: {} },
          ],
        },
      ],
    };
    const t = await writeTrace("tools.json", trace);
    const result = await headTrace({ tracePath: t });

    const out = formatHead(result);

    expect(out).toMatch(/\[1\] assistant: checking · tools: search_kb, fetch_doc/);
  });

  it("truncates long content with a real ellipsis (U+2026, not three dots)", async () => {
    const long = "x".repeat(200);
    const trace = {
      name: "long",
      steps: [{ kind: "user", content: long }],
    };
    const t = await writeTrace("long.json", trace);
    const result = await headTrace({ tracePath: t });

    const out = formatHead(result);

    // Real U+2026, not ASCII "..."
    expect(out).toContain("…");
    expect(out).not.toContain("...");
  });

  it("renders model as `n/a` when the trace has no model", async () => {
    const trace = {
      name: "no-model",
      steps: [{ kind: "user", content: "hi" }],
    };
    const t = await writeTrace("no-model.json", trace);
    const result = await headTrace({ tracePath: t });

    const out = formatHead(result);

    expect(out).toContain("no-model · n/a");
  });
});

describe("formatHeadJson — machine renderer", () => {
  it("emits stable JSON with metadata + sliced steps + trailing newline", async () => {
    const t = await writeTrace("ten.json", makeNStepTrace(10, { model: "claude-sonnet-4-6" }));
    const result = await headTrace({ tracePath: t, n: 2 });

    const out = formatHeadJson(result);

    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.name).toBe("n-step-10");
    expect(parsed.model).toBe("claude-sonnet-4-6");
    expect(parsed.stepsShown).toBe(2);
    expect(parsed.totalSteps).toBe(10);
    expect(parsed.steps).toHaveLength(2);
  });
});
