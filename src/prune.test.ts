import { realpathSync } from "node:fs";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { pruneStaleBaselines } from "./prune.js";
import { type Trace, serializeTrace } from "./trace.js";

const baseTrace: Trace = {
  name: "refund-policy",
  model: "claude-sonnet-4-6",
  steps: [
    { kind: "user", content: "What is your refund policy?" },
    {
      kind: "assistant",
      content: "Let me look that up.",
      toolCalls: [{ name: "search_kb", arguments: { query: "refund policy" } }],
    },
    { kind: "user", content: "And in EUR?" },
    {
      kind: "assistant",
      content: "Same — 14 days, full refund.",
      toolCalls: [],
    },
  ],
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

let dir: string;

beforeEach(async () => {
  // macOS `/tmp` ↔ `/private/tmp` symlink trap — resolve through realpath so
  // the paths the pruner returns compare equal to what we wrote.
  dir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-prune-")));
});

async function writeTrace(name: string, trace: Trace): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, serializeTrace(trace));
  return p;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("pruneStaleBaselines", () => {
  it("dry-run: 1 current trace + 3 baselines (1 matched, 2 stale) → 1 kept, 2 prunable, 0 deleted", async () => {
    const current = await writeTrace("current.json", baseTrace);

    const drift1 = clone(baseTrace);
    drift1.steps = drift1.steps.slice(0, 2);
    const drift2 = clone(baseTrace);
    drift2.name = "different-scenario";
    drift2.steps = drift2.steps.slice(0, 1);

    const stale1 = await writeTrace("baseline-stale1.json", drift1);
    const stale2 = await writeTrace("baseline-stale2.json", drift2);
    const matched = await writeTrace("baseline-matched.json", baseTrace);

    const result = await pruneStaleBaselines({
      currentTraces: [current],
      baselineGlob: path.join(dir, "baseline-*.json"),
      dryRun: true,
    });

    expect(result.considered).toBe(3);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.path).toBe(matched);
    expect(result.kept[0]!.matchedBy).toBe(current);
    expect(result.prunable).toHaveLength(2);
    expect(result.prunable.map((p) => p.path).sort()).toEqual([stale1, stale2].sort());
    expect(result.deleted).toEqual([]);
    expect(result.dryRun).toBe(true);

    // All files still on disk in dry-run mode.
    expect(await exists(stale1)).toBe(true);
    expect(await exists(stale2)).toBe(true);
    expect(await exists(matched)).toBe(true);
  });

  it("dryRun:false actually deletes prunable baselines and reports bytesFreed > 0", async () => {
    const current = await writeTrace("current.json", baseTrace);
    const drift1 = clone(baseTrace);
    drift1.steps = drift1.steps.slice(0, 2);
    const drift2 = clone(baseTrace);
    drift2.steps = drift2.steps.slice(0, 1);
    const stale1 = await writeTrace("baseline-stale1.json", drift1);
    const stale2 = await writeTrace("baseline-stale2.json", drift2);
    const matched = await writeTrace("baseline-matched.json", baseTrace);

    const result = await pruneStaleBaselines({
      currentTraces: [current],
      baselineGlob: path.join(dir, "baseline-*.json"),
      dryRun: false,
    });

    expect(result.deleted.sort()).toEqual([stale1, stale2].sort());
    expect(result.bytesFreed).toBeGreaterThan(0);
    expect(result.dryRun).toBe(false);
    expect(await exists(stale1)).toBe(false);
    expect(await exists(stale2)).toBe(false);
    expect(await exists(matched)).toBe(true);
  });

  it("minDifferences allows fuzzy matches — a near-miss baseline is kept", async () => {
    const current = await writeTrace("current.json", baseTrace);
    const small = clone(baseTrace);
    if (small.steps[1].kind === "assistant") {
      // single difference: rename one tool call
      small.steps[1].toolCalls[0]!.name = "search_db";
    }
    // Big drift: 4 differences (step-count + 3 step-kind mismatches).
    const big = clone(baseTrace);
    big.steps = [
      { kind: "assistant", content: "hello", toolCalls: [] },
      { kind: "user", content: "world" },
      { kind: "assistant", content: "again", toolCalls: [] },
      { kind: "user", content: "and again" },
      { kind: "assistant", content: "done", toolCalls: [] },
    ];

    const smallPath = await writeTrace("baseline-small.json", small);
    const bigPath = await writeTrace("baseline-big.json", big);

    const result = await pruneStaleBaselines({
      currentTraces: [current],
      baselineGlob: path.join(dir, "baseline-*.json"),
      dryRun: true,
      minDifferences: 2,
    });

    // With minDifferences:2, the small-drift baseline (1 diff) is kept;
    // the big-drift baseline (3+ diffs) is prunable.
    expect(result.kept.map((k) => k.path)).toContain(smallPath);
    expect(result.prunable.map((p) => p.path)).toContain(bigPath);
  });

  it("multiple current traces — a baseline matched by *any* of them is kept", async () => {
    const currentA = await writeTrace("current-a.json", baseTrace);
    const otherScenario = clone(baseTrace);
    otherScenario.name = "billing-flow";
    otherScenario.steps = [
      { kind: "user", content: "Where is my invoice?" },
      { kind: "assistant", content: "Let me check.", toolCalls: [] },
    ];
    const currentB = await writeTrace("current-b.json", otherScenario);

    // baseline-a matches currentA, baseline-b matches currentB, baseline-c is stale.
    const stale = clone(baseTrace);
    stale.name = "ancient";
    stale.steps = [{ kind: "user", content: "obsolete" }];

    const aPath = await writeTrace("baseline-a.json", baseTrace);
    const bPath = await writeTrace("baseline-b.json", otherScenario);
    const cPath = await writeTrace("baseline-c.json", stale);

    const result = await pruneStaleBaselines({
      currentTraces: [currentA, currentB],
      baselineGlob: path.join(dir, "baseline-*.json"),
      dryRun: true,
    });

    expect(result.kept.map((k) => k.path).sort()).toEqual([aPath, bPath].sort());
    expect(result.prunable.map((p) => p.path)).toEqual([cPath]);
  });

  it("empty currentTraces → every baseline is prunable (correctness — CLI gates this separately)", async () => {
    const a = await writeTrace("baseline-a.json", baseTrace);
    const b = await writeTrace("baseline-b.json", baseTrace);

    const result = await pruneStaleBaselines({
      currentTraces: [],
      baselineGlob: path.join(dir, "baseline-*.json"),
      dryRun: true,
    });

    expect(result.kept).toEqual([]);
    expect(result.prunable.map((p) => p.path).sort()).toEqual([a, b].sort());
    expect(result.considered).toBe(2);
  });

  it("no baselines match the glob → considered=0, prunable=[], deleted=[]", async () => {
    const current = await writeTrace("current.json", baseTrace);
    const result = await pruneStaleBaselines({
      currentTraces: [current],
      baselineGlob: path.join(dir, "no-such-*.json"),
      dryRun: false,
    });
    expect(result.considered).toBe(0);
    expect(result.kept).toEqual([]);
    expect(result.prunable).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.bytesFreed).toBe(0);
  });

  it("invalid current trace → clear error, no deletions performed", async () => {
    const bad = path.join(dir, "current-bad.json");
    await writeFile(bad, "{not json");
    const stale = await writeTrace("baseline-stale.json", baseTrace);

    await expect(
      pruneStaleBaselines({
        currentTraces: [bad],
        baselineGlob: path.join(dir, "baseline-*.json"),
        dryRun: false,
      }),
    ).rejects.toThrow();

    // Crucial: the stale baseline is still on disk because we aborted before
    // any deletion.
    expect(await exists(stale)).toBe(true);
  });

  it("malformed baseline → reported in skipped, doesn't crash the whole run", async () => {
    const current = await writeTrace("current.json", baseTrace);
    const badBaseline = path.join(dir, "baseline-bad.json");
    await writeFile(badBaseline, "{nope");
    const goodMatched = await writeTrace("baseline-matched.json", baseTrace);

    const result = await pruneStaleBaselines({
      currentTraces: [current],
      baselineGlob: path.join(dir, "baseline-*.json"),
      dryRun: true,
    });

    // The matched baseline should still be kept; the malformed one is skipped
    // (neither kept nor prunable — we don't know if it's stale).
    expect(result.kept.map((k) => k.path)).toContain(goodMatched);
    expect(result.prunable.map((p) => p.path)).not.toContain(badBaseline);
    expect(result.kept.map((k) => k.path)).not.toContain(badBaseline);
    // And the bad file is still on disk.
    expect(await exists(badBaseline)).toBe(true);
  });

  it("non-existent current trace path → clear error, no deletions", async () => {
    const stale = await writeTrace("baseline-stale.json", baseTrace);
    await expect(
      pruneStaleBaselines({
        currentTraces: [path.join(dir, "does-not-exist.json")],
        baselineGlob: path.join(dir, "baseline-*.json"),
        dryRun: false,
      }),
    ).rejects.toThrow(/does-not-exist|ENOENT|not found/);
    expect(await exists(stale)).toBe(true);
  });

  it("defaults to dry-run when dryRun is omitted (safe-by-default)", async () => {
    const current = await writeTrace("current.json", baseTrace);
    const stale = await writeTrace("baseline-stale.json", {
      ...clone(baseTrace),
      steps: baseTrace.steps.slice(0, 1),
    } as Trace);
    const result = await pruneStaleBaselines({
      currentTraces: [current],
      baselineGlob: path.join(dir, "baseline-*.json"),
    });
    expect(result.dryRun).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(await exists(stale)).toBe(true);
  });

  it("PruneResult is JSON-serialisable (round-trips through JSON.stringify/parse)", async () => {
    const current = await writeTrace("current.json", baseTrace);
    const matched = await writeTrace("baseline-matched.json", baseTrace);
    const result = await pruneStaleBaselines({
      currentTraces: [current],
      baselineGlob: path.join(dir, "baseline-*.json"),
      dryRun: true,
    });
    const round = JSON.parse(JSON.stringify(result));
    expect(round.kept[0].path).toBe(matched);
    expect(round.kept[0].matchedBy).toBe(current);
    expect(round.dryRun).toBe(true);
  });

  it("does not consider the current-trace path itself even if the glob also matches it", async () => {
    const current = await writeTrace("baseline-current.json", baseTrace);
    const stale = await writeTrace("baseline-stale.json", {
      ...clone(baseTrace),
      steps: baseTrace.steps.slice(0, 1),
    } as Trace);
    const result = await pruneStaleBaselines({
      currentTraces: [current],
      baselineGlob: path.join(dir, "baseline-*.json"),
      dryRun: true,
    });
    // The current trace itself MUST NOT be reported as prunable — otherwise we
    // would delete the user's live test input.
    expect(result.prunable.map((p) => p.path)).not.toContain(current);
    expect(result.prunable.map((p) => p.path)).toEqual([stale]);
  });

  it("kept entries are sorted by path for deterministic output", async () => {
    const current = await writeTrace("current.json", baseTrace);
    await writeTrace("baseline-c.json", baseTrace);
    await writeTrace("baseline-a.json", baseTrace);
    await writeTrace("baseline-b.json", baseTrace);
    const result = await pruneStaleBaselines({
      currentTraces: [current],
      baselineGlob: path.join(dir, "baseline-*.json"),
      dryRun: true,
    });
    const paths = result.kept.map((k) => k.path);
    expect(paths).toEqual([...paths].sort());
  });
});
