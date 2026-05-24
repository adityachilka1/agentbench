/**
 * `agentbench stats [path]` — print summary statistics for a trace or a
 * directory of traces.
 *
 * Useful for CI dashboards ("did this run get longer?"), one-off "what does
 * this trace actually contain?" questions, and back-of-the-envelope budget
 * checks before a model swap. Reads traces, parses them through `TraceSchema`,
 * and aggregates: step counts, per-tool latency distribution, model
 * breakdown, and a single "largest trace" pointer.
 *
 * Skip-on-invalid policy: a directory with one malformed trace should NOT
 * abort the whole run. Invalid files are surfaced as `skipped` entries with a
 * one-line reason, and the rest of the directory contributes to the stats.
 * This is intentionally looser than `validate` / `bless` / `redact` — those
 * are gating tools, `stats` is a reporting tool.
 *
 * Percentiles use the nearest-rank method (no interpolation). For very small
 * samples (n=1 or n=2) p50 and p95 collapse to the available value(s) —
 * that's the honest answer; pretending we have more resolution than the data
 * supports would be worse.
 */
import type { Dirent, Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { TraceSchema } from "./trace.js";

/** File extensions we recognise as candidate traces in directory mode. */
const TRACE_EXTENSIONS = new Set([".json", ".agentbench"]);

/** Per-tool stats block. Latency fields are only present when at least one
 *  ToolCall for that tool recorded a `latencyMs`. */
export interface ToolStats {
  /** Tool name as invoked. */
  name: string;
  /** Total ToolCalls observed across every trace. */
  count: number;
  /** 50th-percentile latency in ms (nearest rank). Undefined if no latencies. */
  p50LatencyMs?: number;
  /** 95th-percentile latency in ms (nearest rank). Undefined if no latencies. */
  p95LatencyMs?: number;
  /** Maximum recorded latency in ms. Undefined if no latencies. */
  maxLatencyMs?: number;
  /** Mean serialised JSON length of `arguments` across every call, in bytes. */
  avgArgumentsBytes: number;
}

/** A one-line summary per trace, in input order. */
export interface PerTraceSummary {
  /** `name` from the trace JSON. */
  name: string;
  /** Total step count (user + assistant). */
  steps: number;
  /** `model` field, if the trace recorded one. */
  modelId?: string;
}

/** Pointer to the single largest trace by raw byte size. */
export interface LargestTrace {
  /** Absolute path to the source file. */
  path: string;
  /** Step count of that trace. */
  steps: number;
  /** Raw file size in bytes (what `wc -c` would report). */
  bytes: number;
}

/** A file we couldn't parse — surfaced for the caller to warn about. */
export interface SkippedTrace {
  /** Absolute path to the offending file. */
  path: string;
  /** One-line reason (malformed JSON, schema drift, unreadable, …). */
  reason: string;
}

/** Top-level aggregated report. */
export interface StatsReport {
  /** Absolute path that was scanned (file or directory). */
  path: string;
  /** Number of traces that parsed successfully and contributed to the stats. */
  traceCount: number;
  /** Total step count across every valid trace. */
  totalSteps: number;
  /** User-kind steps. */
  userSteps: number;
  /** Assistant-kind steps. */
  assistantSteps: number;
  /** modelId → trace count. Traces without a model are bucketed under `"(none)"`. */
  modelBreakdown: Record<string, number>;
  /** Per-tool stats. Sorted by count desc, then name asc. */
  toolBreakdown: ToolStats[];
  /** Largest trace by byte size. Undefined if no valid traces. */
  largestTrace?: LargestTrace;
  /** Flat per-trace summary in input (sorted) order. */
  byTraceName: PerTraceSummary[];
  /** Files we skipped due to parse / schema issues. */
  skipped: SkippedTrace[];
}

/** Options for the optional `--top N` cap on the toolBreakdown table. */
export interface ComputeStatsOptions {
  /**
   * Cap the `toolBreakdown` array to the top N entries by count.
   * Undefined / non-positive means "return every tool". The CLI defaults to 10.
   */
  top?: number;
}

/**
 * Compute summary statistics for a trace file or a directory of traces.
 * Recurses subdirectories the same way `validate` does. Throws only on
 * `path-does-not-exist` (the whole run can't proceed). Individual
 * parse / schema failures go into `skipped` and the rest of the run continues.
 */
export async function computeStats(
  target: string,
  options: ComputeStatsOptions = {},
): Promise<StatsReport> {
  const absPath = path.resolve(target);

  let s: Stats;
  try {
    s = await stat(absPath);
  } catch {
    throw new Error(`path does not exist: ${absPath}`);
  }

  const candidates: string[] = [];
  if (s.isDirectory()) {
    candidates.push(...(await collectTraceFiles(absPath)));
    candidates.sort();
  } else if (s.isFile()) {
    candidates.push(absPath);
  } else {
    throw new Error(`not a file or directory: ${absPath}`);
  }

  return aggregate(absPath, candidates, options);
}

/**
 * Walk a directory for `.json` / `.agentbench` files. Same convention as
 * `validate.collectTraceFiles` — skip dot-files, recurse subdirs, drop
 * `bench.json` because it's a config file, not a trace.
 */
async function collectTraceFiles(absDir: string): Promise<string[]> {
  const out: string[] = [];
  let dirents: Dirent[];
  try {
    dirents = await readdir(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of dirents) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(absDir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collectTraceFiles(full)));
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (TRACE_EXTENSIONS.has(ext) && ent.name !== "bench.json") {
      out.push(full);
    }
  }
  return out;
}

