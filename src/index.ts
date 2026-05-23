/** Public programmatic API. */
export {
  type Trace,
  type TraceStep,
  type ToolCall,
  TraceSchema,
  TraceStepSchema,
  ToolCallSchema,
  parseTrace,
  serializeTrace,
} from "./trace.js";
export { compareTraces, formatReport, type CompareReport, type Difference } from "./compare.js";
export {
  initBench,
  defaultBenchConfig,
  renderBenchReadme,
  renderBenchGitignore,
  type InitOptions,
  type InitResult,
  type BenchConfig,
} from "./init.js";
