/**
 * `agentbench` CLI. v0.0.1 ships one command: `compare`.
 *
 *   agentbench compare baseline.json current.json
 *
 * Exits 0 if traces are structurally identical, 1 if any differences found.
 * Designed to drop straight into CI.
 */
import { readFile } from "node:fs/promises";
import { cac } from "cac";
import kleur from "kleur";
import { compareTraces, formatReport } from "./compare.js";
import { parseTrace } from "./trace.js";

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

cli.help();
cli.version(VERSION);
cli.parse();
