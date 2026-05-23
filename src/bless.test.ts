import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BaselineExistsError,
  InvalidRecordingError,
  NotABenchError,
  RecordingNotFoundError,
  blessRecording,
} from "./bless.js";
import { initBench } from "./init.js";

let workDir: string;
let prevCwd: string;

beforeEach(async () => {
  // Same macOS quirk init.test.ts / list.test.ts / validate.test.ts handle:
  // tmpdir() returns /var/folders/... which resolves to /private/var/folders/...
  // once chdir'd. Pre-resolve so path-equality assertions hold across the CI
  // matrix (Ubuntu / macOS / Windows).
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-bless-")));
  prevCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(prevCwd);
});

const VALID_TRACE = {
  name: "refund-policy",
  model: "claude-sonnet-4-6",
  steps: [
    { kind: "user", content: "What is your refund policy?" },
    {
      kind: "assistant",
      content: "Let me look that up.",
      toolCalls: [{ name: "search_kb", arguments: { query: "refund policy" } }],
    },
  ],
};

async function scaffoldBench(name = "demo"): Promise<string> {
  const { benchDir } = await initBench({ name, outputDir: workDir });
  return benchDir;
}

async function writeRecording(
  benchDir: string,
  filename: string,
  body: unknown = VALID_TRACE,
): Promise<string> {
  const full = path.join(benchDir, "recordings", filename);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return full;
}

describe("blessRecording — happy path", () => {
  it("promotes a recording to a baseline with matching contents", async () => {
    const benchDir = await scaffoldBench();
    const recPath = await writeRecording(benchDir, "refund.json");

    const result = await blessRecording({ benchDir, recordingPath: recPath });

    expect(result.dryRun).toBe(false);
    expect(result.recordingPath).toBe(recPath);
    expect(result.baselineName).toBe("refund.json");
    expect(result.baselinePath).toBe(path.join(benchDir, "baselines", "refund.json"));

    // Baseline file exists and matches the recording byte-for-byte.
    const baselineRaw = await readFile(result.baselinePath, "utf8");
    const recordingRaw = await readFile(recPath, "utf8");
    expect(baselineRaw).toBe(recordingRaw);
    expect((await stat(result.baselinePath)).isFile()).toBe(true);
  });

  it("accepts a bare basename and resolves it under recordings/", async () => {
    const benchDir = await scaffoldBench();
    await writeRecording(benchDir, "refund.json");

    const result = await blessRecording({ benchDir, recordingPath: "refund.json" });

    expect(result.recordingPath).toBe(path.join(benchDir, "recordings", "refund.json"));
    expect((await stat(result.baselinePath)).isFile()).toBe(true);
  });

  it("accepts a path relative to the bench dir (recordings/<name>)", async () => {
    const benchDir = await scaffoldBench();
    await writeRecording(benchDir, "refund.json");

    const result = await blessRecording({
      benchDir,
      recordingPath: "recordings/refund.json",
    });

    expect(result.recordingPath).toBe(path.join(benchDir, "recordings", "refund.json"));
    expect((await stat(result.baselinePath)).isFile()).toBe(true);
  });
});

describe("blessRecording — overwrite protection", () => {
  it("refuses to overwrite an existing baseline without --force", async () => {
    const benchDir = await scaffoldBench();
    await writeRecording(benchDir, "refund.json");
    await writeFile(
      path.join(benchDir, "baselines", "refund.json"),
      JSON.stringify({ name: "stale", steps: [] }),
      "utf8",
    );

    await expect(blessRecording({ benchDir, recordingPath: "refund.json" })).rejects.toBeInstanceOf(
      BaselineExistsError,
    );
  });

  it("overwrites an existing baseline when force is true", async () => {
    const benchDir = await scaffoldBench();
    const recPath = await writeRecording(benchDir, "refund.json");
    const stalePath = path.join(benchDir, "baselines", "refund.json");
    await writeFile(stalePath, JSON.stringify({ name: "stale", steps: [] }), "utf8");

    const result = await blessRecording({
      benchDir,
      recordingPath: recPath,
      force: true,
    });

    const blessed = JSON.parse(await readFile(result.baselinePath, "utf8"));
    expect(blessed.name).toBe("refund-policy"); // fresh content, stale gone
    expect(blessed.steps).toHaveLength(2);
  });
});

