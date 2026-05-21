import { describe, expect, it } from "vitest";
import { TraceSchema, parseTrace, serializeTrace } from "./trace.js";

describe("Trace schema", () => {
  it("round-trips a minimal user-only trace", () => {
    const t = TraceSchema.parse({
      name: "smoke",
      steps: [{ kind: "user", content: "hello" }],
    });
    expect(parseTrace(serializeTrace(t))).toEqual(t);
  });

  it("requires kind to be one of the discriminated union members", () => {
    expect(() =>
      TraceSchema.parse({
        name: "bad",
        steps: [{ kind: "system", content: "no" } as never],
      }),
    ).toThrow();
  });

  it("defaults assistant.toolCalls to [] when omitted", () => {
    const t = TraceSchema.parse({
      name: "assistant-only",
      steps: [{ kind: "assistant", content: "ok" }],
    });
    if (t.steps[0]!.kind !== "assistant") throw new Error("type narrowing failed");
    expect(t.steps[0]!.toolCalls).toEqual([]);
  });

  it("rejects malformed JSON in parseTrace", () => {
    expect(() => parseTrace("not json")).toThrow();
  });
});
