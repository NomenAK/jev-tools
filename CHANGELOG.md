# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before 1.0.0, incompatible changes will be called out explicitly. Internal source
modules are not a stable library API.

## [Unreleased]

### Added

- `jev-agent-tools-mcp`: a dependency-free MCP stdio server exposing the same six
  tools to any MCP client. It reuses the existing tool factories, session limits,
  HTTP client and saved configuration; the binary ships as compiled JavaScript built
  by `npm run build`.
- MCP setup guide (`docs/mcp.md`) and a project instruction template for MCP agents
  (`docs/agent-instructions.md`, for `CLAUDE.md`, `AGENTS.md` or Kiro steering).
- `JEV_TOOLS_BASH` and `JEV_TOOLS_ROOT` settings (Windows bash path; MCP root).
- MCP Registry publication: `server.json` (`io.github.NomenAK/jev-agent-tools`) and
  `mcpName` in `package.json`. After the npm publish, the release workflow waits for the
  approved version and its `mcpName` on npm, then publishes with a pinned, checksum-verified
  `mcp-publisher` over GitHub OIDC; an existing registry version is skipped only
  when its server definition matches the approved tarball's metadata.
- `scripts/check-mcp-package.ts`: CI and release gate that installs the packed
  tarball, checks modern discovery and all advertised legacy handshakes, and
  exercises `jev_ask` against a local synthetic HTTP endpoint.
- Native Windows and macOS CI for MCP, managed process termination, private
  configuration, platform paths and the installed package; Linux retains the
  complete offline suite.

### Changed

- The npm package now includes `SECURITY.md` and `docs/adr/`, which shipped
  documentation already linked to.

### Fixed

- MCP command cancellation and timeout now finish process-group escalation even
  when the parent shell exits first. Closing stdin, SIGTERM and SIGINT drain
  outstanding tool calls before the server exits; cancelled calls stay silent.
- Windows command cleanup maps MSYS descendants before forced termination, so
  Git Bash fork/exec no longer hides ordinary descendants from `taskkill /T`.
- Package checks use local archive paths on Windows and macOS; private-storage
  test fixtures use canonical macOS temporary paths without relaxing symlink checks.
- Modern MCP discovery now includes server identity in result metadata, and
  tool lists declare immediately stale, private caching as required by the
  2026-07-28 protocol.
- MCP Registry reruns skip only an identical server definition. Divergent,
  malformed or inconclusive responses fail; registry metadata is checked
  against `server.json` inside the approved tarball before lookup.

- In omp, first-launch Jev setup no longer waits for credential entry inside the
  bounded `session_start` handler. The offer and input dialogs stay open while
  users find their endpoint and key, rather than closing after the host's
  30-second event deadline.
- `JEV_TOOLS_MAX_USD` could be overshot by up to seven requests: concurrent batches
  were all admitted before any cost was reported. Under a USD limit, requests are
  now admitted one at a time, so only the final admitted request can exceed it.
- Windows: `jev_ask` commands ran `env CI=1 bash`, which fails without `env` and
  resolves to the WSL launcher. Git for Windows bash is now used.
- Windows: imported providers were never found for `jev_check_diff` risk callers
  because a repository path was resolved with platform path semantics.
- Windows: node:test `file:///C:/...` failure locations (including `%20`) were not
  mapped back to repository files.
- Windows: an 8.3 short working directory (for example `C:\Users\NAME~1`) did not
  relate to the Git root, which emptied import closures and file references.
- Line endings are pinned to LF via `.gitattributes`, so lint and the rule/guideline
  parity check pass on Windows checkouts with `core.autocrlf=true`.
- Windows: saving or loading `/jev-setup` configuration always failed, because the
  privacy check read POSIX mode bits, which Windows reports as `0o666` for every file.
  Windows now checks the folder and file access lists (allow entries limited to the
  current user, SYSTEM and Administrators) and restricts a new folder when saving.
- Tests: `secret-input` passed a `C:\` path to `import()`; the risk-caller latency
  test compared one run with a fixed 250 ms and now checks 250- to 1000-line scaling.

## [0.1.4] - 2026-10-02

### Added

- Interactive configuration for pi and omp: first-launch offer, `/jev-setup`, masked
  key entry, `--jev-skip-setup`, `--jev-url` and `--jev-model`. Configuration applies
  immediately; optional saving uses a private file outside the repository and stores the
  key in plaintext. No dialog appears in print, JSON, RPC or sub-agent sessions.

### Changed

- Release publication uses trusted publishing (OIDC) without a temporary npm token.
- Document the npm release's verified pi 1.0.0 integration, simulated-service smoke
  scope and non-blocking `@sinclair/typebox` packaging warning.

## [0.1.3] - 2026-10-02

First npm release, published as `jev-agent-tools`. Versions 0.1.0, 0.1.1 and 0.1.2
were tagged but never published; their outcomes are recorded below.

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
omp 18.4.10 or later. Install with `pi install npm:jev-agent-tools@0.1.3` or
`omp plugin install jev-agent-tools@0.1.3`. Omp uses its Bun runtime; Node.js is also
required for Node-based project checks. These are support baselines, not the first
host releases to implement package installation. Later host versions are expected
to remain compatible but are not all individually validated. Optional native
dependencies may be unavailable on some platforms; affected tools report their
limitations. The HTTP client is compatible with the Jev API format; configure your
own endpoint and credentials.

### Fixed

- The publish workflow passes the approved tarball to npm as a local path.
- In pi, the `jev_ask` policy appears once in the system prompt instead of twice.

## [0.1.2]

Tagged but never published to npm: the scoped candidate was cancelled before
publication after the package name changed to `jev-agent-tools`.

## [0.1.1]

Tagged but never published to npm: the unscoped package name was rejected.

## [0.1.0]

Tagged but never published to npm: the publish workflow failed before upload.

[Unreleased]: https://github.com/NomenAK/jev-tools/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/NomenAK/jev-tools/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/NomenAK/jev-tools/compare/v0.1.0...v0.1.3
[0.1.2]: https://github.com/NomenAK/jev-tools/tree/v0.1.2
[0.1.1]: https://github.com/NomenAK/jev-tools/tree/v0.1.1
[0.1.0]: https://github.com/NomenAK/jev-tools/tree/v0.1.0
