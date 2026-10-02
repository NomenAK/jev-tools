# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before 1.0.0, incompatible changes will be called out explicitly. Internal source
modules are not a stable library API.

## [Unreleased]

## [0.1.2] - 2026-10-02

First release published to npm, as `@nomenak/jev-tools`. Versions 0.1.0 and 0.1.1
were tagged but never published: npm rejected the unscoped name `jev-tools`, and
the first publish workflow failed before upload.

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
- In pi, the decision policy ships with the `jev_ask` tool guidelines and is present
  whenever `jev_ask` is active; omp retains native rule discovery.

### Compatibility

Requires Node.js 24 or later. Supported host baseline: pi 0.87.1 or later, or
omp 18.4.10 or later. Install with `pi install npm:@nomenak/jev-tools@0.1.2` or
`omp plugin install @nomenak/jev-tools@0.1.2`. Omp uses its Bun runtime; Node.js is also
required for Node-based project checks. These are support baselines, not the first
host releases to implement package installation. Later host versions are expected
to remain compatible but are not all individually validated. Optional native
dependencies may be unavailable on some platforms; affected tools report their
limitations. The HTTP client is compatible with the Jev API format; configure your
own endpoint and credentials.

### Fixed

- The publish workflow passes the approved tarball to npm as a local path.
- In pi, the `jev_ask` policy appears once in the system prompt instead of twice.

## [0.1.1]

Tagged but never published to npm: the unscoped package name was rejected.

## [0.1.0]

Tagged but never published to npm: the publish workflow failed before upload.

[Unreleased]: https://github.com/NomenAK/jev-tools/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/NomenAK/jev-tools/compare/v0.1.0...v0.1.2
[0.1.1]: https://github.com/NomenAK/jev-tools/tree/v0.1.1
[0.1.0]: https://github.com/NomenAK/jev-tools/tree/v0.1.0
