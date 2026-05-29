# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- CLI-output snapshot tests (`src/cli-snapshots.test.ts`) pinning the
  rendered, human-readable bytes that `agentbench` writes to stdout for
  every command's typical invocation — same testing rigor used by
  `biomejs/biome` and `vitest-dev/vitest`, where any text drift (stray
  space, swapped column, renamed flag) fails CI loudly instead of
  shipping. Covers `head` (default + `-n 2`), `stats`, `compare` (clean +
  drifted), `replay` (full + filtered), `validate` (clean + broken),
  `list` (populated + empty), `export --format md`, `export --format json`,
  and `merge` — 14 inline snapshots in one file. Inline
  `toMatchInlineSnapshot` keeps the diff and the test in one place.
  Snapshots are deterministic: ANSI codes stripped, absolute paths under
  the fixture tmpdir redacted to `<tmp>` (with the macOS
  `/private/var/...` realpath dance the rest of the suite already does),
  ISO 8601 timestamps to `<ts>`, `\r\n` collapsed to `\n`, and any `\\`
  inside a redacted `<tmp>/...` prefix normalised to `/` so Windows CI
  matches macOS/Linux. New test-only helper
  `src/test-utils/render-cli.ts` (~90 LOC, no production code path)
  exposes `renderCommand` and `normaliseCliOutput` — Strategy B from the
  design note (import each action handler's formatter, capture its
  output) rather than spawning the built CLI as a child process; same
  fidelity, two orders of magnitude faster, no dependency on a fresh
  `tsup` build. No runtime dependencies added —
  `toMatchInlineSnapshot` is part of vitest, which was already on the
  dev tree. No production module touched.

- `agentbench watch <trace>` subcommand that follows a trace file being
  appended live — the `tail -f` analogue for `.agentbench` JSON traces.
  Useful when recording a long-running agent session (CrewAI multi-agent
  workflow, LangGraph loop, OpenAI Agents SDK run) and you want to see
  what the agent is doing now rather than waiting until the run finishes.
  Drains the existing trace first (every step printed as one NDJSON line
  on stdout, identical wire format to `replay` so output is
  pipe-compatible), then subscribes via builtin `fs.watch` and emits any
  new steps as the file grows. `--from-end` skips the existing prefix
  (tail-from-now); `--no-follow` drains once and exits (drain-only mode
  for `agentbench watch x.json --no-follow | jq .` pipelines that don't
  want to block). File truncation or rotation resets the emit cursor and
  re-emits from the new beginning. Malformed JSON during a mid-write
  flush is swallowed and retried on the next event — the writer may
  legitimately be mid-flush, and tearing down the watcher for a transient
  half-write would defeat the point. Info chatter ("watching …") goes to
  stderr so stdout stays pure NDJSON for `jq` consumers. The initial
  trace is read and schema-validated against `TraceSchema` before any
  follow starts — `watch` refuses to follow a broken file the same way
  `head` / `replay` / `export` refuse to read one. No new runtime deps.
  Programmatic API exported via `watchTrace` (with injectable `onStep`
  callback for tests) plus `WatchOptions` / `WatchEvent` / `WatchHandle` /
  `WatchInvalidTraceError`.
- `agentbench head <trace>` subcommand that previews the first N steps of a
  recorded trace — the Unix-`head` analogue for trace files. Default `-n 5`
  matches `head` muscle memory; `-n 0` returns metadata only (no steps);
  `-n` greater than the total step count returns every step (no padding,
  no overshoot); negative values are rejected up front rather than
  silently coerced. Default human output is a brief header (trace name,
  model, "N of M steps") followed by one bracketed line per step:
  `[index] kind: content[0..120]` with content collapsed to a single line
  and truncated with a real ellipsis (`…`, U+2026); assistant steps also
  list tool-call names inline (no arguments — use `export` / `replay` for
  full fidelity). `--json` emits a stable machine shape (`name`, `model`,
  `stepsShown`, `totalSteps`, sliced `steps[]`). The trace is read and
  schema-validated against `TraceSchema` before any output — `head`
  refuses to preview a broken file the same way `export` / `replay` /
  `merge` do. No new runtime deps. Programmatic API exported via
  `headTrace` / `formatHead` / `formatHeadJson` / `DEFAULT_HEAD_LINES`.
- `agentbench replay <trace>` subcommand that streams a recorded trace's
  steps over stdout as JSON Lines (NDJSON) — one JSON object per line,
  ready to pipe into `jq`, a log aggregator, a test runner, or any
  downstream tool that already speaks NDJSON. Each emitted event has
  shape `{ index, kind, content, toolCalls? }`; `index` is the 1-based
  step position in the source trace (preserved across `--since` / `--kind`
  filters so the consumer always knows which step they're seeing).
  `--since <N>` / `--until <N>` window the output as a 1-based inclusive
  range; out-of-range windows return zero lines and exit 0 (CI scripts can
  ask for "steps 50–60" without knowing the trace length up front).
  `--kind user|assistant` filters by step kind. The trace is read +
  schema-validated against `TraceSchema` before any output — `replay`
  refuses to emit half-rendered events from a broken file the same way
  `export` / `bless` / `merge` do. NDJSON convention: no trailing blank
  line, exactly one `\n` per record. `log.info` chatter (if any) goes to
  stderr so consumers can `agentbench replay x.json | jq .` cleanly. No
  new runtime deps. Programmatic API exported via `replayTrace` (with
  injectable `out` writable for tests).
- `agentbench merge <traces…>` subcommand that concatenates two or more
  trace files into a single trace, in input order. Useful when you've
  captured a multi-turn agent workflow as several short recordings and want
  one canonical baseline for regression. Every source is read and validated
  against `TraceSchema` before any write — one invalid input aborts the
  whole run rather than producing a partially-merged file. Output `name`
  defaults to the first source's name (overridable with `--name`); output
  `model` defaults to the first source's model (overridable with
  `--model`); when sources disagree on model the first wins and a warning
  goes to stderr. `meta` is merged shallowly with first-wins on key
  conflict (warning on stderr). Default output path is `./merged.json`;
  `--out <path>` overrides. `--json` for machine-readable counts. No new
  runtime deps. Programmatic API exported via `mergeTraces` / `formatMerge`
  / `formatMergeJson`.
