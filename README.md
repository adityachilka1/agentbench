<div align="center">

# agentbench

**Snapshot tests for AI agent traces.**
Framework-agnostic. Record once, replay across model upgrades, fail CI on drift.

[![npm](https://img.shields.io/npm/v/@adityachilka/agentbench?style=flat-square&color=000)](https://www.npmjs.com/package/@adityachilka/agentbench)
[![ci](https://img.shields.io/github/actions/workflow/status/adityachilka1/agentbench/ci.yml?style=flat-square&color=000)](https://github.com/adityachilka1/agentbench/actions)
[![license](https://img.shields.io/npm/l/@adityachilka/agentbench?style=flat-square&color=000)](./LICENSE)

</div>

---

> **Status — v0.0.1, early days.** Trace schema + structural `compare` ship today. Semantic equivalence, framework adapters (CrewAI / LangGraph / Mastra / OpenAI Agents SDK), and the GitHub Action land in v0.1.

## Why

Agents drift. You tweak a prompt, swap a model, upgrade a framework — and three weeks later you find out the support flow is taking 12 tool calls instead of 4, or returning the wrong currency. There's no equivalent of Jest snapshot testing for agent runs.

`agentbench` is the framework-agnostic primitive: a `Trace` shape that any agent runtime can emit, plus a `compareTraces` function that catches divergence at the step, content, and tool-call level.

## Install

```bash
npm install @adityachilka/agentbench
# or
pnpm add @adityachilka/agentbench
```

## Use — CLI

```bash
# Scaffold a bench directory:
agentbench init my-bench

# Inspect what's recorded so far:
agentbench list my-bench

# Schema-check a baseline before CI relies on it:
agentbench validate my-bench/baselines/refund-policy.json

# Record a baseline (via your test harness — see the programmatic API below).
# Then later, after a model bump:
agentbench compare baseline.json current.json

# If the drift was intentional, promote the recording to be the new baseline:
agentbench bless recordings/refund-policy.json --bench my-bench

# Before sharing a trace (bug report, blog post), strip out PII / secrets:
agentbench redact recordings/refund-policy.json --out share.json

# Pretty-print a trace as Markdown / HTML / JSON for a PR comment or design review:
agentbench export recordings/refund-policy.json                     # writes refund-policy.md
agentbench export recordings/refund-policy.json --format html       # writes refund-policy.html
agentbench export recordings/refund-policy.json --format json --out share.json

# Summary stats for a trace or a whole bench dir:
agentbench stats my-bench/recordings                                 # human-readable tables
agentbench stats my-bench --json | jq .                              # machine output for CI dashboards
```

| Command | Purpose |
|---|---|
| `agentbench init [name]` | Scaffold a bench dir (`bench.json`, `baselines/`, `recordings/`). |
| `agentbench list [dir]` | List every baseline + recording in a bench. `--json` for machine output. |
| `agentbench validate <path>` | Schema-check a trace file (or every trace in a dir) before compare runs. `--json` for machine output. |
| `agentbench compare <baseline> <current>` | Structurally diff two trace files. Exit `1` on any drift. |
| `agentbench bless <recording>` | Promote a recording to be the new baseline. `--force` to overwrite, `--name` to rename, `--dry-run` to preview. |
| `agentbench redact <trace>` | Strip emails, API keys, JWTs, and common PII fields before sharing a trace. `--out` to set the destination, `--rules` for custom patterns, `--dry-run` to preview, `--json` for machine output. Regex-based detection is best-effort — always eyeball the output. |
| `agentbench export <trace>` | Pretty-print a recorded trace as Markdown (default), HTML (self-contained, no JS), or pretty JSON. `--format md|html|json` selects the output; `--out <path>` overrides the default `<basename>.{md|html|json}` sibling. Validates the trace before rendering — refuses to export an invalid file. |
| `agentbench stats [path]` | Print summary statistics for a single trace or a directory of traces (recursive). Reports step counts, model breakdown, per-tool call counts with p50 / p95 / max latency, average serialised argument size, and the largest trace in the set. `--json` for machine output, `--top <N>` to cap the tool table (default 10). Skips invalid traces with a warning rather than aborting the run. |

### The bless workflow

`compare` shows red — but red doesn't always mean broken. Sometimes the agent improved, you renamed a tool, or the user-facing copy changed. `bless` is the deliberate act that promotes the new recording to be the contract:

```bash
# 1. Compare current run against the old baseline — drift detected.
agentbench compare my-bench/baselines/refund.json my-bench/recordings/refund.json
# ✗ 2 differences found …

# 2. Eyeball the diff. If it's intentional, bless the recording.
agentbench bless refund.json --bench my-bench

# 3. Re-compare — green.
agentbench compare my-bench/baselines/refund.json my-bench/recordings/refund.json
# ✓ traces are structurally identical
```

`bless` refuses to overwrite an existing baseline without `--force` (intentional friction — silent overwrite would defeat the safeguard `compare` is meant to provide) and refuses to bless a recording that fails schema validation (a broken baseline poisons every future compare).

Exits `0` if structurally identical, `1` on any difference. Drop into CI:

```yaml
- run: npx @adityachilka/agentbench compare ./traces/golden.json ./traces/run.json
```

## Use — programmatic

```ts
import { compareTraces, type Trace, formatReport } from "@adityachilka/agentbench";

const baseline: Trace = JSON.parse(await readFile("baseline.json", "utf8"));
const current: Trace = await runAgent({ query: "refund policy?" });

const report = compareTraces(baseline, current);
if (!report.identical) {
  console.error(formatReport(report));
  process.exit(1);
}
```

## Trace format

```jsonc
{
  "name": "refund-policy",
  "model": "claude-sonnet-4-6",
  "steps": [
    { "kind": "user", "content": "What is your refund policy?" },
    {
      "kind": "assistant",
      "content": "Let me look that up.",
      "toolCalls": [
        { "name": "search_kb", "arguments": { "query": "refund policy" } }
      ]
    }
  ]
}
```

Validated with Zod. Unknown fields in `meta` are preserved. The CLI throws clearly on malformed input.

## What's NOT in v0.0.1

- **Semantic equivalence.** Today's compare is structural: same steps, same kinds, same tool calls, same content. v0.1 will judge "did this run accomplish the same goal" via a small open model, not byte-equality.
- **Framework adapters.** v0.1 ships `@agentbench/crewai`, `@agentbench/langgraph`, `@agentbench/mastra`, `@agentbench/openai-agents` so you don't have to hand-build the `Trace` shape.
- **GitHub Action.** v0.1 will comment a diff on every PR.

## Roadmap

- **v0.0.1** — `Trace` schema, `compareTraces`, CLI ✓ (this release)
- **v0.1** — framework adapters, semantic compare, GitHub Action
- **v0.2** — trace browser UI (built on top of [`mcp-devtools`](https://github.com/adityachilka1/mcp-devtools))
- **v0.3** — cost / latency budgets per test

## Companion projects

- [`mcp-devtools`](https://github.com/adityachilka1/mcp-devtools) — Chrome DevTools for the Model Context Protocol.
- [`skillforge`](https://github.com/adityachilka1/skillforge) — CLI for authoring Claude Skills.

## License

[MIT](./LICENSE) © 2026 Aditya Chilka.
