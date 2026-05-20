<div align="center">

# agentbench

**Snapshot tests for AI agent traces.**
Your agent regression suite — framework-agnostic.

[![status](https://img.shields.io/badge/status-pre--release-yellow?style=flat-square)](https://github.com/adityachilka1/agentbench)
[![license](https://img.shields.io/badge/license-MIT-000?style=flat-square)](./LICENSE)

</div>

> **Status — pre-alpha.** No working code yet. Star to follow the v0.1 milestone (target: Q3 2026). Pre-release issues + ideas welcome in Discussions.

---

## Why

Agents drift. You tweak a prompt, swap a model, upgrade a framework — and three weeks later you notice the customer-support flow is taking 12 tool calls instead of 4, or returning the wrong currency. There's no equivalent of Jest's snapshot testing for agent runs.

`agentbench` is exactly that:

```ts
import { snapshot } from "agentbench";

test("returns refund policy in EUR for German users", async () => {
  const trace = await runAgent({ user: "de-DE", query: "How do I get a refund?" });
  await snapshot(trace).matches("refund-policy-eur");
});
```

The trace is compared not byte-for-byte but **semantically** — a small open model judges whether the new run accomplishes the same goal in the same steps. Fast (sub-second on cached traces), deterministic on a fixed seed, and free of LLM-as-judge flakiness because the rubric is committed to your repo.

## Why "framework-agnostic"

It works with whatever you use:

- **CrewAI** — adapter ships in `@agentbench/crewai`
- **LangGraph** — `@agentbench/langgraph`
- **Mastra** — `@agentbench/mastra`
- **OpenAI Agents SDK** — `@agentbench/openai-agents`
- **Anything else** — the core API just takes an array of `{ role, content, tool_calls }` objects

## Roadmap

- [ ] Core snapshot engine + CLI
- [ ] Framework adapters (CrewAI, LangGraph, Mastra, OpenAI Agents SDK)
- [ ] GitHub Action: comment a diff on every PR
- [ ] Trace browser UI (built on top of [`mcp-devtools`](https://github.com/adityachilka1/mcp-devtools))
- [ ] Cost / latency budgets per test

## Companion projects

- [`mcp-devtools`](https://github.com/adityachilka1/mcp-devtools) — Chrome DevTools for the Model Context Protocol.
- [`skillforge`](https://github.com/adityachilka1/skillforge) — CLI + open registry for Claude Skills.

## License

[MIT](./LICENSE) © 2026 Aditya Chilka.
