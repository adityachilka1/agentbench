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
export {
  listBench,
  formatList,
  formatListJson,
  NotABenchError,
  BenchNotFoundError,
  type ListEntry,
  type ListResult,
  type EntryType,
} from "./list.js";
export {
  validateAgentbenchFile,
  formatValidate,
  formatValidateJson,
  type ValidateResult,
  type FileValidationResult,
  type ValidationIssue,
  type IssueSeverity,
} from "./validate.js";
export {
  blessRecording,
  BaselineExistsError,
  InvalidRecordingError,
  NotABenchError as BlessNotABenchError,
  RecordingNotFoundError,
  type BlessOptions,
  type BlessResult,
} from "./bless.js";
export {
  redactTrace,
  loadRulesFile,
  formatRedact,
  formatRedactJson,
  validateRedactedFile,
  DEFAULT_PATTERNS,
  DEFAULT_PII_KEYS,
  NotATraceError,
  type RedactOptions,
  type RedactResult,
  type RedactCounts,
  type RedactRules,
  type RedactPattern,
} from "./redact.js";
