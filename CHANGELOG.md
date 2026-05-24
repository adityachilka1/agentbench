# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
