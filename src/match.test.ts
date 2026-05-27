import { realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchTrace } from "./match.js";
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
  // macOS `/tmp` is a symlink to `/private/tmp`; resolve through `realpathSync`
  // so paths returned by the matcher (which uses absolute paths) compare equal
  // to the paths we wrote ourselves.
  dir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-match-")));
});

async function writeTrace(name: string, trace: Trace): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, serializeTrace(trace));
  return p;
}

describe("matchTrace", () => {
  it("returns identical=true when the single baseline byte-equals the current trace", async () => {
    const current = await writeTrace("current.json", baseTrace);
    const baseline = await writeTrace("baseline.json", baseTrace);
    const result = await matchTrace({
      tracePath: current,
      baselineGlob: baseline,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.identical).toBe(true);
    expect(result.matches[0]!.baselinePath).toBe(baseline);
    expect(result.identicalCount).toBe(1);
  });

  it("returns identical=false with a differenceSummary when the baseline differs", async () => {
    const current = await writeTrace("current.json", baseTrace);
    const drifted = clone(baseTrace);
    drifted.steps = drifted.steps.slice(0, 2);
    const baseline = await writeTrace("baseline.json", drifted);
    const result = await matchTrace({
      tracePath: current,
      baselineGlob: baseline,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.identical).toBe(false);
    expect(result.matches[0]!.differenceSummary).toBeTruthy();
    expect(result.matches[0]!.differenceSummary).toMatch(/difference/i);
    expect(result.identicalCount).toBe(0);
  });

  it("matches a glob against multiple baselines, reporting one identical and counting it", async () => {
    const current = await writeTrace("current.json", baseTrace);
    const drift1 = clone(baseTrace);
    if (drift1.steps[1].kind === "assistant") {
      drift1.steps[1].toolCalls[0]!.name = "search_db";
    }
    const drift2 = clone(baseTrace);
    drift2.steps = drift2.steps.slice(0, 1);

    await writeTrace("baseline-a.json", drift1);
    await writeTrace("baseline-b.json", baseTrace);
    await writeTrace("baseline-c.json", drift2);

    const result = await matchTrace({
      tracePath: current,
      baselineGlob: path.join(dir, "baseline-*.json"),
    });
    expect(result.matches).toHaveLength(3);
    expect(result.identicalCount).toBe(1);
    const identical = result.matches.filter((m) => m.identical);
    expect(identical).toHaveLength(1);
    expect(identical[0]!.baselinePath).toBe(path.join(dir, "baseline-b.json"));
    // `bestMatch` is set when at least one baseline is identical OR when
    // there is a clear "fewest differences" non-identical baseline.
    expect(result.bestMatch).toBe(path.join(dir, "baseline-b.json"));
  });

  it("returns an empty matches array when the glob matches zero files", async () => {
    const current = await writeTrace("current.json", baseTrace);
    const result = await matchTrace({
      tracePath: current,
      baselineGlob: path.join(dir, "nope-*.json"),
    });
    expect(result.matches).toEqual([]);
    expect(result.identicalCount).toBe(0);
    expect(result.bestMatch).toBeUndefined();
  });

  it("throws a clear error when the current trace file does not exist", async () => {
    await expect(
      matchTrace({
        tracePath: path.join(dir, "does-not-exist.json"),
        baselineGlob: path.join(dir, "*.json"),
      }),
    ).rejects.toThrow(/does-not-exist|ENOENT|not found/);
  });

  it("throws a clear error when the current trace file is not valid JSON", async () => {
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{not json");
    await expect(
      matchTrace({
        tracePath: bad,
        baselineGlob: path.join(dir, "*.json"),
      }),
    ).rejects.toThrow();
  });

  it("picks bestMatch as the non-identical baseline with the fewest differences when nothing matches exactly", async () => {
    const current = await writeTrace("current.json", baseTrace);

    // big drift — 3 different things
    const big = clone(baseTrace);
    big.steps = big.steps.slice(0, 2);
    if (big.steps[1].kind === "assistant") {
      big.steps[1].toolCalls[0]!.name = "search_db";
      big.steps[1].content = "Different content";
    }

    // small drift — 1 different thing
    const small = clone(baseTrace);
    if (small.steps[1].kind === "assistant") {
      small.steps[1].toolCalls[0]!.name = "search_db";
    }

    await writeTrace("baseline-big.json", big);
    await writeTrace("baseline-small.json", small);

    const result = await matchTrace({
      tracePath: current,
      baselineGlob: path.join(dir, "baseline-*.json"),
    });
    expect(result.identicalCount).toBe(0);
    expect(result.bestMatch).toBe(path.join(dir, "baseline-small.json"));
  });

  it("MatchResult is JSON-serialisable (round-trips through JSON.stringify/parse)", async () => {
    const current = await writeTrace("current.json", baseTrace);
    const baseline = await writeTrace("baseline.json", baseTrace);
    const result = await matchTrace({
      tracePath: current,
      baselineGlob: baseline,
    });
    const round = JSON.parse(JSON.stringify(result));
    expect(round.identicalCount).toBe(1);
    expect(round.matches[0].baselinePath).toBe(baseline);
    expect(round.matches[0].identical).toBe(true);
    expect(round.tracePath).toBe(current);
  });

  it("sorts matches by baselinePath so output is deterministic across glob expansions", async () => {
    const current = await writeTrace("current.json", baseTrace);
    await writeTrace("baseline-c.json", baseTrace);
    await writeTrace("baseline-a.json", baseTrace);
    await writeTrace("baseline-b.json", baseTrace);
    const result = await matchTrace({
      tracePath: current,
      baselineGlob: path.join(dir, "baseline-*.json"),
    });
    const paths = result.matches.map((m) => m.baselinePath);
    expect(paths).toEqual([...paths].sort());
  });

  it("ignores the current-trace path itself if the glob happens to match it", async () => {
    const current = await writeTrace("current.json", baseTrace);
    await writeTrace("baseline.json", baseTrace);
    // glob matches both current.json and baseline.json
    const result = await matchTrace({
      tracePath: current,
      baselineGlob: path.join(dir, "*.json"),
    });
    expect(result.matches.map((m) => m.baselinePath)).not.toContain(current);
    expect(result.matches).toHaveLength(1);
  });

  it("throws a clear error when a matched baseline is malformed JSON", async () => {
    const current = await writeTrace("current.json", baseTrace);
    const bad = path.join(dir, "baseline-bad.json");
    await writeFile(bad, "{nope");
    await expect(
      matchTrace({
        tracePath: current,
        baselineGlob: path.join(dir, "baseline-*.json"),
      }),
    ).rejects.toThrow();
  });

  it("accepts a literal path (no glob metacharacters) as a single-baseline glob", async () => {
    const current = await writeTrace("current.json", baseTrace);
    const baseline = await writeTrace("baseline.json", baseTrace);
    const result = await matchTrace({
      tracePath: current,
      baselineGlob: baseline,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.baselinePath).toBe(baseline);
  });
});
