# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
