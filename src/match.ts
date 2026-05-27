/**
 * `agentbench match` — compare one current trace against every baseline that
 * matches a glob pattern.
 *
 * The existing `compare <a> <b>` takes exactly two traces. When a test suite
 * has multiple baselines (one per scenario), you want to know — for a given
 * recording — *which* scenario it matches and which it broke. `matchTrace`
 * fans the current trace out across every baseline picked up by a glob,
 * runs the existing structural `compareTraces` against each one, and reports
 * a tidy summary: identical-count, per-baseline result, and a `bestMatch`
 * pointer (the identical baseline if any exists; otherwise the non-identical
 * baseline with the fewest differences).
 *
 * Re-uses `compareTraces` verbatim — this module is a thin orchestration
 * layer, not a re-implementation of the diff logic. Each baseline's
 * `differenceSummary` is the same single-line summary that `formatReport`
 * produces, so consumers don't have to know about the `Difference` union.
 *
 * Glob support: hand-rolled, no new runtime dep. We support the common
 * shell-glob metacharacters `*`, `?`, and character classes `[abc]` in the
 * basename of the pattern. Directory portions are treated literally.
 * Sufficient for the documented use case (`bench/baselines/*.json`).
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { type CompareReport, compareTraces, formatReport } from "./compare.js";
import { parseTrace } from "./trace.js";

export interface MatchOptions {
  /** Path to the current trace file to compare against each baseline. */
  tracePath: string;
  /**
   * Glob pattern selecting baseline files. A path with no glob metacharacters
   * is treated as a single literal baseline path.
   */
  baselineGlob: string;
}

export interface MatchEntry {
  /** Absolute path to the matched baseline file. */
  baselinePath: string;
  /** True when the baseline is structurally identical to the current trace. */
  identical: boolean;
  /** Human-readable summary of the differences, if any. Absent when identical. */
  differenceSummary?: string;
}

export interface MatchResult {
  /** Echo of the current trace path, for consumers serialising to JSON. */
  tracePath: string;
  /** One entry per matched baseline, sorted by `baselinePath` for determinism. */
  matches: MatchEntry[];
  /**
   * Best-fit baseline. If any baseline is structurally identical, it points to
   * that one; otherwise it points to the non-identical baseline with the
   * fewest differences. Absent when no baselines matched the glob.
   */
  bestMatch?: string;
  /** Convenience count of `matches[i].identical === true`. */
  identicalCount: number;
}

/**
 * Crude glob → regex compiler covering the subset we document: `*`, `?`, and
 * `[abc]` (character class). Anchored, basename-only. Anything outside that
 * subset (including escapes) falls through as a literal character.
 */
function compileGlob(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      // Pass character classes through verbatim — they happen to use the
      // same syntax in shell glob and JS regex.
      const end = glob.indexOf("]", i);
      if (end === -1) {
        re += "\\[";
      } else {
        re += glob.slice(i, end + 1);
        i = end;
      }
    } else if (/[.+^$(){}|\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

/** True if `pat` contains any glob metacharacter we recognise. */
function isGlob(pat: string): boolean {
  return /[*?[]/.test(pat);
}

/** Expand `pattern` into a sorted list of absolute file paths. */
async function expandGlob(pattern: string): Promise<string[]> {
  const absPat = path.resolve(pattern);
  if (!isGlob(absPat)) {
    // Literal path — return it as-is. Callers handle the "doesn't exist" case
    // when they try to read it.
    return [absPat];
  }
  const dir = path.dirname(absPat);
  const base = path.basename(absPat);
  const re = compileGlob(base);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => re.test(name))
    .map((name) => path.join(dir, name))
    .sort();
}

/**
 * Render a `CompareReport` as a single-line, machine-skimmable summary.
 * Keeps the multi-line `formatReport` output out of structured JSON
 * consumers — they can re-derive the detail by re-running `compareTraces`
 * with the same two files if they want it.
 */
function summarise(report: CompareReport): string {
  if (report.identical) return "identical";
  const n = report.differences.length;
  return `${n} difference${n === 1 ? "" : "s"}`;
}

export async function matchTrace(opts: MatchOptions): Promise<MatchResult> {
  const tracePath = path.resolve(opts.tracePath);
  const currentRaw = await readFile(tracePath, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      throw new Error(`trace not found: ${tracePath}`);
    }
    throw err;
  });
  const current = parseTrace(currentRaw);

  const candidates = (await expandGlob(opts.baselineGlob)).filter((p) => p !== tracePath);

  const matches: MatchEntry[] = [];
  for (const baselinePath of candidates) {
    const baselineRaw = await readFile(baselinePath, "utf8");
    const baseline = parseTrace(baselineRaw);
    const report = compareTraces(baseline, current);
    matches.push({
      baselinePath,
      identical: report.identical,
      differenceSummary: report.identical ? undefined : summarise(report),
    });
  }

  // Best-match pick. Prefer any identical baseline; otherwise the one with
  // the fewest differences. Re-run `compareTraces` to count — cheap, files
  // are KB-sized, and avoids stashing diff counts on every `MatchEntry`.
  let bestMatch: string | undefined;
  const identical = matches.find((m) => m.identical);
  if (identical) {
    bestMatch = identical.baselinePath;
  } else if (matches.length > 0) {
    let best: { path: string; count: number } | undefined;
    for (const m of matches) {
      const baseline = parseTrace(await readFile(m.baselinePath, "utf8"));
      const count = compareTraces(baseline, current).differences.length;
      if (!best || count < best.count) {
        best = { path: m.baselinePath, count };
      }
    }
    bestMatch = best?.path;
  }

  return {
    tracePath,
    matches,
    bestMatch,
    identicalCount: matches.filter((m) => m.identical).length,
  };
}

/** Render a `MatchResult` as a human-friendly multi-line string. */
export function formatMatchReport(result: MatchResult): string {
  if (result.matches.length === 0) {
    return "no baselines matched";
  }
  const lines: string[] = [];
  for (const m of result.matches) {
    const mark = m.identical ? "✓" : "✗";
    const tail = m.identical ? "identical" : (m.differenceSummary ?? "differs");
    lines.push(`  ${mark} ${m.baselinePath} — ${tail}`);
  }
  if (result.identicalCount === 0 && result.bestMatch) {
    lines.push("");
    lines.push(`Best match: ${result.bestMatch}`);
  } else if (result.identicalCount > 0) {
    lines.push("");
    lines.push(
      `${result.identicalCount} of ${result.matches.length} baseline${
        result.matches.length === 1 ? "" : "s"
      } identical`,
    );
  }
  return lines.join("\n");
}

/** Render a `MatchResult` as a JSON string. Stable shape; safe for piping. */
export function formatMatchJson(result: MatchResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
