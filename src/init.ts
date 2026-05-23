/**
 * `agentbench init [name]` — scaffold a bench directory.
 *
 * A "bench" is a folder that holds one or more recorded `Trace` baselines
 * plus the runs they're compared against. The scaffold gives you a known
 * layout so `agentbench compare` and future tooling (semantic compare,
 * GitHub Action) can discover baselines without you wiring paths each time.
 *
 * Produces:
 *
 *   <name>/
 *     bench.json
 *     baselines/.gitkeep
 *     recordings/.gitkeep
 *     README.md
 *     .gitignore
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface InitOptions {
  /** Bench name. Required. Used as the directory name and bench.json `name`. */
  name: string;
  /** Where to create the bench dir. Defaults to `process.cwd()`. */
  outputDir?: string;
  /** Overwrite an existing `bench.json` when true. Defaults to false. */
  force?: boolean;
}

export interface BenchConfig {
  name: string;
  version: string;
  baselineDir: string;
  recordingsDir: string;
  tolerances: {
    extraFrames: number;
    missingFrames: number;
  };
}

export interface InitResult {
  /** Absolute path to the bench dir that was created. */
  benchDir: string;
  /** Absolute paths of every file written. */
  filesWritten: string[];
  /** The config that was serialised to bench.json. */
  config: BenchConfig;
}

/**
 * Build the default config for a bench. Pure — no I/O.
 * Exposed for tests and for callers that want to render the config
 * without touching disk.
 */
export function defaultBenchConfig(name: string): BenchConfig {
  return {
    name,
    version: "0.0.1",
    baselineDir: "baselines",
    recordingsDir: "recordings",
    tolerances: {
      extraFrames: 0,
      missingFrames: 0,
    },
  };
}

/**
 * Render the bench README. Pure — no I/O.
 * Mentions `agentbench compare` so users know how to diff against a baseline.
 */
export function renderBenchReadme(name: string): string {
  return `# ${name}

An \`agentbench\` bench — a folder of recorded agent traces plus the runs
they're compared against.

## Layout

- \`bench.json\` — bench config (name, version, dir layout, tolerances).
- \`baselines/\` — known-good \`Trace\` snapshots, committed to git.
- \`recordings/\` — fresh runs captured during CI or local development.
  Compared against the matching baseline to surface drift.

## Record a baseline

Baselines are \`Trace\` JSON files that you save the first time an agent
flow gets the answer right. Emit a trace from your harness and write it to
\`baselines/<flow-name>.json\`:

\`\`\`ts
import { writeFile } from "node:fs/promises";
import { serializeTrace, type Trace } from "@adityachilka/agentbench";

const trace: Trace = await runAgent({ query: "refund policy?" });
await writeFile("baselines/refund-policy.json", serializeTrace(trace));
\`\`\`

Commit that file. It is now the contract.

## Diff a run against the baseline

After a model bump, re-run the flow, save the new trace to
\`recordings/<flow-name>.json\`, and compare:

\`\`\`bash
agentbench compare baselines/refund-policy.json recordings/refund-policy.json
\`\`\`

Exits \`0\` if structurally identical, \`1\` on any difference. Drop into CI:

\`\`\`yaml
- run: npx @adityachilka/agentbench compare baselines/refund-policy.json recordings/refund-policy.json
\`\`\`

## Tolerances

\`bench.json\` carries a \`tolerances\` block for future use — extra or
missing frames the compare should treat as non-fatal. v0.0.1 compare is
strict (any drift fails); v0.1 will honour these knobs.
`;
}

/** Default `.gitignore` body for a scaffolded bench. */
export function renderBenchGitignore(): string {
  return ["node_modules", "*.log", ".DS_Store", ""].join("\n");
}

/**
 * Scaffold a new bench directory.
 *
 * Refuses to overwrite an existing `bench.json` unless `force: true`. Creates
 * parent dirs as needed. Returns the absolute path of every file written so
 * callers can render a summary.
 */
export async function initBench(options: InitOptions): Promise<InitResult> {
  const name = options.name.trim();
  if (!name) {
    throw new Error("bench name must not be empty");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`invalid bench name: ${options.name}`);
  }

  const outputDir = options.outputDir ?? process.cwd();
  const benchDir = path.resolve(outputDir, name);
  const benchJsonPath = path.join(benchDir, "bench.json");

  if (!options.force && (await exists(benchJsonPath))) {
    throw new Error(
      `bench.json already exists at ${benchJsonPath} — re-run with --force to overwrite`,
    );
  }

  const config = defaultBenchConfig(name);

  await mkdir(path.join(benchDir, config.baselineDir), { recursive: true });
  await mkdir(path.join(benchDir, config.recordingsDir), { recursive: true });

  const baselineKeep = path.join(benchDir, config.baselineDir, ".gitkeep");
  const recordingsKeep = path.join(benchDir, config.recordingsDir, ".gitkeep");
  const readmePath = path.join(benchDir, "README.md");
  const gitignorePath = path.join(benchDir, ".gitignore");

  await writeFile(benchJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(baselineKeep, "", "utf8");
  await writeFile(recordingsKeep, "", "utf8");
  await writeFile(readmePath, renderBenchReadme(name), "utf8");
  await writeFile(gitignorePath, renderBenchGitignore(), "utf8");

  return {
    benchDir,
    filesWritten: [benchJsonPath, baselineKeep, recordingsKeep, readmePath, gitignorePath],
    config,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}
