/**
 * `agentbench prune` — garbage-collect baselines that no current trace still
 * exercises.
 *
 * The complement to `agentbench match`. Where `match` asks *"which baselines
 * does this current trace look like?"*, `prune` asks the reverse over a set:
 * *"of these candidate baselines, which ones do none of my current traces
 * match anymore?"* Those are stale snapshots — left over from deleted tests,
 * renamed scenarios, or branches that never landed — and they are exactly
 * what you want to garbage-collect before a baseline directory becomes a
 * graveyard.
 *
 * Each baseline is structurally compared (via `compareTraces`) against every
 * current trace. A baseline is *matched* iff at least one current trace is
 * within `minDifferences` of it (default `0` — strictly identical). Anything
 * else is *prunable*.
 *
 * **Safe by default.** `dryRun` defaults to `true`; the caller must pass
 * `{ dryRun: false }` to actually unlink files. Mistyped invocations of a
 * GC primitive should be loud, not destructive.
 *
 * Reuses `match.ts`'s hand-rolled glob — same dependency-free `*`/`?`/`[abc]`
 * subset, basename-only. We deliberately do not import `matchTrace` itself,
 * because the per-baseline question we're answering ("did *any* current
 * match?") is the dual of `match`'s ("which baselines does *this* current
 * match?") — composing them would re-read every baseline N times for N
 * current traces, which gets expensive on real benches. Going through
 * `compareTraces` directly keeps it O(baselines × currents).
 */
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { compareTraces } from "./compare.js";
import { parseTrace } from "./trace.js";

export interface PruneOptions {
  /** Paths to current traces — the ones still in active testing. */
  currentTraces: string[];
  /** Glob of candidate baselines to consider pruning. */
  baselineGlob: string;
  /**
   * Default `true`. Require an explicit `{ dryRun: false }` to actually
   * unlink files — a GC tool's mistakes are expensive.
   */
  dryRun?: boolean;
  /**
   * A baseline is *matched* if some current trace has `<= minDifferences`
   * structural differences from it. Default `0` (byte-equivalent structure).
   */
  minDifferences?: number;
}

export interface PruneKeptEntry {
  /** Absolute path to the kept baseline. */
  path: string;
  /** Absolute path of the current trace that matched it (the first one found). */
  matchedBy: string;
}

export interface PrunableEntry {
  /** Absolute path to the baseline that nothing matched. */
  path: string;
  /** File size in bytes — what would be reclaimed by deleting it. */
  bytes: number;
}

export interface PruneResult {
  /** How many baselines the glob produced (after filtering out current traces). */
  considered: number;
  /** Baselines that at least one current trace still matches. Sorted by `path`. */
  kept: PruneKeptEntry[];
  /** Baselines that no current trace matched. Sorted by `path`. */
  prunable: PrunableEntry[];
  /** Files that were actually unlinked. Empty in dry-run mode. */
  deleted: string[];
  /** Sum of `prunable[i].bytes` for the entries actually deleted. */
  bytesFreed: number;
  /** Echo of the effective `dryRun` value. */
  dryRun: boolean;
}

/* --- glob (cribbed verbatim from match.ts; intentional duplication: keeps
   prune self-contained, and the two modules are free to diverge later) --- */

