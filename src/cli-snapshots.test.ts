/**
 * CLI-output snapshot tests — pin the rendered, human-readable bytes that
 * `agentbench` writes to stdout for every command's typical invocation.
 * Inspired by `biomejs/biome` and `vitest-dev/vitest`, both of which
 * snapshot-test their CLI output extensively so a stray space, swapped
 * column, or renamed flag fails CI loudly instead of shipping.
 *
 * Strategy B — we import each command's underlying module + formatter and
 * replicate the tiny decoration the CLI's action handler applies (the
 * green `✓` / yellow `dry-run` mark, the trailing newline). Snapshots
 * are inline so the diff lives next to the test — no orphan `__snapshots__`
 * folder, no hunting for stale fixtures at review time.
 *
 * Determinism: every absolute path is redacted to `<tmp>`, every ISO 8601
 * timestamp to `<ts>`, ANSI is stripped, CRLF is normalised. See
 * `test-utils/render-cli.ts` for the exact transformations.
 */
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { compareTraces, formatReport } from "./compare.js";
import { exportTrace, formatExport } from "./export.js";
import { formatHead, headTrace } from "./head.js";
import { initBench } from "./init.js";
import { formatList, listBench } from "./list.js";
import { formatMerge, mergeTraces } from "./merge.js";
import { replayTrace } from "./replay.js";
import { computeStats, formatStats } from "./stats.js";
import { renderCommand } from "./test-utils/render-cli.js";
import { parseTrace } from "./trace.js";
import { formatValidate, validateAgentbenchFile } from "./validate.js";

let workDir: string;

beforeEach(async () => {
  // Same macOS quirk every other test file handles: `mkdtemp(tmpdir())` on
  // darwin returns `/var/folders/...` which is a symlink to `/private/var/...`.
  // Without `realpathSync` the `<tmp>` redaction misses one of the two
  // and the snapshot drifts run-to-run.
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-cli-snap-")));
});

async function writeTrace(name: string, body: unknown): Promise<string> {
  const full = path.join(workDir, name);
  await writeFile(full, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return full;
}

/** Small fixture used across multiple commands. */
function smallTrace() {
  return {
    name: "demo",
    model: "claude-sonnet-4-6",
    steps: [
      { kind: "user", content: "hello there" },
      {
        kind: "assistant",
        content: "looking that up",
        toolCalls: [{ name: "search_kb", arguments: { q: "refund" } }],
      },
      { kind: "user", content: "thanks" },
    ],
  };
}

/** A "drifted" version of `smallTrace` for the compare snapshot. */
function smallTraceDrifted() {
  return {
    name: "demo",
    model: "claude-sonnet-4-6",
    steps: [
      { kind: "user", content: "hello there" },
      {
        kind: "assistant",
        // Content changed → assistant-content diff.
        content: "checking that for you",
        toolCalls: [{ name: "search_kb", arguments: { q: "refund" } }],
      },
      { kind: "user", content: "thanks" },
    ],
  };
}

/** Captures NDJSON written by `replayTrace` into an in-memory string. */
class StringWritable extends Writable {
  buf = "";
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    cb();
  }
}