/**
 * Two-pass aggregator. Pass one reads + validates every file and collects
 * raw per-tool latency / argument-size samples. Pass two reduces those
 * samples to the per-tool stats block. Splitting the passes keeps the
 * percentile arithmetic obvious — no streaming quantile estimators to debug.
 */
async function aggregate(
  scannedPath: string,
  files: string[],
  options: ComputeStatsOptions,
): Promise<StatsReport> {
  const skipped: SkippedTrace[] = [];
  const byTraceName: PerTraceSummary[] = [];
  const modelBreakdown: Record<string, number> = {};
  // tool name → samples accumulator
  const toolSamples = new Map<
    string,
    { count: number; latencies: number[]; argumentBytes: number[] }
  >();

  let totalSteps = 0;
  let userSteps = 0;
  let assistantSteps = 0;
  let traceCount = 0;
  let largestTrace: LargestTrace | undefined;

  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      skipped.push({ path: file, reason: `unreadable: ${(err as Error).message}` });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      skipped.push({ path: file, reason: `malformed JSON: ${(err as Error).message}` });
      continue;
    }
    const result = TraceSchema.safeParse(parsed);
    if (!result.success) {
      const first = result.error.issues[0];
      const where = !first || first.path.length === 0 ? "(root)" : first.path.join(".");
      const message = first?.message ?? "unknown schema error";
      skipped.push({ path: file, reason: `schema: ${where}: ${message}` });
      continue;
    }
    const trace = result.data;
    traceCount += 1;
    totalSteps += trace.steps.length;

    const modelKey = trace.model ?? "(none)";
    modelBreakdown[modelKey] = (modelBreakdown[modelKey] ?? 0) + 1;

    byTraceName.push({ name: trace.name, steps: trace.steps.length, modelId: trace.model });

    // Use the raw byte length the parser already saw — matches `wc -c` and
    // doesn't depend on filesystem-stat shenanigans (sparse files, etc.).
    const bytes = Buffer.byteLength(raw, "utf8");
    if (!largestTrace || bytes > largestTrace.bytes) {
      largestTrace = { path: file, steps: trace.steps.length, bytes };
    }

    for (const step of trace.steps) {
      if (step.kind === "user") {
        userSteps += 1;
        continue;
      }
      assistantSteps += 1;
      for (const call of step.toolCalls) {
        const slot = toolSamples.get(call.name) ?? {
          count: 0,
          latencies: [] as number[],
          argumentBytes: [] as number[],
        };
        slot.count += 1;
        if (typeof call.latencyMs === "number") {
          slot.latencies.push(call.latencyMs);
        }
        slot.argumentBytes.push(serialisedArgumentBytes(call.arguments));
        toolSamples.set(call.name, slot);
      }
    }
  }

  // Reduce samples → ToolStats. Latency fields stay undefined if a tool had
  // zero recorded latencies — better to omit than to print a misleading 0.
  const toolBreakdown: ToolStats[] = [];
  for (const [name, slot] of toolSamples) {
    const stats: ToolStats = {
      name,
      count: slot.count,
      avgArgumentsBytes: roundToOneDecimal(mean(slot.argumentBytes)),
    };
    if (slot.latencies.length > 0) {
      const sorted = [...slot.latencies].sort((a, b) => a - b);
      stats.p50LatencyMs = percentile(sorted, 50);
      stats.p95LatencyMs = percentile(sorted, 95);
      stats.maxLatencyMs = sorted[sorted.length - 1];
    }
    toolBreakdown.push(stats);
  }
  // Sort by count desc, then name asc for deterministic output.
  toolBreakdown.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // Apply --top cap if set. Non-positive / undefined means "all tools".
  const top = options.top;
  const cappedToolBreakdown =
    typeof top === "number" && top > 0 ? toolBreakdown.slice(0, top) : toolBreakdown;

  return {
    path: scannedPath,
    traceCount,
    totalSteps,
    userSteps,
    assistantSteps,
    modelBreakdown,
    toolBreakdown: cappedToolBreakdown,
    largestTrace,
    byTraceName,
    skipped,
  };
}

