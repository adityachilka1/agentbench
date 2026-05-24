import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { computeStats, formatStats, formatStatsJson, percentile } from "./stats.js";

let workDir: string;

beforeEach(async () => {
  // macOS quirk: `mkdtemp(tmpdir())` returns a `/var/folders/...` path that
  // is actually a symlink to `/private/var/...`. Without `realpathSync`,
  // path-equality assertions break on the macOS CI matrix.
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-stats-")));
});

async function writeTrace(name: string, body: unknown): Promise<string> {
  const full = path.join(workDir, name);
  await writeFile(full, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return full;
}

const TINY_TRACE = {
  name: "refund-policy",
  model: "claude-sonnet-4-6",
  steps: [
    { kind: "user", content: "What is your refund policy?" },
    {
      kind: "assistant",
      content: "Let me look that up.",
      toolCalls: [
        {
          name: "search_kb",
          arguments: { query: "refund policy" },
          result: "30-day money-back guarantee.",
          latencyMs: 42,
        },
      ],
    },
  ],
};

describe("computeStats — single file", () => {
  it("returns the basic shape for a single valid trace", async () => {
    const file = await writeTrace("trace.json", TINY_TRACE);
    const report = await computeStats(file);

    expect(report.path).toBe(file);
    expect(report.traceCount).toBe(1);
    expect(report.totalSteps).toBe(2);
    expect(report.userSteps).toBe(1);
    expect(report.assistantSteps).toBe(1);
    expect(report.modelBreakdown).toEqual({ "claude-sonnet-4-6": 1 });
    expect(report.toolBreakdown).toHaveLength(1);
    expect(report.toolBreakdown[0]?.name).toBe("search_kb");
    expect(report.toolBreakdown[0]?.count).toBe(1);
    expect(report.toolBreakdown[0]?.p50LatencyMs).toBe(42);
    expect(report.toolBreakdown[0]?.maxLatencyMs).toBe(42);
    expect(report.largestTrace?.path).toBe(file);
    expect(report.largestTrace?.steps).toBe(2);
    expect(report.byTraceName).toEqual([
      { name: "refund-policy", steps: 2, modelId: "claude-sonnet-4-6" },
    ]);
    expect(report.skipped).toEqual([]);
  });

  it("buckets traces with no `model` field under '(none)'", async () => {
    const file = await writeTrace("no-model.json", {
      name: "no-model",
      steps: [{ kind: "user", content: "hi" }],
    });
    const report = await computeStats(file);
    expect(report.modelBreakdown).toEqual({ "(none)": 1 });
    expect(report.byTraceName[0]?.modelId).toBeUndefined();
  });
});

describe("computeStats — directory recursion", () => {
  it("walks subdirectories and aggregates every trace", async () => {
    await writeTrace("a.json", {
      name: "a",
      model: "m1",
      steps: [
        { kind: "user", content: "a1" },
        { kind: "assistant", content: "a2", toolCalls: [] },
      ],
    });
    const subDir = path.join(workDir, "nested");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      path.join(subDir, "b.json"),
      JSON.stringify({
        name: "b",
        model: "m2",
        steps: [{ kind: "user", content: "b1" }],
      }),
      "utf8",
    );

    const report = await computeStats(workDir);
    expect(report.traceCount).toBe(2);
    expect(report.totalSteps).toBe(3);
    expect(report.userSteps).toBe(2);
    expect(report.assistantSteps).toBe(1);
    expect(report.modelBreakdown).toEqual({ m1: 1, m2: 1 });
    expect(report.byTraceName.map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  it("ignores `bench.json` and dot-files in directory mode", async () => {
    await writeTrace("trace.json", TINY_TRACE);
    await writeTrace("bench.json", { name: "bench-config", version: 1 });
    await writeTrace(".hidden.json", { name: "hidden", steps: [] });
    const report = await computeStats(workDir);
    expect(report.traceCount).toBe(1);
    expect(report.byTraceName[0]?.name).toBe("refund-policy");
  });
});

describe("computeStats — error handling", () => {
  it("skips invalid traces and counts the valid ones", async () => {
    await writeTrace("good.json", TINY_TRACE);
    await writeTrace("malformed.json", "{ not valid json");
    await writeTrace("wrong-shape.json", { hello: "world" });

    const report = await computeStats(workDir);
    expect(report.traceCount).toBe(1);
    expect(report.skipped).toHaveLength(2);
    const reasons = report.skipped.map((s) => s.reason).sort();
    expect(reasons[0]).toMatch(/^malformed JSON/);
    expect(reasons[1]).toMatch(/^schema/);
  });

  it("throws on a missing path (whole run can't proceed)", async () => {
    await expect(computeStats(path.join(workDir, "does-not-exist"))).rejects.toThrow(
      /path does not exist/,
    );
  });

  it("returns an empty report for an empty directory", async () => {
    const report = await computeStats(workDir);
    expect(report.traceCount).toBe(0);
    expect(report.totalSteps).toBe(0);
    expect(report.modelBreakdown).toEqual({});
    expect(report.toolBreakdown).toEqual([]);
    expect(report.largestTrace).toBeUndefined();
    expect(report.byTraceName).toEqual([]);
  });
});

describe("computeStats — per-tool stats", () => {
  it("computes p50 / p95 / max correctly across many latency samples", async () => {
    // Latencies 10..200 in steps of 10 → twenty samples; sorted is the
    // same. Nearest-rank: p50 → ceil(0.5*20)-1 = 9 → 100; p95 → ceil(0.95*20)-1 = 18 → 190.
    const latencies = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    await writeTrace("lat.json", {
      name: "lat",
      steps: [
        {
          kind: "assistant",
          content: "",
          toolCalls: latencies.map((ms) => ({
            name: "search",
            arguments: {},
            latencyMs: ms,
          })),
        },
      ],
    });
    const report = await computeStats(workDir);
    const tool = report.toolBreakdown.find((t) => t.name === "search");
    expect(tool).toBeDefined();
    expect(tool?.count).toBe(20);
    expect(tool?.p50LatencyMs).toBe(100);
    expect(tool?.p95LatencyMs).toBe(190);
    expect(tool?.maxLatencyMs).toBe(200);
  });

  it("merges tool stats across multiple traces and counts calls", async () => {
    await writeTrace("t1.json", {
      name: "t1",
      steps: [
        {
          kind: "assistant",
          content: "",
          toolCalls: [
            { name: "search", arguments: { q: "x" }, latencyMs: 100 },
            { name: "fetch", arguments: { url: "a" }, latencyMs: 50 },
          ],
        },
      ],
    });
    await writeTrace("t2.json", {
      name: "t2",
      steps: [
        {
          kind: "assistant",
          content: "",
          toolCalls: [
            { name: "search", arguments: { q: "y" }, latencyMs: 200 },
            { name: "search", arguments: { q: "z" }, latencyMs: 300 },
          ],
        },
      ],
    });
    const report = await computeStats(workDir);
    const search = report.toolBreakdown.find((t) => t.name === "search");
    const fetchTool = report.toolBreakdown.find((t) => t.name === "fetch");
    expect(search?.count).toBe(3);
    expect(search?.maxLatencyMs).toBe(300);
    expect(fetchTool?.count).toBe(1);
    expect(fetchTool?.maxLatencyMs).toBe(50);
    // Order: search (3 calls) before fetch (1 call).
    expect(report.toolBreakdown[0]?.name).toBe("search");
  });

  it("omits latency fields when no call recorded a latencyMs", async () => {
    await writeTrace("no-lat.json", {
      name: "no-lat",
      steps: [
        {
          kind: "assistant",
          content: "",
          toolCalls: [{ name: "ping", arguments: {} }],
        },
      ],
    });
    const report = await computeStats(workDir);
    const tool = report.toolBreakdown.find((t) => t.name === "ping");
    expect(tool?.p50LatencyMs).toBeUndefined();
    expect(tool?.p95LatencyMs).toBeUndefined();
    expect(tool?.maxLatencyMs).toBeUndefined();
    // Empty {} args serialise to 2 bytes.
    expect(tool?.avgArgumentsBytes).toBe(2);
  });

  it("respects the top-N cap on toolBreakdown", async () => {
    // Three tools with descending call counts: a×3, b×2, c×1.
    await writeTrace("multi.json", {
      name: "multi",
      steps: [
        {
          kind: "assistant",
          content: "",
          toolCalls: [
            { name: "a", arguments: {} },
            { name: "a", arguments: {} },
            { name: "a", arguments: {} },
            { name: "b", arguments: {} },
            { name: "b", arguments: {} },
            { name: "c", arguments: {} },
          ],
        },
      ],
    });
    const report = await computeStats(workDir, { top: 2 });
    expect(report.toolBreakdown).toHaveLength(2);
    expect(report.toolBreakdown.map((t) => t.name)).toEqual(["a", "b"]);
  });
});

describe("computeStats — model + largest trace", () => {
  it("counts model occurrences across mixed traces", async () => {
    await writeTrace("a.json", {
      name: "a",
      model: "claude-sonnet-4-6",
      steps: [{ kind: "user", content: "x" }],
    });
    await writeTrace("b.json", {
      name: "b",
      model: "claude-sonnet-4-6",
      steps: [{ kind: "user", content: "y" }],
    });
    await writeTrace("c.json", {
      name: "c",
      model: "gpt-4o",
      steps: [{ kind: "user", content: "z" }],
    });
    const report = await computeStats(workDir);
    expect(report.modelBreakdown).toEqual({ "claude-sonnet-4-6": 2, "gpt-4o": 1 });
  });

  it("identifies the largest trace by byte size", async () => {
    await writeTrace("small.json", { name: "small", steps: [{ kind: "user", content: "hi" }] });
    // Bigger trace: 50 user steps with long content.
    const big = {
      name: "big",
      steps: Array.from({ length: 50 }, (_, i) => ({
        kind: "user" as const,
        content: `step ${i} ${"x".repeat(200)}`,
      })),
    };
    const bigPath = await writeTrace("big.json", big);
    const report = await computeStats(workDir);
    expect(report.largestTrace?.path).toBe(bigPath);
    expect(report.largestTrace?.steps).toBe(50);
    expect(report.largestTrace?.bytes).toBeGreaterThan(1000);
  });
});

describe("percentile — pure helper", () => {
  it("returns nearest-rank values without interpolation", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 100)).toBe(10);
  });

  it("collapses to the single available value for n=1", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("throws on an empty input", () => {
    expect(() => percentile([], 50)).toThrow(/empty/);
  });
});

describe("formatStats / formatStatsJson", () => {
  it("renders an Overview block, Models table, and Tools table with sentence-case headings", async () => {
    await writeTrace("t.json", TINY_TRACE);
    const report = await computeStats(workDir);
    const out = formatStats(report);
    expect(out).toContain("Overview");
    expect(out).toContain("Models");
    expect(out).toContain("Tools");
    expect(out).toContain("Largest trace");
    expect(out).toContain("Per-trace summary");
    expect(out).toContain("search_kb");
    // Sentence-case, not TitleCase Of The Whole Thing.
    expect(out).not.toContain("TOOLS");
    expect(out).not.toContain("MODELS");
  });

  it("renders machine-readable JSON with the documented shape", async () => {
    await writeTrace("t.json", TINY_TRACE);
    const report = await computeStats(workDir);
    const json = formatStatsJson(report);
    const parsed = JSON.parse(json);
    expect(parsed).toMatchObject({
      traceCount: 1,
      totalSteps: 2,
      userSteps: 1,
      assistantSteps: 1,
      modelBreakdown: { "claude-sonnet-4-6": 1 },
    });
    expect(parsed.toolBreakdown).toHaveLength(1);
    expect(parsed.toolBreakdown[0].name).toBe("search_kb");
    expect(json.endsWith("\n")).toBe(true);
  });

  it("reports skipped files in the human-readable output", async () => {
    await writeTrace("good.json", TINY_TRACE);
    await writeTrace("bad.json", "{ broken");
    const report = await computeStats(workDir);
    const out = formatStats(report);
    expect(out).toContain("Skipped files");
    expect(out).toContain("bad.json");
  });
});
