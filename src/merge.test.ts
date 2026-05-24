import { realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { InvalidSourceError, NoSourcesError, mergeTraces } from "./merge.js";

let workDir: string;

beforeEach(async () => {
  // macOS quirk: `mkdtemp(tmpdir())` returns a `/var/folders/...` path that
  // is actually a symlink to `/private/var/...`. Without `realpathSync`,
  // path-equality assertions break on the macOS CI matrix.
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-merge-")));
});

async function writeTrace(name: string, body: unknown): Promise<string> {
  const full = path.join(workDir, name);
  await writeFile(full, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return full;
}

const traceA = {
  name: "alpha",
  model: "claude-sonnet-4-6",
  steps: [
    { kind: "user", content: "hello" },
    { kind: "assistant", content: "hi", toolCalls: [] },
  ],
};

const traceB = {
  name: "beta",
  model: "claude-sonnet-4-6",
  steps: [
    { kind: "user", content: "again" },
    { kind: "assistant", content: "ok", toolCalls: [] },
  ],
};

const traceC = {
  name: "gamma",
  model: "claude-sonnet-4-6",
  steps: [{ kind: "user", content: "third" }],
};

describe("mergeTraces — basic concatenation", () => {
  it("concatenates two valid traces; output step count = sum, name from first", async () => {
    const a = await writeTrace("a.json", traceA);
    const b = await writeTrace("b.json", traceB);
    const out = path.join(workDir, "out.json");

    const result = await mergeTraces({ inputPaths: [a, b], outPath: out });

    expect(result.outPath).toBe(out);
    expect(result.sourceCount).toBe(2);
    expect(result.totalSteps).toBe(4);

    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written.name).toBe("alpha");
    expect(written.model).toBe("claude-sonnet-4-6");
    expect(written.steps).toHaveLength(4);
    expect(written.steps[0].content).toBe("hello");
    expect(written.steps[3].content).toBe("ok");
  });

  it("concatenates three traces in input order", async () => {
    const a = await writeTrace("a.json", traceA);
    const b = await writeTrace("b.json", traceB);
    const c = await writeTrace("c.json", traceC);
    const out = path.join(workDir, "out.json");

    const result = await mergeTraces({ inputPaths: [a, b, c], outPath: out });

    expect(result.sourceCount).toBe(3);
    expect(result.totalSteps).toBe(5);

    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written.steps.map((s: { content: string }) => s.content)).toEqual([
      "hello",
      "hi",
      "again",
      "ok",
      "third",
    ]);
  });

  it("preserves a single source as-is (one-input merge is the identity case)", async () => {
    const a = await writeTrace("a.json", traceA);
    const out = path.join(workDir, "out.json");

    const result = await mergeTraces({ inputPaths: [a], outPath: out });

    expect(result.sourceCount).toBe(1);
    expect(result.totalSteps).toBe(2);

    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written).toMatchObject({
      name: "alpha",
      model: "claude-sonnet-4-6",
      steps: traceA.steps,
    });
  });
});

describe("mergeTraces — name + model overrides", () => {
  it("--name overrides the first source's name", async () => {
    const a = await writeTrace("a.json", traceA);
    const b = await writeTrace("b.json", traceB);
    const out = path.join(workDir, "out.json");

    await mergeTraces({ inputPaths: [a, b], outPath: out, name: "merged-suite" });

    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written.name).toBe("merged-suite");
  });

  it("--model overrides everything (no disagreement warning fires)", async () => {
    const a = await writeTrace("a.json", { ...traceA, model: "claude-sonnet-4-6" });
    const b = await writeTrace("b.json", { ...traceB, model: "gpt-4o" });
    const out = path.join(workDir, "out.json");
    const warnings: string[] = [];

    await mergeTraces({
      inputPaths: [a, b],
      outPath: out,
      model: "claude-sonnet-4-7",
      warn: (m) => warnings.push(m),
    });

    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written.model).toBe("claude-sonnet-4-7");
    // Explicit --model overrides — no disagreement warning, the user picked.
    expect(warnings.filter((w) => w.includes("disagree on model"))).toHaveLength(0);
  });
});

describe("mergeTraces — model disagreement", () => {
  it("warns to stderr and uses the first source's model when sources disagree", async () => {
    const a = await writeTrace("a.json", { ...traceA, model: "claude-sonnet-4-6" });
    const b = await writeTrace("b.json", { ...traceB, model: "gpt-4o" });
    const out = path.join(workDir, "out.json");
    const warnings: string[] = [];

    await mergeTraces({ inputPaths: [a, b], outPath: out, warn: (m) => warnings.push(m) });

    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written.model).toBe("claude-sonnet-4-6");
    expect(warnings.some((w) => w.includes("disagree on model"))).toBe(true);
    expect(warnings.some((w) => w.includes("claude-sonnet-4-6"))).toBe(true);
    expect(warnings.some((w) => w.includes("gpt-4o"))).toBe(true);
  });

  it("does not warn when all sources agree on model", async () => {
    const a = await writeTrace("a.json", traceA);
    const b = await writeTrace("b.json", traceB);
    const out = path.join(workDir, "out.json");
    const warnings: string[] = [];

    await mergeTraces({ inputPaths: [a, b], outPath: out, warn: (m) => warnings.push(m) });

    expect(warnings.filter((w) => w.includes("disagree on model"))).toHaveLength(0);
  });
});

