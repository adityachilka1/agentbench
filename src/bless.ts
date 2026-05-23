/**
 * `agentbench bless <recording>` — promote a recorded trace to be the
 * new baseline.
 *
 * Closes the workflow loop. After a model bump or a deliberate prompt
 * change, `agentbench compare` shows drift. If the drift is *intended*
 * (the agent improved, you renamed a tool, the user-facing copy changed),
 * the recording becomes the new contract. `bless` is the intentional act
 * that promotes `recordings/<x>.json` → `baselines/<x>.json`.
 *
 * Guard-rails:
 *
 *   1. Refuse to bless a recording that doesn't validate — broken JSON
 *      becoming the "golden" version is the worst possible outcome.
 *   2. Refuse to overwrite an existing baseline without `--force`. The
 *      whole point of bless is that it's deliberate; silent overwrite
 *      would defeat the safeguard `compare` is meant to provide.
 *   3. Atomic write (tmp + rename) so a half-written baseline can't
 *      replace a good one on a crash.
 *
 * Reads `bench.json` to discover the canonical baseline/recordings dir
 * names — same convention as `list` / `validate`.
 */
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { copyFile, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { validateAgentbenchFile } from "./validate.js";

export interface BlessOptions {
  /** Path to the bench directory (contains `bench.json`). */
  benchDir: string;
  /**
   * Recording to promote. Accepts:
   *   - an absolute path
   *   - a path relative to `benchDir` (e.g. `recordings/refund.json`)
   *   - a bare basename (e.g. `refund.json`) — resolved under `recordings/`
   */
  recordingPath: string;
  /**
   * Override the destination baseline filename. Defaults to the
   * basename of the resolved recording.
   */
  baselineName?: string;
  /** Overwrite an existing baseline. Defaults to false. */
  force?: boolean;
  /**
   * Report what would happen without writing anything. The destination
   * `baselinePath` is still populated so callers can render a plan.
   */
  dryRun?: boolean;
}

export interface BlessResult {
  /** Absolute path to the recording that was (or would be) promoted. */
  recordingPath: string;
  /** Absolute path the baseline was (or would be) written to. */
  baselinePath: string;
  /** The destination baseline filename (basename of `baselinePath`). */
  baselineName: string;
  /** True if `--dry-run` was set: nothing was written. */
  dryRun: boolean;
}

/** Thrown when the target directory isn't a bench (no `bench.json`). */
export class NotABenchError extends Error {
  constructor(dir: string) {
    super(`not a bench: ${dir} (missing bench.json — run \`agentbench init\` first)`);
    this.name = "NotABenchError";
  }
}

/** Thrown when the requested recording can't be found anywhere we looked. */
export class RecordingNotFoundError extends Error {
  constructor(recordingPath: string, triedPaths: string[]) {
    super(
      `recording not found: ${recordingPath}\n  looked at:\n${triedPaths
        .map((p) => `    · ${p}`)
        .join("\n")}`,
    );
    this.name = "RecordingNotFoundError";
  }
}

/** Thrown when the destination baseline already exists and `--force` was not set. */
export class BaselineExistsError extends Error {
  constructor(baselinePath: string) {
    super(
      `baseline already exists: ${baselinePath} — re-run with --force to overwrite (this is intentional: bless must be a deliberate act)`,
    );
    this.name = "BaselineExistsError";
  }
}

/** Thrown when the recording failed schema validation. */
export class InvalidRecordingError extends Error {
  constructor(recordingPath: string, summary: string) {
    super(
      `refusing to bless a recording that failed validation: ${recordingPath}\n  ${summary}\n  fix the recording (or re-record) before blessing — a broken baseline poisons every future compare`,
    );
    this.name = "InvalidRecordingError";
  }
}

/**
 * Promote a recording to be the new baseline. See {@link BlessOptions}.
 *
 * Order of operations matters:
 *   1. Resolve & sanity-check the bench dir (must have `bench.json`).
 *   2. Resolve the recording path (absolute / relative / bare name).
 *   3. Resolve the destination baseline path.
 *   4. Refuse if it would overwrite without `--force`.
 *   5. Validate the recording — never bless a broken file.
 *   6. If `--dry-run`, return now with the planned destination.
 *   7. Atomic copy: write to tmp sibling, rename into place.
 */
export async function blessRecording(options: BlessOptions): Promise<BlessResult> {
  const benchDir = path.resolve(options.benchDir);

  // 1. Bench dir + bench.json
  const benchJsonPath = path.join(benchDir, "bench.json");
  let raw: string;
  try {
    raw = await readFile(benchJsonPath, "utf8");
  } catch {
    throw new NotABenchError(benchDir);
  }
  let config: { baselineDir?: unknown; recordingsDir?: unknown };
  try {
    config = JSON.parse(raw);
  } catch {
    throw new NotABenchError(benchDir);
  }
  const baselineDirName = typeof config.baselineDir === "string" ? config.baselineDir : "baselines";
  const recordingsDirName =
    typeof config.recordingsDir === "string" ? config.recordingsDir : "recordings";
  const baselineDir = path.join(benchDir, baselineDirName);
  const recordingsDir = path.join(benchDir, recordingsDirName);

  // Verify both subdirs exist — a half-scaffolded bench would otherwise
  // produce a confusing "ENOENT on rename" deep inside the atomic copy.
  await assertDirectory(baselineDir, `bench is missing ${baselineDirName}/ directory`);
  await assertDirectory(recordingsDir, `bench is missing ${recordingsDirName}/ directory`);

  // 2. Resolve the recording
  const recordingPath = await resolveRecordingPath(options.recordingPath, benchDir, recordingsDir);

  // 3. Destination baseline path
  const baselineName = (options.baselineName ?? path.basename(recordingPath)).trim();
  if (!baselineName) {
    throw new Error("baselineName must not be empty");
  }
  if (
    baselineName.includes("/") ||
    baselineName.includes("\\") ||
    baselineName === "." ||
    baselineName === ".."
  ) {
    throw new Error(`invalid baseline name: ${options.baselineName ?? baselineName}`);
  }
  const baselinePath = path.join(baselineDir, baselineName);

  // 4. Overwrite protection
  const exists = await pathExists(baselinePath);
  if (exists && !options.force) {
    throw new BaselineExistsError(baselinePath);
  }

  // 5. Validate before promoting — never bless a broken file.
  const validation = await validateAgentbenchFile(recordingPath);
  if (!validation.ok) {
    throw new InvalidRecordingError(recordingPath, validation.summary);
  }

  // 6. Dry run — report the plan, write nothing.
  if (options.dryRun) {
    return {
      recordingPath,
      baselinePath,
      baselineName,
      dryRun: true,
    };
  }

  // 7. Atomic copy: write to a tmp sibling in baselines/, then rename.
  //    rename(2) is atomic on the same filesystem, so a crash mid-write
  //    leaves either the old baseline intact or the new one fully in place.
  const tmpPath = path.join(
    baselineDir,
    `.${baselineName}.bless-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await copyFile(recordingPath, tmpPath);
    await rename(tmpPath, baselinePath);
  } catch (err) {
    // Best-effort cleanup; if even unlink fails we still surface the
    // original error.
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  return {
    recordingPath,
    baselinePath,
    baselineName,
    dryRun: false,
  };
}

/**
 * Resolve a user-supplied recording argument to an absolute path that exists
 * on disk. Tries, in order:
 *
 *   - the argument as an absolute path
 *   - the argument joined onto `benchDir` (e.g. `recordings/x.json`)
 *   - the argument joined onto `recordingsDir` (bare basename)
 *
 * Throws {@link RecordingNotFoundError} with every path it tried.
 */
async function resolveRecordingPath(
  recordingArg: string,
  benchDir: string,
  recordingsDir: string,
): Promise<string> {
  const candidates: string[] = [];

  if (path.isAbsolute(recordingArg)) {
    candidates.push(recordingArg);
  } else {
    // Argument like `recordings/refund.json` or `nested/refund.json` —
    // resolve against the bench dir first.
    candidates.push(path.resolve(benchDir, recordingArg));
    // Bare basename like `refund.json` — try inside recordings/.
    const inRecordings = path.resolve(recordingsDir, recordingArg);
    if (!candidates.includes(inRecordings)) {
      candidates.push(inRecordings);
    }
  }

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    }
  }

  throw new RecordingNotFoundError(recordingArg, candidates);
}

async function assertDirectory(dir: string, message: string): Promise<void> {
  let s: Stats;
  try {
    s = await stat(dir);
  } catch {
    throw new Error(`${message}: ${dir}`);
  }
  if (!s.isDirectory()) {
    throw new Error(`${message}: ${dir}`);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
