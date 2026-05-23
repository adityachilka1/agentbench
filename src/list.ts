/**
 * `agentbench list [dir]` — list every baseline/recording inside a bench.
 *
 * Reads `bench.json` to discover the canonical baseline/recordings dir names,
 * then walks each subtree and reports `{ name, type, size, mtime }` for every
 * file found (skipping `.gitkeep` placeholders and dotfiles). Output is a
 * human-friendly table by default, or stable JSON with `--json`.
 *
 * Symmetric with `init` / `compare`: `init → record → list → compare`.
 */
import type { Dirent, Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export type EntryType = "baseline" | "recording";

export interface ListEntry {
  /** Path relative to the bench dir, using POSIX separators. */
  name: string;
  /** Whether the file lives under baselines/ or recordings/. */
  type: EntryType;
  /** Size in bytes. */
  size: number;
  /** Last-modified time as an ISO 8601 string (UTC). */
  modified: string;
}

export interface ListResult {
  /** Absolute path to the bench dir that was listed. */
  benchDir: string;
  /** Bench name from `bench.json`. */
  benchName: string;
  /** Every baseline + recording file, sorted by type then name. */
  entries: ListEntry[];
}

/** Thrown when the target directory isn't a bench (no `bench.json`). */
export class NotABenchError extends Error {
  constructor(dir: string) {
    super(`not a bench: ${dir} (missing bench.json — run \`agentbench init\` first)`);
    this.name = "NotABenchError";
  }
}

/** Thrown when the target directory doesn't exist or isn't readable. */
export class BenchNotFoundError extends Error {
  constructor(dir: string) {
    super(`directory does not exist: ${dir}`);
    this.name = "BenchNotFoundError";
  }
}

/**
 * Walk a bench directory and collect every baseline + recording.
 *
 * Recurses into nested subdirs under `baselines/` and `recordings/` — the
 * scaffold doesn't create them, but users organise traces by flow soon
 * enough, and a flat-only walker would silently hide them.
 *
 * Skips `.gitkeep` and any dotfile. Sorted: baselines first, then
 * recordings, each block alphabetic on `name`.
 */
export async function listBench(dir: string): Promise<ListResult> {
  const benchDir = path.resolve(dir);

  let dirStat: Stats;
  try {
    dirStat = await stat(benchDir);
  } catch {
    throw new BenchNotFoundError(benchDir);
  }
  if (!dirStat.isDirectory()) {
    throw new BenchNotFoundError(benchDir);
  }

  const benchJsonPath = path.join(benchDir, "bench.json");
  let raw: string;
  try {
    raw = await readFile(benchJsonPath, "utf8");
  } catch {
    throw new NotABenchError(benchDir);
  }

  let config: { name?: unknown; baselineDir?: unknown; recordingsDir?: unknown };
  try {
    config = JSON.parse(raw);
  } catch {
    throw new NotABenchError(benchDir);
  }

  const benchName = typeof config.name === "string" ? config.name : path.basename(benchDir);
  const baselineDir = typeof config.baselineDir === "string" ? config.baselineDir : "baselines";
  const recordingsDir =
    typeof config.recordingsDir === "string" ? config.recordingsDir : "recordings";

  const [baselines, recordings] = await Promise.all([
    walk(path.join(benchDir, baselineDir), benchDir, "baseline"),
    walk(path.join(benchDir, recordingsDir), benchDir, "recording"),
  ]);

  const entries = [...sortEntries(baselines), ...sortEntries(recordings)];
  return { benchDir, benchName, entries };
}

async function walk(absDir: string, benchDir: string, type: EntryType): Promise<ListEntry[]> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(absDir, { withFileTypes: true });
  } catch {
    // Missing subdir is fine — bench just hasn't recorded yet.
    return [];
  }

  const out: ListEntry[] = [];
  for (const ent of dirents) {
    if (ent.name.startsWith(".")) continue; // skip .gitkeep, .DS_Store, etc.
    const full = path.join(absDir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await walk(full, benchDir, type)));
      continue;
    }
    if (!ent.isFile()) continue;
    const s = await stat(full);
    out.push({
      name: path.relative(benchDir, full).split(path.sep).join("/"),
      type,
      size: s.size,
      modified: s.mtime.toISOString(),
    });
  }
  return out;
}

function sortEntries(entries: ListEntry[]): ListEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Render a ListResult as a human-friendly table. Pure — no I/O.
 *
 * Empty bench renders a single "no recordings yet" line so the caller can
 * still emit something useful instead of a blank screen.
 */
export function formatList(result: ListResult): string {
  if (result.entries.length === 0) {
    return `no recordings yet in ${result.benchName} — drop traces into baselines/ or recordings/`;
  }

  const header = ["NAME", "TYPE", "SIZE", "MODIFIED"];
  const rows = result.entries.map((e) => [e.name, e.type, formatSize(e.size), e.modified]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));

  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();

  return [fmt(header), ...rows.map(fmt)].join("\n");
}

/**
 * Render a ListResult as stable JSON. Pure — no I/O.
 * Shape is `{ bench, entries: [{ name, type, size, modified }] }`.
 */
export function formatListJson(result: ListResult): string {
  return `${JSON.stringify(
    {
      bench: result.benchName,
      entries: result.entries,
    },
    null,
    2,
  )}\n`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)}K`;
  return `${(kib / 1024).toFixed(1)}M`;
}
