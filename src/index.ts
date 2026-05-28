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
  matchTrace,
  formatMatchReport,
  formatMatchJson,
  type MatchOptions,
  type MatchResult,
  type MatchEntry,
} from "./match.js";
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
export {
  exportTrace,
  formatExport,
  InvalidTraceError as ExportInvalidTraceError,
  type ExportOptions,
  type ExportResult,
  type ExportFormat,
} from "./export.js";
export {
  computeStats,
  formatStats,
  formatStatsJson,
  percentile,
  type StatsReport,
  type ToolStats,
  type PerTraceSummary,
  type LargestTrace,
  type SkippedTrace,
  type ComputeStatsOptions,
} from "./stats.js";
export {
  mergeTraces,
  formatMerge,
  formatMergeJson,
  InvalidSourceError,
  NoSourcesError,
  type MergeOptions,
  type MergeResult,
} from "./merge.js";
export {
  replayTrace,
  InvalidTraceError as ReplayInvalidTraceError,
  type ReplayOptions,
  type ReplayResult,
  type ReplayEvent,
} from "./replay.js";
export {
  headTrace,
  formatHead,
  formatHeadJson,
  DEFAULT_HEAD_LINES,
  InvalidTraceError as HeadInvalidTraceError,
  type HeadOptions,
  type HeadResult,
} from "./head.js";
export {
  watchTrace,
  InvalidTraceError as WatchInvalidTraceError,
  type WatchOptions,
  type WatchEvent,
  type WatchHandle,
} from "./watch.js";
export {
  pruneStaleBaselines,
  formatPruneReport,
  formatPruneJson,
  type PruneOptions,
  type PruneResult,
  type PruneKeptEntry,
  type PrunableEntry,
} from "./prune.js";
