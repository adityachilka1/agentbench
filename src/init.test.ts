import { realpathSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultBenchConfig, initBench, renderBenchReadme } from "./init.js";

let workDir: string;
let prevCwd: string;

beforeEach(async () => {
  // macOS quirk: tmpdir() may return /var/folders/... which resolves to
  // /private/var/folders/... once chdir'd into. Resolve up front so any
  // string-equality assertions on cwd-based paths line up.
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-init-")));
  prevCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(prevCwd);
});

describe("defaultBenchConfig", () => {
  it("produces the documented shape", () => {
    expect(defaultBenchConfig("demo")).toEqual({
      name: "demo",
      version: "0.0.1",
      baselineDir: "baselines",
      recordingsDir: "recordings",
      tolerances: { extraFrames: 0, missingFrames: 0 },
    });
  });
});

describe("renderBenchReadme", () => {
  it("mentions the `compare` command so users know how to diff", () => {
    const md = renderBenchReadme("demo");
    expect(md).toMatch(/agentbench compare/);
    expect(md).toMatch(/^# demo/);
  });

  it("documents the layout: bench.json, baselines/, recordings/", () => {
    const md = renderBenchReadme("demo");
    expect(md).toMatch(/bench\.json/);
    expect(md).toMatch(/baselines\//);
    expect(md).toMatch(/recordings\//);
  });
});

describe("initBench — happy path", () => {
  it("scaffolds the full directory layout under outputDir", async () => {
    const result = await initBench({ name: "my-bench", outputDir: workDir });
    expect(result.benchDir).toBe(path.join(workDir, "my-bench"));
    expect(result.filesWritten).toHaveLength(5);
    for (const f of result.filesWritten) {
      const s = await stat(f);
      expect(s.isFile()).toBe(true);
    }
  });

  it("writes a bench.json that parses as JSON and matches defaultBenchConfig", async () => {
    const result = await initBench({ name: "json-check", outputDir: workDir });
    const raw = await readFile(path.join(result.benchDir, "bench.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(defaultBenchConfig("json-check"));
  });

  it("creates .gitkeep in both baselines/ and recordings/", async () => {
    const result = await initBench({ name: "keep-check", outputDir: workDir });
    const baselineKeep = path.join(result.benchDir, "baselines", ".gitkeep");
    const recordingsKeep = path.join(result.benchDir, "recordings", ".gitkeep");
    expect((await stat(baselineKeep)).isFile()).toBe(true);
    expect((await stat(recordingsKeep)).isFile()).toBe(true);
  });

  it("writes a README that mentions the compare command", async () => {
    const result = await initBench({ name: "readme-check", outputDir: workDir });
    const readme = await readFile(path.join(result.benchDir, "README.md"), "utf8");
    expect(readme).toMatch(/agentbench compare/);
    expect(readme).toMatch(/readme-check/);
  });

  it("writes a .gitignore that covers node_modules, *.log, and .DS_Store", async () => {
    const result = await initBench({ name: "ignore-check", outputDir: workDir });
    const gi = await readFile(path.join(result.benchDir, ".gitignore"), "utf8");
    expect(gi).toMatch(/node_modules/);
    expect(gi).toMatch(/\*\.log/);
    expect(gi).toMatch(/\.DS_Store/);
  });

  it("defaults outputDir to process.cwd() when omitted", async () => {
    const result = await initBench({ name: "cwd-default" });
    expect(result.benchDir).toBe(path.join(workDir, "cwd-default"));
  });
});

describe("initBench — overwrite protection", () => {
  it("refuses to overwrite an existing bench.json without force", async () => {
    await initBench({ name: "existing", outputDir: workDir });
    await expect(initBench({ name: "existing", outputDir: workDir })).rejects.toThrow(
      /already exists/,
    );
  });

  it("overwrites an existing bench.json when force is true", async () => {
    const benchDir = path.join(workDir, "forced");
    await initBench({ name: "forced", outputDir: workDir });
    // tamper with bench.json
    await writeFile(path.join(benchDir, "bench.json"), '{"name":"tampered"}', "utf8");
    const result = await initBench({ name: "forced", outputDir: workDir, force: true });
    const reparsed = JSON.parse(await readFile(path.join(result.benchDir, "bench.json"), "utf8"));
    expect(reparsed.name).toBe("forced");
    expect(reparsed.version).toBe("0.0.1");
  });
});

describe("initBench — input validation", () => {
  it("rejects an empty name", async () => {
    await expect(initBench({ name: "", outputDir: workDir })).rejects.toThrow(/empty/);
  });

  it("rejects a name containing path separators", async () => {
    await expect(initBench({ name: "a/b", outputDir: workDir })).rejects.toThrow(/invalid/);
    await expect(initBench({ name: "..", outputDir: workDir })).rejects.toThrow(/invalid/);
  });
});
