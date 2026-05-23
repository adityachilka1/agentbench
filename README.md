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
```

| Command | Purpose |
|---|---|
| `agentbench init [name]` | Scaffold a bench dir (`bench.json`, `baselines/`, `recordings/`). |
| `agentbench list [dir]` | List every baseline + recording in a bench. `--json` for machine output. |
| `agentbench validate <path>` | Schema-check a trace file (or every trace in a dir) before compare runs. `--json` for machine output. |
| `agentbench compare <baseline> <current>` | Structurally diff two trace files. Exit `1` on any drift. |

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
