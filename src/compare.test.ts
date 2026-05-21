import { describe, expect, it } from "vitest";
import { compareTraces, formatReport } from "./compare.js";
import type { Trace } from "./trace.js";

const baseTrace: Trace = {
  name: "refund-policy",
  model: "claude-sonnet-4-6",
  steps: [
    { kind: "user", content: "What is your refund policy?" },
    {
      kind: "assistant",
      content: "Let me look that up.",
      toolCalls: [{ name: "search_kb", arguments: { query: "refund policy" } }],
    },
    { kind: "user", content: "And in EUR?" },
    {
      kind: "assistant",
      content: "Same — 14 days, full refund.",
      toolCalls: [],
    },
  ],
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("compareTraces", () => {
  it("returns identical when two traces are byte-equal", () => {
    const r = compareTraces(baseTrace, clone(baseTrace));
    expect(r.identical).toBe(true);
    expect(r.differences).toEqual([]);
  });

  it("detects step-count mismatch", () => {
    const shorter = clone(baseTrace);
    shorter.steps = shorter.steps.slice(0, 2);
    const r = compareTraces(baseTrace, shorter);
    expect(r.identical).toBe(false);
    expect(r.differences[0]).toMatchObject({ kind: "step-count", expected: 4, actual: 2 });
  });

  it("detects tool-name divergence at the exact step + tool index", () => {
    const drifted = clone(baseTrace);
    const step = drifted.steps[1];
    if (step.kind === "assistant") step.toolCalls[0]!.name = "search_db";
    const r = compareTraces(baseTrace, drifted);
    expect(r.identical).toBe(false);
    expect(r.differences).toContainEqual({
      kind: "tool-name",
      stepIndex: 1,
      toolIndex: 0,
      expected: "search_kb",
      actual: "search_db",
    });
  });

  it("detects tool-arguments divergence", () => {
    const drifted = clone(baseTrace);
    const step = drifted.steps[1];
    if (step.kind === "assistant") step.toolCalls[0]!.arguments = { query: "refund" };
    const r = compareTraces(baseTrace, drifted);
    expect(r.identical).toBe(false);
    expect(r.differences.some((d) => d.kind === "tool-arguments")).toBe(true);
  });

  it("detects assistant content divergence", () => {
    const drifted = clone(baseTrace);
    const step = drifted.steps[3];
    if (step.kind === "assistant") step.content = "Same — but only 7 days in EUR.";
    const r = compareTraces(baseTrace, drifted);
    expect(r.identical).toBe(false);
    expect(r.differences[0]).toMatchObject({ kind: "assistant-content", index: 3 });
  });

  it("formatReport renders an identical report tersely", () => {
    expect(formatReport(compareTraces(baseTrace, clone(baseTrace)))).toBe(
      "traces are structurally identical",
    );
  });
});