describe("blessRecording — validation gate", () => {
  it("refuses to bless a recording that fails schema validation", async () => {
    const benchDir = await scaffoldBench();
    // Wrong type: steps is a string, not an array.
    const recPath = await writeRecording(benchDir, "broken.json", {
      name: "broken",
      steps: "not an array",
    });

    await expect(blessRecording({ benchDir, recordingPath: recPath })).rejects.toBeInstanceOf(
      InvalidRecordingError,
    );

    // And the baseline must NOT have been created.
    const wouldBe = path.join(benchDir, "baselines", "broken.json");
    await expect(stat(wouldBe)).rejects.toThrow();
  });

  it("refuses to bless a recording with malformed JSON", async () => {
    const benchDir = await scaffoldBench();
    const recPath = await writeRecording(benchDir, "broken.json", "{ not real json");

    await expect(blessRecording({ benchDir, recordingPath: recPath })).rejects.toBeInstanceOf(
      InvalidRecordingError,
    );
  });
});

describe("blessRecording — name override", () => {
  it("--name overrides the destination baseline filename", async () => {
    const benchDir = await scaffoldBench();
    const recPath = await writeRecording(benchDir, "fresh-refund-run.json");

    const result = await blessRecording({
      benchDir,
      recordingPath: recPath,
      baselineName: "refund-policy.json",
    });

    expect(result.baselineName).toBe("refund-policy.json");
    expect(result.baselinePath).toBe(path.join(benchDir, "baselines", "refund-policy.json"));
    expect((await stat(result.baselinePath)).isFile()).toBe(true);
    // Original-named file should NOT exist as a baseline.
    await expect(stat(path.join(benchDir, "baselines", "fresh-refund-run.json"))).rejects.toThrow();
  });

  it("rejects a baseline name containing path separators", async () => {
    const benchDir = await scaffoldBench();
    await writeRecording(benchDir, "refund.json");

    await expect(
      blessRecording({
        benchDir,
        recordingPath: "refund.json",
        baselineName: "../escape.json",
      }),
    ).rejects.toThrow(/invalid baseline name/);
  });
});

describe("blessRecording — dry run", () => {
  it("writes nothing on --dry-run but still reports the planned destination", async () => {
    const benchDir = await scaffoldBench();
    const recPath = await writeRecording(benchDir, "refund.json");

    const result = await blessRecording({
      benchDir,
      recordingPath: recPath,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.baselinePath).toBe(path.join(benchDir, "baselines", "refund.json"));
    // No file was written.
    await expect(stat(result.baselinePath)).rejects.toThrow();
  });

  it("--dry-run still validates and still surfaces overwrite refusal", async () => {
    const benchDir = await scaffoldBench();
    await writeRecording(benchDir, "refund.json");
    await writeFile(
      path.join(benchDir, "baselines", "refund.json"),
      JSON.stringify({ name: "stale", steps: [] }),
      "utf8",
    );

    await expect(
      blessRecording({ benchDir, recordingPath: "refund.json", dryRun: true }),
    ).rejects.toBeInstanceOf(BaselineExistsError);
  });
});

describe("blessRecording — error paths", () => {
  it("throws RecordingNotFoundError when the recording does not exist", async () => {
    const benchDir = await scaffoldBench();
    await expect(blessRecording({ benchDir, recordingPath: "ghost.json" })).rejects.toBeInstanceOf(
      RecordingNotFoundError,
    );
  });

  it("throws NotABenchError when bench.json is missing", async () => {
    // Plain directory, never initBench'd.
    const notABench = path.join(workDir, "not-a-bench");
    await mkdir(notABench, { recursive: true });

    await expect(
      blessRecording({ benchDir: notABench, recordingPath: "x.json" }),
    ).rejects.toBeInstanceOf(NotABenchError);
  });

  it("throws a clear error when the baselines/ directory is missing", async () => {
    // Half-scaffolded bench: bench.json + recordings/ but no baselines/.
    const benchDir = path.join(workDir, "half");
    await mkdir(path.join(benchDir, "recordings"), { recursive: true });
    await writeFile(
      path.join(benchDir, "bench.json"),
      JSON.stringify({
        name: "half",
        version: "0.0.1",
        baselineDir: "baselines",
        recordingsDir: "recordings",
      }),
      "utf8",
    );
    await writeFile(
      path.join(benchDir, "recordings", "refund.json"),
      JSON.stringify(VALID_TRACE),
      "utf8",
    );

    await expect(blessRecording({ benchDir, recordingPath: "refund.json" })).rejects.toThrow(
      /missing baselines\/ directory/,
    );
  });

  it("throws NotABenchError when bench.json is not valid JSON", async () => {
    const benchDir = path.join(workDir, "garbled");
    await mkdir(path.join(benchDir, "baselines"), { recursive: true });
    await mkdir(path.join(benchDir, "recordings"), { recursive: true });
    await writeFile(path.join(benchDir, "bench.json"), "{ not json", "utf8");

    await expect(blessRecording({ benchDir, recordingPath: "refund.json" })).rejects.toBeInstanceOf(
      NotABenchError,
    );
  });
});
