/**
 * Compare two traces. v0.0.1 is intentionally a *structural* compare —
 * step counts, kinds, and tool-call sequences are checked exactly; user
 * content and assistant content are checked for equality.
 *
 * Semantic equivalence ("the model said the same thing in different words")
 * is the v0.1 design problem. For now, we surface every difference and let
 * the caller decide.
 */
import type { Trace, TraceStep } from "./trace.js";

export type Difference =
  | { kind: "step-count"; expected: number; actual: number }
  | { kind: "step-kind"; index: number; expected: string; actual: string }
  | { kind: "user-content"; index: number; expected: string; actual: string }
  | { kind: "assistant-content"; index: number; expected: string; actual: string }
  | { kind: "tool-count"; index: number; expected: number; actual: number }
  | {
      kind: "tool-name";
      stepIndex: number;
      toolIndex: number;
      expected: string;
      actual: string;
    }
  | {
      kind: "tool-arguments";
      stepIndex: number;
      toolIndex: number;
      expectedJson: string;
      actualJson: string;
    };

export interface CompareReport {
  /** True if the two traces are byte-equivalent at the structural level. */
  identical: boolean;
  differences: Difference[];
}

export function compareTraces(baseline: Trace, current: Trace): CompareReport {
  const diffs: Difference[] = [];

  if (baseline.steps.length !== current.steps.length) {
    diffs.push({
      kind: "step-count",
      expected: baseline.steps.length,
      actual: current.steps.length,
    });
  }

  const max = Math.max(baseline.steps.length, current.steps.length);
  for (let i = 0; i < max; i++) {
    const a = baseline.steps[i];
    const b = current.steps[i];
    if (!a || !b) continue; // already reported via step-count

    if (a.kind !== b.kind) {
      diffs.push({ kind: "step-kind", index: i, expected: a.kind, actual: b.kind });
      continue;
    }

    if (a.kind === "user" && b.kind === "user" && a.content !== b.content) {
      diffs.push({
        kind: "user-content",
        index: i,
        expected: a.content,
        actual: b.content,
      });
    }

    if (a.kind === "assistant" && b.kind === "assistant") {
      if (a.content !== b.content) {
        diffs.push({
          kind: "assistant-content",
          index: i,
          expected: a.content,
          actual: b.content,
        });
      }
      if (a.toolCalls.length !== b.toolCalls.length) {
        diffs.push({
          kind: "tool-count",
          index: i,
          expected: a.toolCalls.length,
          actual: b.toolCalls.length,
        });
      }
      const tMax = Math.max(a.toolCalls.length, b.toolCalls.length);
      for (let j = 0; j < tMax; j++) {
        const ta = a.toolCalls[j];
        const tb = b.toolCalls[j];
        if (!ta || !tb) continue;
        if (ta.name !== tb.name) {
          diffs.push({
            kind: "tool-name",
            stepIndex: i,
            toolIndex: j,
            expected: ta.name,
            actual: tb.name,
          });
        }
        const aJson = JSON.stringify(ta.arguments);
        const bJson = JSON.stringify(tb.arguments);
        if (aJson !== bJson) {
          diffs.push({
            kind: "tool-arguments",
            stepIndex: i,
            toolIndex: j,
            expectedJson: aJson,
            actualJson: bJson,
          });
        }
      }
    }
  }

  return { identical: diffs.length === 0, differences: diffs };
}

/** Render a CompareReport as a human-friendly multi-line string. */
export function formatReport(report: CompareReport): string {
  if (report.identical) return "traces are structurally identical";
  const lines: string[] = [`${report.differences.length} differences found:`];
  for (const d of report.differences) {
    switch (d.kind) {
      case "step-count":
        lines.push(`  · step count: expected ${d.expected}, got ${d.actual}`);
        break;
      case "step-kind":
        lines.push(`  · step #${d.index} kind: expected '${d.expected}', got '${d.actual}'`);
        break;
      case "user-content":
        lines.push(`  · step #${d.index} user content differs`);
        break;
      case "assistant-content":
        lines.push(`  · step #${d.index} assistant content differs`);
        break;
      case "tool-count":
        lines.push(`  · step #${d.index} tool-call count: expected ${d.expected}, got ${d.actual}`);
        break;
      case "tool-name":
        lines.push(
          `  · step #${d.stepIndex} tool #${d.toolIndex}: expected '${d.expected}', got '${d.actual}'`,
        );
        break;
      case "tool-arguments":
        lines.push(`  · step #${d.stepIndex} tool #${d.toolIndex} arguments differ`);
        break;
    }
  }
  return lines.join("\n");
}
