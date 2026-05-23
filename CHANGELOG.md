# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