- `agentbench stats [path]` subcommand that prints summary statistics for a
  single trace file or a directory of traces (recursive). Reports total step
  count, user vs assistant split, model breakdown (modelId → trace count),
  per-tool call counts with p50 / p95 / max latency (nearest-rank, no
  interpolation), average serialised `arguments` size in bytes, the single
  largest trace in the set by raw byte size, and a flat per-trace summary.
  Latency fields are omitted for tools that have zero recorded `latencyMs`
  values — better than printing a misleading zero. `--json` flag emits a
  stable machine-readable shape (CI dashboards, `jq`); `--top <N>` caps the
  tool table to the top N by call count (default 10). Invalid traces in a
  directory are skipped with a stderr warning rather than aborting the
  whole run — `stats` is a reporting tool, not a gating one. Human-readable
  tables use right-aligned tabular-style numeric columns and sentence-case
  headings. Programmatic API exported via `computeStats` / `formatStats` /
  `formatStatsJson` / `percentile`. No new runtime deps — table rendering is
  hand-rolled `padEnd`/`padStart`, percentiles are a 4-line sort + index.
- `agentbench export <trace>` subcommand that pretty-prints a recorded
  trace into a human-readable report. Three output formats: `markdown`
  (default) — a tidy `.md` file with a frontmatter header (name, model,
  steps count) and one section per step (user steps as blockquotes,
  assistant steps with content prose plus a "Tool calls" subsection
  rendering each `ToolCall` as a fenced JSON arguments block, a result
  preview, and latency if recorded); `html` — a single self-contained
  document with inline CSS in a tokyonight-ish palette, mobile-friendly,
  no `<script>` tag, no external assets; and `json` — a pretty-printed
  normalisation pass through `TraceSchema`. Long tool-call result
  previews are truncated with a real ellipsis (`…`, U+2026), never
  `...`. The trace is run through `validateAgentbenchFile` before
  rendering, so `export` refuses to render an invalid file. Default
  output path is a sibling named `<basename>.{md|html|json}`; `--out
  <path>` overrides. No new runtime deps — Markdown is plain string
  assembly, HTML is a hand-rolled template, JSON is
  `JSON.stringify(..., null, 2)`. Programmatic API exported via
  `exportTrace` / `formatExport`.
- `agentbench redact <trace>` subcommand that strips sensitive content from a
  recorded trace before sharing it (bug report, blog post, public regression
  test). Default rules redact email addresses, OpenAI/Slack/GitHub/npm
  API-key prefixes, `Bearer` tokens, and JWT-shaped strings inside any
  string value; whole field values are replaced for keys named `email`,
  `phone`, `ssn`, `password`, `token`, `secret`, `apiKey`, `api_key`,
  `authorization`, `auth`. UUIDs are intentionally preserved (they're often
  legitimate test data). `--rules <path>` extends the defaults with a JSON
  `{ patterns?, piiKeys? }` file; `--dry-run` reports counts without
  writing; `--json` emits machine-readable output. Redacted file is
  re-validated against `TraceSchema` before write, so the output is always
  a valid trace. Atomic write (tmp + rename). Programmatic API exported via
  `redactTrace` / `loadRulesFile` / `formatRedact` / `formatRedactJson`.
  Regex-based PII detection is best-effort; the documented defaults catch
  common foot-guns but offer no guarantee of completeness.
- `agentbench bless <recording>` subcommand that promotes a recording to be
  the new baseline — closes the `compare`-shows-red-now-what loop. Validates
  the recording before promoting (never bless a broken file), refuses to
  overwrite an existing baseline without `--force`, supports `--name` to
  rename the destination and `--dry-run` to preview. Atomic write (tmp +
  rename) so a crash mid-promotion can't replace a good baseline with a
  half-written one. Programmatic API exported via `blessRecording`.
- `agentbench validate <path>` subcommand that schema-checks a trace file
  (or every `.json` / `.agentbench` file in a directory) against the same
  `TraceSchema` the comparer uses. Catches malformed JSON, missing fields,
  wrong field types, and unknown step `kind` values up front instead of
  failing mid-compare. Warns on empty traces and duplicate tool-call names
  within a step. `--json` flag emits a stable machine-readable shape.
  Programmatic API exported via `validateAgentbenchFile` / `formatValidate`
  / `formatValidateJson`.
- `agentbench list [dir]` subcommand that lists every baseline and recording
  inside a bench, with size and last-modified metadata. Walks nested subdirs
  under `baselines/` and `recordings/`. `--json` flag emits a stable
  machine-readable shape. Programmatic API exported via `listBench` /
  `formatList` / `formatListJson`.
- `agentbench init [name]` subcommand that scaffolds a bench directory
  (`bench.json`, `baselines/`, `recordings/`, `README.md`, `.gitignore`).
  Supports `--out <dir>` and `--force` flags. Programmatic API exported
  via `initBench` / `defaultBenchConfig` / `renderBenchReadme`.
- This CHANGELOG file.

[Unreleased]: https://github.com/adityachilka1
