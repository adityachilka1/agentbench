/**
 * `agentbench` CLI. Commands:
 *
 *   agentbench compare <baseline> <current>   diff two trace files
 *   agentbench init [name]                    scaffold a bench directory
 *   agentbench list [dir]                     list baselines + recordings in a bench
 *   agentbench validate <path>                schema-check a trace file or dir
 *   agentbench bless <recording>              promote a recording to a baseline
 *   agentbench redact <trace>                 strip sensitive fields from a trace
 *   agentbench export <trace>                 render a trace as markdown / html / json
 *
 * Exits 0 on success, 1 on failure. Designed to drop straight into CI.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { cac } from "cac";
import kleur from "kleur";
import { blessRecording } from "./bless.js";
import { compareTraces, formatReport } from "./compare.js";
import { type ExportFormat, exportTrace, formatExport } from "./export.js";
import { initBench } from "./init.js";
import { formatList, formatListJson, listBench } from "./list.js";
import { formatRedact, formatRedactJson, loadRulesFile, redactTrace } from "./redact.js";
import { parseTrace } from "./trace.js";
import { formatValidate, formatValidateJson, validateAgentbenchFile } from "./validate.js";

const VERSION = "0.0.1";
const cli = cac("agentbench");

cli
  .command("compare <baseline> <current>", "Compare two trace files")
  .action(async (baselinePath: string, currentPath: string) => {
    try {
      const [baseline, current] = await Promise.all([
        readFile(baselinePath, "utf8").then(parseTrace),
        readFile(currentPath, "utf8").then(parseTrace),
      ]);
      const report = compareTraces(baseline, current);
      if (report.identical) {
        process.stdout.write(`${kleur.green("✓")} ${formatReport(report)}\n`);
        process.exit(0);
      }
      process.stdout.write(`${kleur.red("✗")} ${formatReport(report)}\n`);
      process.exit(1);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command("init [name]", "Scaffold a new bench directory")
  .option("--out <dir>", "Parent directory to scaffold into (default: cwd)")
  .option("--force", "Overwrite an existing bench.json")
  .action(async (name: string | undefined, opts: { out?: string; force?: boolean }) => {
    try {
      const benchName = (name ?? path.basename(process.cwd())).trim();
      const result = await initBench({
        name: benchName,
        outputDir: opts.out,
        force: opts.force,
      });
      const rel = path.relative(process.cwd(), result.benchDir) || ".";
      process.stdout.write(`${kleur.green("✓")} scaffolded bench at ${rel}\n`);
      for (const file of result.filesWritten) {
        process.stdout.write(`  · ${path.relative(process.cwd(), file)}\n`);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command("list [dir]", "List baselines + recordings in a bench")
  .option("--json", "Emit machine-readable JSON instead of a table")
  .action(async (dir: string | undefined, opts: { json?: boolean }) => {
    try {
      const target = dir ?? "./agentbench-tests";
      const result = await listBench(target);
      if (opts.json) {
        process.stdout.write(formatListJson(result));
      } else {
        process.stdout.write(`${formatList(result)}\n`);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command("validate <path>", "Schema-check a trace file or directory of trace files")
  .option("--json", "Emit machine-readable JSON instead of a human-friendly report")
  .action(async (target: string, opts: { json?: boolean }) => {
    try {
      const result = await validateAgentbenchFile(target);
      if (opts.json) {
        process.stdout.write(formatValidateJson(result));
      } else {
        const mark = result.ok ? kleur.green("✓") : kleur.red("✗");
        process.stdout.write(`${mark} ${formatValidate(result)}\n`);
      }
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command("bless <recording>", "Promote a recording to be the new baseline")
  .option("--bench <dir>", "Path to the bench dir (default: cwd)")
  .option("--name <baseline-name>", "Override the destination baseline filename")
  .option("--force", "Overwrite an existing baseline")
  .option("--dry-run", "Report what would happen without writing anything")
  .action(
    async (
      recording: string,
      opts: { bench?: string; name?: string; force?: boolean; dryRun?: boolean },
    ) => {
      try {
        const benchDir = opts.bench ?? process.cwd();
        const result = await blessRecording({
          benchDir,
          recordingPath: recording,
          baselineName: opts.name,
          force: opts.force,
          dryRun: opts.dryRun,
        });
        const recRel = path.relative(process.cwd(), result.recordingPath) || result.recordingPath;
        const baseRel = path.relative(process.cwd(), result.baselinePath) || result.baselinePath;
        if (result.dryRun) {
          process.stdout.write(`${kleur.yellow("dry-run")} would bless ${recRel} → ${baseRel}\n`);
        } else {
          process.stdout.write(`${kleur.green("✓")} blessed ${recRel} → ${baseRel}\n`);
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
        process.exit(1);
      }
    },
  );

cli
  .command("redact <trace>", "Strip sensitive fields from a recorded trace before sharing")
  .option("--out <path>", "Where to write the redacted file (default: <basename>.redacted.<ext>)")
  .option("--rules <path>", "JSON file with extra { patterns?, piiKeys? } layered on the defaults")
  .option("--dry-run", "Report what would be redacted without writing anything")
  .option("--json", "Emit machine-readable JSON instead of a human-friendly report")
  .action(
    async (
      tracePath: string,
      opts: { out?: string; rules?: string; dryRun?: boolean; json?: boolean },
    ) => {
      try {
        const rules = opts.rules ? await loadRulesFile(opts.rules) : undefined;
        const result = await redactTrace({
          tracePath,
          outPath: opts.out,
          rules,
          dryRun: opts.dryRun,
        });
        if (opts.json) {
          process.stdout.write(formatRedactJson(result));
        } else {
          const mark = result.dryRun ? kleur.yellow("dry-run") : kleur.green("✓");
          process.stdout.write(`${mark} ${formatRedact(result)}\n`);
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
        process.exit(1);
      }
    },
  );

cli
  .command("export <trace>", "Render a recorded trace as markdown / html / json")
  .option("--format <format>", "Output format: md | markdown | html | json (default: md)")
  .option("--out <path>", "Where to write the rendered file (default: <basename>.{md|html|json})")
  .action(async (tracePath: string, opts: { format?: string; out?: string }) => {
    try {
      const format = resolveExportFormat(opts.format);
      const result = await exportTrace({
        tracePath,
        format,
        outPath: opts.out,
      });
      process.stdout.write(`${kleur.green("✓")} ${formatExport(result)}\n`);
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

/**
 * Normalise the user-facing --format string into the canonical
 * `ExportFormat` union the renderer accepts. `md` is the common shorthand
 * users will type; treat it as a synonym for `markdown`. Unknown values
 * throw a clear error rather than silently falling through to a default.
 */
function resolveExportFormat(raw: string | undefined): ExportFormat {
  if (raw === undefined || raw === "") return "markdown";
  const lower = raw.toLowerCase();
  if (lower === "md" || lower === "markdown") return "markdown";
  if (lower === "html") return "html";
  if (lower === "json") return "json";
  throw new Error(`unknown --format value: ${raw} (expected one of: md, markdown, html, json)`);
}

cli.help();
cli.version(VERSION);
cli.parse();
