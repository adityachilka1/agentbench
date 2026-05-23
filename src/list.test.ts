import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initBench } from "./init.js";
import {
  BenchNotFoundError,
  NotABenchError,
  formatList,
  formatListJson,
  listBench,
} from "./list.js";

let workDir: string;
let prevCwd: string;

beforeEach(async () => {
  // Same macOS quirk init.test.ts handles: tmpdir() returns /var/folders/...
  // but resolves to /private/var/folders/... once chdir'd. Pre-resolve to
  // keep cwd-based path assertions stable across the CI matrix.
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-list-")));
  prevCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(prevCwd);
});

describe("listBench — empty bench", () => {
  it("returns an empty entries array for a freshly-scaffolded bench", async () => {
    const { benchDir } = await initBench({ name: "empty", outputDir: workDir });
    const result = await listBench(benchDir);
    expect(result.benchName).toBe("empty");
    expect(result.entries).toEqual([]);
  });

  it("formatList renders a friendly message when there are no entries", async () => {
    const { benchDir } = await initBench({ name: "empty-fmt", outputDir: workDir });
    const result = await listBench(benchDir);
    const out = formatList(result);
    expect(out).toMatch(/no recordings yet/);
    expect(out).toMatch(/empty-fmt/);
  });
});

describe("listBench — populated bench", () => {
  it("lists one baseline + one recording with the correct types", async () => {
    const { benchDir } = await initBench({ name: "populated", outputDir: workDir });
    await writeFile(
      path.join(benchDir, "baselines", "refund.json"),
      JSON.stringify({ name: "refund", steps: [] }),
      "utf8",
    );
    await writeFile(
      path.join(benchDir, "recordings", "refund.json"),
      JSON.stringify({ name: "refund", steps: [] }),
      "utf8",
    );

    const result = await listBench(benchDir);
    expect(result.entries).toHaveLength(2);

    const baseline = result.entries.find((e) => e.type === "baseline");
    const recording = result.entries.find((e) => e.type === "recording");
    expect(baseline?.name).toBe("baselines/refund.json");
    expect(recording?.name).toBe("recordings/refund.json");
    for (const e of result.entries) {
      expect(e.size).toBeGreaterThan(0);
      expect(e.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("sorts: baselines first, then recordings, each block alphabetic", async () => {
    const { benchDir } = await initBench({ name: "ordered", outputDir: workDir });
    await writeFile(path.join(benchDir, "baselines", "b.json"), "{}", "utf8");
    await writeFile(path.join(benchDir, "baselines", "a.json"), "{}", "utf8");
    await writeFile(path.join(benchDir, "recordings", "z.json"), "{}", "utf8");

    const result = await listBench(benchDir);
    expect(result.entries.map((e) => e.name)).toEqual([
      "baselines/a.json",
      "baselines/b.json",
      "recordings/z.json",
    ]);
  });

  it("skips .gitkeep and dotfiles", async () => {
    const { benchDir } = await initBench({ name: "skip-dotfiles", outputDir: workDir });
    await writeFile(path.join(benchDir, "baselines", ".DS_Store"), "noise", "utf8");
    await writeFile(path.join(benchDir, "baselines", "real.json"), "{}", "utf8");
    const result = await listBench(benchDir);
    expect(result.entries.map((e) => e.name)).toEqual(["baselines/real.json"]);
  });

  it("walks nested subdirs inside baselines/ and recordings/", async () => {
    const { benchDir } = await initBench({ name: "nested", outputDir: workDir });
    await mkdir(path.join(benchDir, "baselines", "support"), { recursive: true });
    await writeFile(path.join(benchDir, "baselines", "support", "refund.json"), "{}", "utf8");
    await writeFile(path.join(benchDir, "baselines", "top.json"), "{}", "utf8");

    const result = await listBench(benchDir);
    const names = result.entries.map((e) => e.name);
    expect(names).toContain("baselines/support/refund.json");
    expect(names).toContain("baselines/top.json");
  });
});

describe("formatListJson", () => {
  it("emits a stable shape: { bench, entries: [{ name, type, size, modified }] }", async () => {
    const { benchDir } = await initBench({ name: "json-shape", outputDir: workDir });
    await writeFile(path.join(benchDir, "baselines", "a.json"), "{}", "utf8");

    const result = await listBench(benchDir);
    const parsed = JSON.parse(formatListJson(result));

    // Shape-only assertion — timestamps and sizes drift.
    expect(parsed.bench).toBe("json-shape");
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries).toHaveLength(1);
    const [entry] = parsed.entries;
    expect(Object.keys(entry).sort()).toEqual(["modified", "name", "size", "type"]);
    expect(entry.name).toBe("baselines/a.json");
    expect(entry.type).toBe("baseline");
    expect(typeof entry.size).toBe("number");
    expect(typeof entry.modified).toBe("string");
  });

  it("ends with a trailing newline so it pipes cleanly", async () => {
    const { benchDir } = await initBench({ name: "trailing-nl", outputDir: workDir });
    const result = await listBench(benchDir);
    expect(formatListJson(result).endsWith("\n")).toBe(true);
  });
});

describe("formatList — table", () => {
  it("includes the standard column headers and one row per entry", async () => {
    const { benchDir } = await initBench({ name: "tbl", outputDir: workDir });
    await writeFile(path.join(benchDir, "baselines", "a.json"), "{}", "utf8");
    await writeFile(path.join(benchDir, "recordings", "a.json"), "{}", "utf8");
    const result = await listBench(benchDir);
    const out = formatList(result);
    expect(out).toMatch(/NAME/);
    expect(out).toMatch(/TYPE/);
    expect(out).toMatch(/SIZE/);
    expect(out).toMatch(/MODIFIED/);
    expect(out.split("\n")).toHaveLength(3); // header + 2 rows
  });
});

describe("listBench — error cases", () => {
  it("throws NotABenchError when the dir exists but has no bench.json", async () => {
    const plain = path.join(workDir, "plain-dir");
    await mkdir(plain, { recursive: true });
    await expect(listBench(plain)).rejects.toBeInstanceOf(NotABenchError);
    await expect(listBench(plain)).rejects.toThrow(/missing bench\.json/);
  });

  it("throws BenchNotFoundError when the dir doesn't exist", async () => {
    const missing = path.join(workDir, "nope-not-here");
    await expect(listBench(missing)).rejects.toBeInstanceOf(BenchNotFoundError);
    await expect(listBench(missing)).rejects.toThrow(/does not exist/);
  });

  it("throws NotABenchError when bench.json is malformed JSON", async () => {
    const broken = path.join(workDir, "broken");
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, "bench.json"), "{ not json", "utf8");
    await expect(listBench(broken)).rejects.toBeInstanceOf(NotABenchError);
  });
});
