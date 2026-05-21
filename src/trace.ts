/**
 * Trace — the canonical recording format for an agent run.
 *
 * Designed to be framework-agnostic. CrewAI, LangGraph, Mastra, OpenAI
 * Agents SDK, or your own wrapper can all emit traces in this shape. v0.1
 * will ship adapters that produce traces directly from each framework.
 */
import { z } from "zod";

export const ToolCallSchema = z.object({
  /** Tool name as invoked by the agent. */
  name: z.string(),
  /** Arguments passed to the tool, as a serialisable object. */
  arguments: z.record(z.string(), z.unknown()).default({}),
  /** Result returned by the tool, if captured. Optional. */
  result: z.unknown().optional(),
  /** Wall-clock latency in ms, if measured. Optional. */
  latencyMs: z.number().nonnegative().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const TraceStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    /** What the user said / input to the agent. */
    content: z.string(),
  }),
  z.object({
    kind: z.literal("assistant"),
    /** What the agent said back. May be empty for tool-only steps. */
    content: z.string().default(""),
    /** Tool calls the agent made during this step. */
    toolCalls: z.array(ToolCallSchema).default([]),
  }),
]);
export type TraceStep = z.infer<typeof TraceStepSchema>;

export const TraceSchema = z.object({
  /** A short identifier — used for snapshot file naming. */
  name: z.string().min(1),
  /** Optional model identifier. */
  model: z.string().optional(),
  /** Ordered conversation steps. */
  steps: z.array(TraceStepSchema),
  /** Free-form metadata — e.g. framework version, env vars used. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Trace = z.infer<typeof TraceSchema>;

/** Parse a JSON string into a validated Trace. Throws on malformed input. */
export function parseTrace(raw: string): Trace {
  return TraceSchema.parse(JSON.parse(raw));
}

/** Serialise a Trace to canonical JSON for on-disk storage. */
export function serializeTrace(trace: Trace): string {
  return JSON.stringify(TraceSchema.parse(trace), null, 2);
}
