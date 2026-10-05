# Engine: the shared request path

Every tool funnels through these modules. Tool-specific logic (which evidence, which questions) is in the per-tool pages; this page covers the machinery they all share.

## Admission and state construction

- File confinement lives in `src/adapters/files.ts` (`collectFiles`, `resolveInsideRepo`, `checkFileAdmission`): repository-relative paths only; absolute paths, parent traversal, escaping symlinks, Git metadata, and internal URLs are rejected. Skipped files become visible limits, not silent omissions.
- `src/core/state.ts:assembleState` builds the judged `State` from the caller note plus collected files. The note is JSON-parsed when it is object text, otherwise kept raw; reserved keys (`files`, `files_before`, `base_sha`, `closure`) are rejected. Serialized state is bounded by `STATE_MAX_CHARS`; the note by `ASK_NOTE_MAX_CHARS`. Oversize input is refused with a split suggestion — files are never truncated into a verdict. Constant values: [design policy](../design.md#judgment-policy).
- `src/core/truncate.ts:truncate` is the one place prefix-cutting is allowed (closure entries, excerpts): UTF-16-safe, backs off one unit to avoid splitting a surrogate pair.

## Question compilation and batches

- `src/core/asks.ts:compileAsks` lowers caller intentions (`verify`, `classify`, `decide`, `rate`, `locate`, `free`) to typed wire questions (`bool` / `choice` / `score`) plus control questions (twins, exact-statement and same-subject booleans; the same-subject bool is held out of the first round and sent by `sameSubjectQuestions` only for `contradicted` verdicts). Details per intention are in [jev_ask](./jev_ask.md); per-file restrictions in [jev_ask_files](./jev_ask_files.md).
- `src/core/batches.ts:prepareBatches` admits questions one at a time against the one-evaluation bound `EVALUATION_MAX_TOKENS` (`REQUEST_BASE_TOKENS + state + that question`), using the same `QUESTION_TOKENS`, `STATE_TOKENS` and `REQUEST_BASE_TOKENS` coefficients. A question whose local estimate is over budget is returned as `unjudged` with that estimate and is not sent; this is a heuristic admission decision, not a measurement, and a question estimated within the bound is still not guaranteed to be accepted by the endpoint. Surviving groups are then packed into requests under `REQUEST_MAX_TOKENS`, which starts a new request when one does not fit but still sends a single oversized group and lets the endpoint decide. `splitGroups` halves the group list when the endpoint reports `max_tokens_exceeded` anyway. Empty groups, repeated ids, and witnesses without groups are rejected.
- `src/core/pointer.ts` (`pointerQuestion`, `needsReverse`, `readPointer`) builds `choice` questions whose options are candidates plus `none`, and reads the averaged twin probabilities back, flagging order dependence past `ORDER_DISAGREE_MIN`. Used by find, locate, select-tests, and the docs/spec presets.

## HTTP client: rate limit, retries, cache

- `src/jev/types.ts` defines the wire: `State`, `Question`, `Answer` (including `unjudged`), `Judgment`, `JudgmentOptions`, `JevClient`.
- `src/jev/client.ts:createJevClient` returns `{ clearCache, judge }`. `judge` plans batches, consults the two session caches, sends `POST` with the Bearer key, and runs a retry/split loop:
  - Per-attempt timeout `TIMEOUT_MS` with abort; up to `REQUEST_ATTEMPTS` attempts with exponential backoff from `RETRY_BASE_MS` capped at `RETRY_MAX_MS`. Retryable: 408/429/5xx. A 429 `retry-after` beyond `RETRY_MAX_MS` fails hard with a reason saying the delay was not waited out.
  - 401/403 stops with an auth error naming `JEV_TOOLS_API_KEY` as the thing to check (no credential is printed; error bodies are capped at `HTTP_ERROR_MAX_CHARS`).
  - 400 `max_tokens_exceeded` from the endpoint, for a request that passed the local per-evaluation admission: probe the smallest question diagnostically at most once per `judge()` (answer discarded, never cached), then `splitGroups`; an indivisible singleton becomes `unjudged`.
  - If every answer is `unjudged` and a transport failure was recorded, `judge` returns `ok: false`; otherwise partial answers are returned with the failure noted.
- `src/jev/pool.ts:createPool` is the single-process sliding window shared by requests: `acquire` blocks on `CONCURRENCY` via a serialized gate and sleeps to enforce `RATE_PER_SECOND` starts per second (both overridable per pool). Abort signals propagate.
- Session cache (in `client.ts`, keyed per requested model string): per-question entries keyed by sorted-canonical state hash, order-sensitive question hash (reversed option orders miss the cache), and model, plus a witness cache keyed by group. The configured API key value is redacted from every state and question string before serialization and hashing. Only judged (non-`unjudged`) answers are stored; command judgments bypass caching (see [jev_ask](jev_ask.md)). `clearCache` bumps a generation epoch so in-flight writes cannot repopulate a stale cache. Session caching cannot establish the identity or stability of the moving `openjev` alias.

## Budgets: per-call max_calls vs session limits

- Per-invocation `max_calls` (each tool's own parameter) bounds that call's requests, **including** controls, reverse-order re-judgments, severity, caller checks, and output passage finding. Exhaustion leaves work `unjudged`/`unchecked` with a named next action.
- Session limits (`src/session.ts:readSessionLimits`, `Session.refusal`/`admit`/`recordUsage`/`record`) bound the whole host session from `JEV_TOOLS_MAX_CALLS` (non-negative safe integer) and `JEV_TOOLS_MAX_USD` (finite, fractions allowed); absent or empty means unlimited, invalid values refuse requests. `admit` runs in `beforeRequest`: a refusal counts itself and yields a refusal-only envelope. The two layers are independent; per-call exhaustion is `unjudged`, session exhaustion is a refusal line.
- `src/core/integrity.ts:checkIntegrity` adds SHA-256 identity controls (`readSha256`/`insertedSha256` from `src/adapters/files.ts`) so a judgment cannot silently rest on bytes the tool did not read. Failed integrity forces `unsure` with a fact line.

## Bands, render, footer

- `src/core/output.ts:askBand` is the default band policy: `bool` verdicts need `p <= BAND_BOOL_GRAY_A` or `p >= BAND_BOOL_YES_MIN`; `choice`/`score` verdicts need leading mass `>= BAND_CHOICE_VERDICT_MIN`; `cannot_tell >= CANNOT_TELL_MIN` forces `abstain` first. `readAsks` (in `src/core/asks.ts`) and `readPointer` pre-compute the same bands with twin averaging and coherence downgrades, plus a same-subject downgrade for contradicted verdicts and a non-adjacent-split reason for unsure scores; `buildEnvelope` additionally downgrades verdicts to `unsure` on failed controls and groups limits into `limit-group` lines plus an unsure-count fact. A line without a mark is a verdict — a lead to check, not proof. See [README](../../README.md#read-the-results).
- `src/render.ts:renderEnvelope` renders the envelope to text. The footer (`yield` line) reports calls, questions judged, reported USD cost (or cost-unavailable), cache hits/requests, and elapsed seconds. One tool invocation routinely costs several requests (batching + controls).

## Configuration, setup, secret input

- `src/configuration.ts:ConfigController` owns precedence in `values()`: defaults (`openjev` model) < saved `config.json` < session `apply()` < launch flags (`--jev-url`, `--jev-model`) < environment (`JEV_TOOLS_URL`, `JEV_TOOLS_API_KEY`, `JEV_TOOLS_MODEL`). Environment/flag-controlled fields are shown as controlled and never saved. The client is recreated and the cache cleared only when effective values change (`apply`, `initialize`, `load` paths call `validate` then `createJevClient`).
- Saved configuration lives outside the repo (`$XDG_CONFIG_HOME/jev-agent-tools/config.json`, `0700` dir / `0600` file); symlink, accessible-permission, ownership, or malformed storage is refused, not overwritten. Validation rejects non-HTTP(S) URLs, URLs with embedded credentials, and empty keys without printing values.
- `src/setup.ts:Setup` registers the flags and `/jev-setup` command; first-launch offers one interactive configure on TUI main sessions only (never in print/JSON/RPC modes or subagents). `src/secret-input.ts:readSecret` (`MaskedSecretInput`) types the key masked, zeroes the codepoint buffer on dispose, and rejects control characters from bracketed paste. Cancelling changes nothing.

## Preset witnesses

- `src/presets/witnesses.ts`: `buildWitnessUnits` (risk decoys + étalons), `buildCoverageWitnessUnits` (frozen coverage templates, independent of risk), `evaluateBatchWitnessHealth` (per-batch decoy/étalon check).
- Logic: a **decoy** (lure) is evidence that must score *no* — decoy failure is `p` above the lure cap (`WITNESS_LURE_MAX`, size-aware `WITNESS_LARGE_LURE_MAX` past `WITNESS_LARGE_CHARS`, coverage-specific `COVERAGE_WITNESS_LURE_MAX`). An **étalon** (reference) is evidence that must score *yes* — étalon failure is `p` below `WITNESS_ETALON_MIN`. Failed batches demote the real findings in that batch to `unsure` with raw values; they never promote findings. Non-`bool` or `unjudged` witness answers (or a failed judgment) make the witness control unavailable, also `unsure`. Automatic witnesses engage only on sufficiently large matrices (`WITNESS_AUTO_MIN_CELLS`); `witnesses: "off"` disables them.

## Run-end automatic docs check

- `src/run-end.ts:RunEnd.attach` resets once per run (`before_agent_start`) and fires at run end only: `session_stop` on omp (not subagents, no `stop_hook`) or `agent_before_settle` with a completed outcome elsewhere. `onRunEnd` skips silently on missing client, `JEV_TOOLS_AUTO_DOCS=0`, session refusal, already-triggered, or a clean tree; otherwise it runs `runDocsCheck` (from `src/tools/docs-check.ts`) within `HOOK_BUDGET_MS` and at most `RUN_END_DOCS_MAX_CALLS` Jev calls, and emits `runEndMessage` only for findings at verdict (`FLAG_MIN`) that name an existing sentence. Only `docs` runs automatically; risk and spec never do. Errors and timeouts never block the host. See [README](../../README.md#automatic-documentation-check).
