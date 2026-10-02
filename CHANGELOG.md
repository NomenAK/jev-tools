# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before 1.0.0, incompatible changes will be called out explicitly. Internal source
modules are not a stable library API.

## [Unreleased]

## [0.1.0]

### Added

- Six evidence-oriented tools for pi and omp: `jev_ask`, `jev_ask_files`,
  `jev_find_files`, `jev_locate_in_file`, `jev_check_diff` and `jev_select_tests`.
- Typed judgment intents, fixed diff checks, static test discovery and conservative
  execution plans, with visible uncertainty, missing evidence and collection limits.
- A single non-blocking run-end check for stale existing documentation, with an
  option to disable it.
- Repository-confined file evidence collection, explicit command controls and
  session call/cost budgets. Optional commands use host permissions, not a sandbox.
- npm extension installation for both hosts, shared result-reading guidance,
  tool reference documentation and architecture decisions.
- The pi prompt hook delivers the decision policy from the installed rule when
  `jev_ask` is active; omp retains native rule discovery.

### Compatibility

Requires Node.js 24 or later. Supported host baseline: pi 0.87.1 or later, or
omp 18.4.10 or later. Install with `pi install npm:jev-tools@0.1.0` or
`omp plugin install jev-tools@0.1.0`. Omp uses its Bun runtime; Node.js is also
required for Node-based project checks. These are support baselines, not the first
host releases to implement package installation. Later host versions are expected
to remain compatible but are not all individually validated. Optional native
dependencies may be unavailable on some platforms; affected tools report their
limitations. The HTTP client is compatible with the Jev API format; configure your
own endpoint and credentials.

[Unreleased]: https://github.com/NomenAK/jev-tools/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/NomenAK/jev-tools/releases/tag/v0.1.0