/**
 * Nearest-rank percentile. Given a sorted ascending array and a percentile
 * P in 0..100, returns the value at ceil(P/100 * n) - 1 (0-indexed). Pure;
 * caller must pre-sort.
 *
 * For p95 on a 3-element array this gives index ceil(0.95 * 3) - 1 = 2
 * (the max). That's the expected behaviour: nearest rank doesn't
 * interpolate, so on small samples p95 saturates to the max.
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    throw new Error("percentile of an empty array is undefined");
  }
  if (p <= 0) return sortedAsc[0] as number;
  if (p >= 100) return sortedAsc[sortedAsc.length - 1] as number;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(Math.max(rank - 1, 0), sortedAsc.length - 1);
  return sortedAsc[idx] as number;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function roundToOneDecimal(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Byte length of a JSON-serialised arguments object. Empty objects count as
 * 2 bytes (`{}`) — the honest answer, and consistent with how the trace
 * would be serialised on disk.
 */
function serialisedArgumentBytes(args: Record<string, unknown> | undefined): number {
  if (!args) return 2; // {}
  return Buffer.byteLength(JSON.stringify(args), "utf8");
}

// ---------- Rendering -----------------------------------------------------

/**
 * Render a `StatsReport` as a human-friendly multi-line string. Numeric
 * columns are right-aligned with `tabular-nums`-style padding so digits line
 * up under each other — same readability discipline the typography guide
 * applies to UI tables. Sentence-case headings throughout.
 */
export function formatStats(report: StatsReport): string {
  const lines: string[] = [];

  // ---- Overview ---------------------------------------------------------
  lines.push("Overview");
  const overview: Row[] = [
    ["Path", report.path],
    ["Traces", String(report.traceCount)],
    ["Total steps", String(report.totalSteps)],
    ["User steps", String(report.userSteps)],
    ["Assistant steps", String(report.assistantSteps)],
  ];
  if (report.skipped.length > 0) {
    overview.push(["Skipped (invalid)", String(report.skipped.length)]);
  }
  lines.push(renderTwoCol(overview));
  lines.push("");

  // ---- Models -----------------------------------------------------------
  lines.push("Models");
  const modelEntries = Object.entries(report.modelBreakdown).sort(
    ([a, ac], [b, bc]) => bc - ac || a.localeCompare(b),
  );
  if (modelEntries.length === 0) {
    lines.push("  (none)");
  } else {
    lines.push(
      renderCountTable(
        ["Model", "Traces"],
        modelEntries.map(([m, c]) => [m, c]),
      ),
    );
  }
  lines.push("");

  // ---- Tools ------------------------------------------------------------
  lines.push("Tools");
  if (report.toolBreakdown.length === 0) {
    lines.push("  (no tool calls recorded)");
  } else {
    lines.push(renderToolTable(report.toolBreakdown));
  }
  lines.push("");

  // ---- Largest trace ----------------------------------------------------
  if (report.largestTrace) {
    lines.push("Largest trace");
    lines.push(
      renderTwoCol([
        ["Path", report.largestTrace.path],
        ["Steps", String(report.largestTrace.steps)],
        ["Bytes", formatInt(report.largestTrace.bytes)],
      ]),
    );
    lines.push("");
  }

  // ---- Per-trace summary ------------------------------------------------
  if (report.byTraceName.length > 0) {
    lines.push("Per-trace summary");
    lines.push(
      renderPerTraceTable(report.byTraceName.map((t) => [t.name, t.steps, t.modelId ?? "(none)"])),
    );
    lines.push("");
  }

  // ---- Skipped ----------------------------------------------------------
  if (report.skipped.length > 0) {
    lines.push("Skipped files");
    for (const sk of report.skipped) {
      lines.push(`  · ${sk.path}: ${sk.reason}`);
    }
    lines.push("");
  }

  // Drop the trailing blank so the final line is content, not whitespace.
  return lines.join("\n").replace(/\n+$/, "\n");
}