function compileGlob(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
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

function isGlob(pat: string): boolean {
  return /[*?[]/.test(pat);
}

async function expandGlob(pattern: string): Promise<string[]> {
  const absPat = path.resolve(pattern);
  if (!isGlob(absPat)) {
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

export async function pruneStaleBaselines(opts: PruneOptions): Promise<PruneResult> {
  const dryRun = opts.dryRun ?? true;
  const minDiff = opts.minDifferences ?? 0;

  // Parse every current trace up front. Any failure here is fatal: a typo'd
  // current path is the classic foot-gun (you'd treat every baseline as
  // unmatched and gleefully delete the lot), so we throw before any
  // filesystem mutation can happen.
  const currentTraces = await Promise.all(
    opts.currentTraces.map(async (raw) => {
      const abs = path.resolve(raw);
      const text = await readFile(abs, "utf8").catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          throw new Error(`current trace not found: ${abs}`);
        }
        throw err;
      });
      return { path: abs, trace: parseTrace(text) };
    }),
  );
  const currentPaths = new Set(currentTraces.map((c) => c.path));

  // Expand the glob, drop any path that *is* one of the current traces (we
  // never want to delete a live test input — see the test "does not consider
  // the current-trace path itself").
  const candidates = (await expandGlob(opts.baselineGlob)).filter((p) => !currentPaths.has(p));

  const kept: PruneKeptEntry[] = [];
  const prunable: PrunableEntry[] = [];

  for (const baselinePath of candidates) {
    let baselineText: string;
    try {
      baselineText = await readFile(baselinePath, "utf8");
    } catch {
      // Unreadable file — skip silently (reported as neither kept nor prunable).
      continue;
    }
    let baseline: ReturnType<typeof parseTrace>;
    try {
      baseline = parseTrace(baselineText);
    } catch {
      // Malformed baseline — skip. Deleting a malformed file would be
      // strictly worse than leaving it: a human needs to look at it.
      continue;
    }

    let matchedBy: string | undefined;
    for (const c of currentTraces) {
      const report = compareTraces(baseline, c.trace);
      const diffCount = report.identical ? 0 : report.differences.length;
      if (diffCount <= minDiff) {
        matchedBy = c.path;
        break;
      }
    }

    if (matchedBy !== undefined) {
      kept.push({ path: baselinePath, matchedBy });
    } else {
      let bytes = 0;
      try {
        bytes = (await stat(baselinePath)).size;
      } catch {
        bytes = 0;
      }
      prunable.push({ path: baselinePath, bytes });
    }
  }

  kept.sort((a, b) => a.path.localeCompare(b.path));
  prunable.sort((a, b) => a.path.localeCompare(b.path));

  // Considered = kept + prunable. Malformed / unreadable files are *not*
  // counted — they were never really under consideration for deletion.
  const considered = kept.length + prunable.length;

  const deleted: string[] = [];
  let bytesFreed = 0;
  if (!dryRun) {
    for (const p of prunable) {
      try {
        await unlink(p.path);
        deleted.push(p.path);
        bytesFreed += p.bytes;
      } catch {
        // Best-effort delete; a failure here doesn't abort the rest of the
        // run, but the file stays out of `deleted`.
      }
    }
  }

  return { considered, kept, prunable, deleted, bytesFreed, dryRun };
}

/** Render a `PruneResult` as a human-friendly multi-line string. */
export function formatPruneReport(result: PruneResult): string {
  const lines: string[] = [];
  if (result.considered === 0) {
    lines.push("no baselines matched the glob");
    return lines.join("\n");
  }
  if (result.kept.length > 0) {
    lines.push(`Kept (${result.kept.length}):`);
    for (const k of result.kept) {
      lines.push(`  ✓ ${k.path}  (matched by ${k.matchedBy})`);
    }
  }
  if (result.prunable.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`${result.dryRun ? "Would prune" : "Pruned"} (${result.prunable.length}):`);
    for (const p of result.prunable) {
      lines.push(`  ✗ ${p.path}  (${formatBytes(p.bytes)})`);
    }
  }
  const totalBytes = result.prunable.reduce((acc, p) => acc + p.bytes, 0);
  lines.push("");
  if (result.dryRun) {
    lines.push(
      `Would delete ${result.prunable.length} baseline${
        result.prunable.length === 1 ? "" : "s"
      } (${formatBytes(totalBytes)}). Re-run with --delete to actually remove.`,
    );
  } else {
    lines.push(
      `Deleted ${result.deleted.length} baseline${
        result.deleted.length === 1 ? "" : "s"
      } (${formatBytes(result.bytesFreed)}).`,
    );
  }
  return lines.join("\n");
}

/** Render a `PruneResult` as a JSON string. Stable shape; safe for piping. */
export function formatPruneJson(result: PruneResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