describe("CLI output snapshots — head", () => {
  it("`head` on a 3-step trace, default n=5, renders the human preview", async () => {
    const t = await writeTrace("demo.json", smallTrace());

    const rendered = await renderCommand(
      async () => {
        // Mirror what `cli.ts`'s `head` action does: call `headTrace` then
        // `formatHead`, write the rendered string to stdout (no extra
        // newline — `formatHead` already terminates with one).
        const result = await headTrace({ tracePath: t });
        return { stdout: formatHead(result) };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).toMatchInlineSnapshot(`
      "demo · claude-sonnet-4-6
      3 of 3 steps

      [1] user: hello there
      [2] assistant: looking that up · tools: search_kb
      [3] user: thanks
      "
    `);
  });

  it("`head -n 2` clips to the first two steps", async () => {
    const t = await writeTrace("demo.json", smallTrace());

    const rendered = await renderCommand(
      async () => {
        const result = await headTrace({ tracePath: t, n: 2 });
        return { stdout: formatHead(result) };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.stdout).toMatchInlineSnapshot(`
      "demo · claude-sonnet-4-6
      2 of 3 steps

      [1] user: hello there
      [2] assistant: looking that up · tools: search_kb
      "
    `);
  });
});

describe("CLI output snapshots — stats", () => {
  it("`stats <trace>` renders the human-friendly tables", async () => {
    const t = await writeTrace("demo.json", smallTrace());

    const rendered = await renderCommand(
      async () => {
        const report = await computeStats(t);
        // Match the CLI's `${formatStats(report)}\n` wrap.
        return { stdout: `${formatStats(report)}\n` };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.stdout).toMatchInlineSnapshot(`
      "Overview
        Path             <tmp>/demo.json
        Traces           1
        Total steps      3
        User steps       2
        Assistant steps  1

      Models
        Model              Traces
        -----------------  ------
        claude-sonnet-4-6       1

      Tools
        Tool       Calls  p50 ms  p95 ms  Max ms  Avg args B
        ---------  -----  ------  ------  ------  ----------
        search_kb      1       —       —       —        14.0

      Largest trace
        Path   <tmp>/demo.json
        Steps  3
        Bytes  415

      Per-trace summary
        Name  Steps  Model            
        ----  -----  -----------------
        demo      3  claude-sonnet-4-6

      "
    `);
  });
});

describe("CLI output snapshots — compare", () => {
  it("`compare` on identical traces emits the green-check single-line OK", async () => {
    const base = await writeTrace("baseline.json", smallTrace());
    const cur = await writeTrace("current.json", smallTrace());

    const rendered = await renderCommand(
      async () => {
        const [b, c] = await Promise.all([
          readFile(base, "utf8").then(parseTrace),
          readFile(cur, "utf8").then(parseTrace),
        ]);
        const report = compareTraces(b, c);
        // Mirror cli.ts: `${kleur.green("✓")} ${formatReport(report)}\n`.
        return { stdout: `✓ ${formatReport(report)}\n`, exitCode: 0 };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).toMatchInlineSnapshot(`
      "✓ traces are structurally identical
      "
    `);
  });

  it("`compare` on a drifted trace emits the red-cross + diff lines", async () => {
    const base = await writeTrace("baseline.json", smallTrace());
    const cur = await writeTrace("current.json", smallTraceDrifted());

    const rendered = await renderCommand(
      async () => {
        const [b, c] = await Promise.all([
          readFile(base, "utf8").then(parseTrace),
          readFile(cur, "utf8").then(parseTrace),
        ]);
        const report = compareTraces(b, c);
        return { stdout: `✗ ${formatReport(report)}\n`, exitCode: 1 };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.exitCode).toBe(1);
    expect(rendered.stdout).toMatchInlineSnapshot(`
      "✗ 1 differences found:
        · step #1 assistant content differs
      "
    `);
  });
});

describe("CLI output snapshots — replay", () => {
  it("`replay` writes one NDJSON line per step to stdout", async () => {
    const t = await writeTrace("demo.json", smallTrace());

    const rendered = await renderCommand(
      async () => {
        const sink = new StringWritable();
        await replayTrace({ tracePath: t, out: sink });
        return { stdout: sink.buf };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.stdout).toMatchInlineSnapshot(`
      "{"index":1,"kind":"user","content":"hello there"}
      {"index":2,"kind":"assistant","content":"looking that up","toolCalls":[{"name":"search_kb","arguments":{"q":"refund"}}]}
      {"index":3,"kind":"user","content":"thanks"}
      "
    `);
  });

  it("`replay --since 2 --kind assistant` filters to one event", async () => {
    const t = await writeTrace("demo.json", smallTrace());

    const rendered = await renderCommand(
      async () => {
        const sink = new StringWritable();
        await replayTrace({ tracePath: t, out: sink, since: 2, kind: "assistant" });
        return { stdout: sink.buf };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.stdout).toMatchInlineSnapshot(`
      "{"index":2,"kind":"assistant","content":"looking that up","toolCalls":[{"name":"search_kb","arguments":{"q":"refund"}}]}
      "
    `);
  });
});

describe("CLI output snapshots — validate", () => {
  it("`validate <trace>` on a clean trace prints the OK summary", async () => {
    const t = await writeTrace("demo.json", smallTrace());

    const rendered = await renderCommand(
      async () => {
        const result = await validateAgentbenchFile(t);
        // CLI wraps with `${mark} ${formatValidate(result)}\n`.
        const mark = result.ok ? "✓" : "✗";
        return { stdout: `${mark} ${formatValidate(result)}\n`, exitCode: result.ok ? 0 : 1 };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).toMatchInlineSnapshot(`
      "✓ demo.json: ok

      1 file: 1 ok
      "
    `);
  });

  it("`validate <broken>` surfaces the schema error in the human report", async () => {
    // Missing `steps` — zod will reject.
    const broken = await writeTrace("broken.json", { name: "broken" });

    const rendered = await renderCommand(
      async () => {
        const result = await validateAgentbenchFile(broken);
        const mark = result.ok ? "✓" : "✗";
        return { stdout: `${mark} ${formatValidate(result)}\n`, exitCode: result.ok ? 0 : 1 };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.exitCode).toBe(1);
    expect(rendered.stdout).toMatchInlineSnapshot(`
      "✗ broken.json: 1 error
        · error at steps: expected array, got undefined

      1 file: 1 failed
      "
    `);
  });
});

describe("CLI output snapshots — list", () => {
  it("`list <bench>` prints the table of baselines + recordings", async () => {
    // Scaffold a real bench and seed it with a single baseline so the
    // table has something to render. We avoid timestamps in the snapshot
    // by redacting the ISO mtime to `<ts>` in the helper.
    const benchDir = path.join(workDir, "demo-bench");
    await initBench({ name: "demo-bench", outputDir: workDir });
    await writeFile(
      path.join(benchDir, "baselines", "hello.json"),
      `${JSON.stringify(smallTrace(), null, 2)}\n`,
      "utf8",
    );

    const rendered = await renderCommand(
      async () => {
        const result = await listBench(benchDir);
        return { stdout: `${formatList(result)}\n` };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.stdout).toMatchInlineSnapshot(`
      "NAME                  TYPE      SIZE  MODIFIED
      baselines/hello.json  baseline  416B  <ts>
      "
    `);
  });

  it("`list <empty-bench>` prints the friendly empty-state line", async () => {
    const benchDir = path.join(workDir, "empty-bench");
    await initBench({ name: "empty-bench", outputDir: workDir });

    const rendered = await renderCommand(
      async () => {
        const result = await listBench(benchDir);
        return { stdout: `${formatList(result)}\n` };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.stdout).toMatchInlineSnapshot(`
      "no recordings yet in empty-bench — drop traces into baselines/ or recordings/
      "
    `);
  });
});

describe("CLI output snapshots — export", () => {
  it("`export --format md` writes the markdown and prints the receipt", async () => {
    const t = await writeTrace("demo.json", smallTrace());

    const rendered = await renderCommand(
      async () => {
        const result = await exportTrace({ tracePath: t, format: "markdown" });
        return { stdout: `✓ ${formatExport(result)}\n` };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.stdout).toMatchInlineSnapshot(`
      "✓ wrote <tmp>/demo.md (markdown, 252 bytes)
      "
    `);
  });

  it("`export --format json` writes the canonicalised trace and prints the receipt", async () => {
    const t = await writeTrace("demo.json", smallTrace());

    const rendered = await renderCommand(
      async () => {
        const result = await exportTrace({ tracePath: t, format: "json" });
        return { stdout: `✓ ${formatExport(result)}\n` };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.stdout).toMatchInlineSnapshot(`
      "✓ wrote <tmp>/demo.json (json, 416 bytes)
      "
    `);
  });
});

describe("CLI output snapshots — merge", () => {
  it("`merge a b --out merged.json` prints the merged summary", async () => {
    const a = await writeTrace("a.json", smallTrace());
    const b = await writeTrace("b.json", {
      name: "second",
      model: "claude-sonnet-4-6",
      steps: [{ kind: "user", content: "from b" }],
    });
    const out = path.join(workDir, "merged.json");

    const rendered = await renderCommand(
      async () => {
        const result = await mergeTraces({ inputPaths: [a, b], outPath: out });
        return { stdout: `✓ ${formatMerge(result)}\n` };
      },
      { tmpPrefix: workDir },
    );

    expect(rendered.stdout).toMatchInlineSnapshot(`
      "✓ wrote <tmp>/merged.json
      sources: 2
      steps: 4
      "
    `);
  });
});