/**
 * JSON form, stable shape. Trailing newline so it pipes cleanly into `jq`.
 */
export function formatStatsJson(report: StatsReport): string {
  return `${JSON.stringify(
    {
      path: report.path,
      traceCount: report.traceCount,
      totalSteps: report.totalSteps,
      userSteps: report.userSteps,
      assistantSteps: report.assistantSteps,
      modelBreakdown: report.modelBreakdown,
      toolBreakdown: report.toolBreakdown,
      largestTrace: report.largestTrace,
      byTraceName: report.byTraceName,
      skipped: report.skipped,
    },
    null,
    2,
  )}\n`;
}

// ---------- Table helpers (tiny, no deps) ---------------------------------

type Row = [string, string];

/** Render a two-column key/value table with a single space separator. */
function renderTwoCol(rows: Row[]): string {
  if (rows.length === 0) return "";
  const keyWidth = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(keyWidth)}  ${v}`).join("\n");
}

/**
 * Render a two-column table with a numeric right column. Header row + body.
 * Right-aligns the numeric column so digits line up under each other.
 */
function renderCountTable(headers: [string, string], rows: Array<[string, number]>): string {
  const [hName, hCount] = headers;
  const formatted = rows.map(([name, count]) => [name, formatInt(count)]) as Array<
    [string, string]
  >;
  const nameWidth = Math.max(hName.length, ...formatted.map(([n]) => n.length));
  const countWidth = Math.max(hCount.length, ...formatted.map(([, c]) => c.length));
  const out: string[] = [];
  out.push(`  ${hName.padEnd(nameWidth)}  ${hCount.padStart(countWidth)}`);
  out.push(`  ${"-".repeat(nameWidth)}  ${"-".repeat(countWidth)}`);
  for (const [name, count] of formatted) {
    out.push(`  ${name.padEnd(nameWidth)}  ${count.padStart(countWidth)}`);
  }
  return out.join("\n");
}

/** Render the per-tool stats table. All numeric columns right-aligned. */
function renderToolTable(tools: ToolStats[]): string {
  const headers = ["Tool", "Calls", "p50 ms", "p95 ms", "Max ms", "Avg args B"];
  const body = tools.map((t) => [
    t.name,
    formatInt(t.count),
    t.p50LatencyMs === undefined ? "—" : formatInt(t.p50LatencyMs),
    t.p95LatencyMs === undefined ? "—" : formatInt(t.p95LatencyMs),
    t.maxLatencyMs === undefined ? "—" : formatInt(t.maxLatencyMs),
    formatNum(t.avgArgumentsBytes),
  ]);
  return renderAlignedTable(headers, body, ["left", "right", "right", "right", "right", "right"]);
}

/** Render the per-trace summary table. Steps right-aligned. */
function renderPerTraceTable(rows: Array<[string, number, string]>): string {
  const headers = ["Name", "Steps", "Model"];
  const body = rows.map(([name, steps, model]) => [name, formatInt(steps), model]);
  return renderAlignedTable(headers, body, ["left", "right", "left"]);
}

type Align = "left" | "right";

/**
 * Generic aligned-column table renderer. Two-space gutter between columns.
 * Header + ASCII separator + body. No box-drawing characters — keeps copy /
 * paste into a PR comment lossless.
 */
function renderAlignedTable(headers: string[], rows: string[][], aligns: Align[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) =>
        aligns[i] === "right" ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0),
      )
      .join("  ");
  const out: string[] = [];
  out.push(`  ${fmt(headers)}`);
  out.push(`  ${widths.map((w) => "-".repeat(w)).join("  ")}`);
  for (const row of rows) {
    out.push(`  ${fmt(row)}`);
  }
  return out.join("\n");
}

/** Integer with thousands grouping — `1234567` → `1,234,567`. */
function formatInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** One-decimal float with thousands grouping — `12.3` stays `12.3`. */
function formatNum(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
