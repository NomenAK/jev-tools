# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before 1.0.0, incompatible changes will be called out explicitly. Internal source
modules are not a stable library API.

## [0.4.0] - 2026-10-05

### Added

- Per-evaluation admission bound (`EVALUATION_MAX_TOKENS`): a question whose
  locally estimated cost (shared state plus that one question) exceeds the
  bound is returned `unjudged` with the estimate before any request, instead
  of failing at the endpoint. Over-budget witnesses are likewise never sent;
  downstream witness health treats them as unavailable controls and demotes.
- Documentation set: a user guide under `docs/guide/` (getting started, workflows,
  troubleshooting), tool internals under `docs/internals/`, a code map in
  `docs/architecture.md` and an index in `docs/README.md`.
- Same-subject control on `verify` claims (ask and per-file surfaces): a
  `contradicted` verdict demotes to unsure when the refuting evidence may concern
  another entity, file, version, run or moment. It is asked in a second round
  only for `contradicted` verdicts, not on every claim.

### Fixed

- Order control no longer re-asks choices whose reversal would not permute the
  presented options (0 or 1 substantive option): the byte-identical twin would
  have been answered from the first run's cache entry, so no reverse question
  is scheduled and the answer is read without an order control.
- Fixed choice pointers past 255 options including `none`: the spec drift
  pointer is omitted while requirements are still judged (drift stays
  `unjudged` with a limitation); an over-long docs sentence pointer leaves its
  section `unjudged` naming it; a select-tests unit pointer past the cap keeps
  every scenario selected with an `unjudged` entry naming the cap.
- Order-reversal control questions no longer hit the session cache entry of the
  forward order: question identity is order-sensitive, so reversed re-judgments
  are genuinely re-judged.
- The configured API key value is redacted from every state and question string
  (including its JSON-escaped shape) before serialization and cache hashing, so
  it never reaches the request payload — whatever its length, since a short key
  is still a credential. HTTP error bodies and network-failure reasons are
  scrubbed through the same path, which also keeps empty keys away from
  replacement. Commands run with the host environment minus `JEV_TOOLS_API_KEY`.
- A 429 `retry-after` beyond the retry cap now fails with a reason saying the
  delay was not waited out.

### Changed

- `jev_ask_files` verify answers distinguish `holds` / `contradicted` /
  `not addressed` / `cannot tell` per file, with the ask-surface twin and
  exact-statement check — 3 questions per claim in the first round, still one
  request per file. A same-subject check is a fourth question, asked in a second
  round only for `contradicted` verdicts; an unjudged control leaves that
  reading `unsure`.
- `jev_locate_in_file` readout: a leading probability at or above 0.7 is a
  verdict, otherwise unsure lists the two best ranges; the narrow-and-re-ask
  stage is gone.
- `jev_check_diff` docs is a stale-sentence hint over existing wording, not a
  missing-documentation detector. Risk severity rides one request per unit, with
  each flagged dimension scored as its own question.
- The automatic run-end docs check is capped at 8 Jev calls.
- Request pacing is 32 starts per second with 16 in flight (per-pool
  overridable). Local parallel work — per-file collection, caller search,
  `jev_ask_files` reads — is batched by the same `CONCURRENCY` constant, not
  by the pool.
- Unsure `score` answers whose two most likely levels are not adjacent now say so.
- Tool descriptions and the reading guide were rewritten for agents: a shared template, marks defined once in the guide, a tool picker, glosses for every output token, and English-language/hostile-content caveats. `COMMAND_LIMIT_NOTICE` was folded into the `jev_ask` description.

### Removed

- Unsourced accuracy figures: the `2/45` documentation-obligation measurement,
  the reading guide's "1 in 100 clear verdicts" claim, and the find
  description's "49 of 51 / 16 of 21" retrieval figures no longer appear in
  tool output or docs.
- `LOCATE_GRAY_MIN` / `LOCATE_SHRINK_TOP` with the shrink stage they governed.

## [0.3.0] - 2026-10-05

### Breaking