describe("mergeTraces — meta merge", () => {
  it("merges non-conflicting meta keys shallowly from every source", async () => {
    const a = await writeTrace("a.json", { ...traceA, meta: { framework: "crewai" } });
    const b = await writeTrace("b.json", { ...traceB, meta: { commit: "abc123" } });
    const out = path.join(workDir, "out.json");

    await mergeTraces({ inputPaths: [a, b], outPath: out });

    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written.meta).toEqual({ framework: "crewai", commit: "abc123" });
  });

  it("on meta key conflict, first occurrence wins and a warning is emitted", async () => {
    const a = await writeTrace("a.json", { ...traceA, meta: { framework: "crewai" } });
    const b = await writeTrace("b.json", { ...traceB, meta: { framework: "langgraph" } });
    const out = path.join(workDir, "out.json");
    const warnings: string[] = [];

    await mergeTraces({ inputPaths: [a, b], outPath: out, warn: (m) => warnings.push(m) });

    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written.meta.framework).toBe("crewai");
    expect(warnings.some((w) => w.includes("meta key") && w.includes("framework"))).toBe(true);
  });

  it("omits meta from the output when no source had any meta", async () => {
    const a = await writeTrace("a.json", traceA);
    const b = await writeTrace("b.json", traceB);
    const out = path.join(workDir, "out.json");

    await mergeTraces({ inputPaths: [a, b], outPath: out });

    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written.meta).toBeUndefined();
  });
});

describe("mergeTraces — error handling", () => {
  it("refuses to merge when one source fails schema validation", async () => {
    const a = await writeTrace("a.json", traceA);
    const bad = await writeTrace("bad.json", { name: "broken" /* missing steps */ });
    const out = path.join(workDir, "out.json");

    await expect(mergeTraces({ inputPaths: [a, bad], outPath: out })).rejects.toBeInstanceOf(
      InvalidSourceError,
    );

    // No partial file written.
    await expect(readFile(out, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("emits a clear error when an input file does not exist", async () => {
    const a = await writeTrace("a.json", traceA);
    const missing = path.join(workDir, "does-not-exist.json");
    const out = path.join(workDir, "out.json");

    await expect(mergeTraces({ inputPaths: [a, missing], outPath: out })).rejects.toThrow(
      /could not read trace/,
    );
  });

  it("emits a clear error on malformed JSON input", async () => {
    const a = await writeTrace("a.json", traceA);
    const broken = path.join(workDir, "broken.json");
    await writeFile(broken, "{ not valid json", "utf8");
    const out = path.join(workDir, "out.json");

    await expect(mergeTraces({ inputPaths: [a, broken], outPath: out })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("throws NoSourcesError on an empty input list", async () => {
    await expect(mergeTraces({ inputPaths: [] })).rejects.toBeInstanceOf(NoSourcesError);
  });
});

describe("mergeTraces — output path resolution", () => {
  it("returns an absolute outPath", async () => {
    const a = await writeTrace("a.json", traceA);
    const b = await writeTrace("b.json", traceB);
    const out = path.join(workDir, "out.json");

    const result = await mergeTraces({ inputPaths: [a, b], outPath: out });

    expect(path.isAbsolute(result.outPath)).toBe(true);
    expect(result.outPath).toBe(out);
  });

  it("preserves tool calls and step kinds intact across the merge", async () => {
    const withTools = {
      name: "tools",
      model: "claude-sonnet-4-6",
      steps: [
        { kind: "user", content: "search" },
        {
          kind: "assistant",
          content: "looking",
          toolCalls: [
            { name: "search_kb", arguments: { q: "policy" }, result: "found", latencyMs: 42 },
          ],
        },
      ],
    };
    const a = await writeTrace("a.json", withTools);
    const b = await writeTrace("b.json", traceB);
    const out = path.join(workDir, "out.json");

    await mergeTraces({ inputPaths: [a, b], outPath: out });

    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written.steps[1].toolCalls).toHaveLength(1);
    expect(written.steps[1].toolCalls[0]).toMatchObject({
      name: "search_kb",
      arguments: { q: "policy" },
      result: "found",
      latencyMs: 42,
    });
  });
});