- `JEV_TOOLS_URL` (and saved or flag URLs) with plain `http:` is refused unless the host is `127.0.0.1`, `::1` or `localhost`; use `https:`. The configuration error shows neither the URL nor the key and occurs before any request.
- Files whose base name matches `.env`, `.env.*`, `*.pem`, `id_rsa*`, `*.p12`, `credentials*` or `secrets*` (any depth, case-insensitive; `.env.example`, `.env.sample` and `.env.template` excepted) are refused before reading on every evidence path, including diff units, test inventory, find, locate, ask-files and the pi/omp documentation hook. Each refusal is a named exclusion with the new cause `secret_pattern`; a question that explicitly requires such a file stays unjudged. There is no override.

### Security

- `jev_ask` commands and the Windows PowerShell ACL helper no longer inherit `JEV_TOOLS_API_KEY`. The configured key value (environment or saved configuration) is replaced with `[redacted]` in command output before state assembly, including a key prefix left where a long output line is cut, and the number of replacements is reported as a limitation.

### Added

- Optional `root` on all six tools, limited to the initial repository's exact Git root or registered live worktrees with the same common directory; invalid overrides refuse before evidence, commands, cache or judgments.
- Versioned typed reports for every tool outcome, including refused and unjudged work: evidence context, item provenance, scoped diagnostics/actions and separate requested-result, HTTP, cache, control, passage and cost accounting.
- MCP output schema and structured results from protocol 2025-06-18 onward, with self-contained text for older clients and per-request version isolation.

### Changed

- Explicit evidence selectors, rather than ordinary lexical mentions, govern missing-evidence exclusions. Canonical file versions are serialized once with alias metadata; before/current evidence remains distinct and missing requirements affect their own question group unless global.
- Host guidance now makes Jev discretionary, shares versioned canonical fragments across pi/omp/MCP, and reports current conclusions with evidence provenance and material reservations. The pi/omp opt-out documentation hook remains; MCP requires no manual replacement call.
- Human output is a projection of the typed report. Static/fallback selection and unavailable judgments never acquire fabricated probabilities; cached results are distinct from fresh requests and unknown cost is not zero.

### Fixed

- Historical-only and deleted-file evidence resolution, supplied-file basename precedence and canonical file-count admission without duplicated alias content.
- Command output reaches bounded passage selection before immutable-evidence budget refusal, including base snapshots and import closure; reports preserve actual command execution/cwd even when later collection fails.
- Selection reports distinguish unmatched candidate criteria, partial matches, excluded inventory and named conservative-widening triggers from absence of affected tests.
- Review reports retain documentation completeness/collection reservations and risk/coverage witness diagnostics. Residual absence summaries remain derived observations within the considered inventory, not extra judgments or global coverage claims.
- Recovery actions preserve the actual evidence/control limitation instructions rather than generic repetition advice.
- Local-caller reports preserve their independent unsure/abstain bands and matching probabilities; specification drift remains one pointer decision rather than duplicated judgments for every candidate unit.
- MCP malformed tool arguments remain JSON-RPC invalid-parameter errors, separate from well-formed calls refused by evidence admission.
- Every judgment stage binds cache identity and serialized admission to its admitted root/base context, including auxiliary command passages. Locate planning reserves that metadata capacity before allocating evidence.
- Historical selectors use protected base reads for ignored paths, symlinks, non-text content and deleted files; current/base versions share the distinct-file ceiling without bypassing rejected admissions.

## [0.2.0] - 2026-10-03

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

[Unreleased]: https://github.com/NomenAK/jev-tools/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/NomenAK/jev-tools/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/NomenAK/jev-tools/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/NomenAK/jev-tools/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/NomenAK/jev-tools/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/NomenAK/jev-tools/compare/v0.1.0...v0.1.3
[0.1.2]: https://github.com/NomenAK/jev-tools/tree/v0.1.2
[0.1.1]: https://github.com/NomenAK/jev-tools/tree/v0.1.1
[0.1.0]: https://github.com/NomenAK/jev-tools/tree/v0.1.0
