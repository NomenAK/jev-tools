# Design

The tools construct bounded evidence before asking for judgment. They preserve uncertainty and omissions instead of treating probability as proof.

## Evidence before judgment

Supply the discriminating evidence, not an argument about it. For comparisons, show both sides: a failing test and its implementation, or a file before and after. A bounded static import closure adds declarations before judgment where supported; it cannot establish completeness or discover relationships without imports. Commands are evidence sources, not a sandbox or a substitute for reading the output directly.

Every call captures its host/server authority independently. Optional `root` admits only an exact repository top-level or live registered worktree with the same Git common directory, before content, commands, cache or HTTP. No override preserves existing cwd behavior; an invalid override never falls back. The effective context, requested/resolved base and inventory limits travel with evidence and results. See [root admission](../README.md#evidence-root).

Explicit selectors define required evidence; lexical hints do not become vetoes merely because they resemble filenames. Exact directory paths cannot fall back to suffix matches. Canonical paths serialize each current/base version once, with aliases as metadata, and file admission counts identities rather than versions. Missing requirements gate their full question/control group; global-note requirements remain global. Captured output and repository files keep separate provenance.

Historical-only files pass the same protected-path, ignore, regular-file and text admission checks before their base content is disclosed. Current and base versions share the distinct-file ceiling; unresolved or over-budget selectors are not retried through raw historical reads.

## Pure core, thin adapters

Pure core transformations construct states, units, questions and display envelopes. Adapters own filesystem, Git, parsing and host effects; the HTTP client owns transport. Presets define fixed review questions and texts define host-facing guidance. Hosts sit on top: `src/index.ts` registers the tools with pi and omp, and `src/mcp/` serves the same tool factories to any MCP client over stdio ([ADR 0010](adr/0010-mcp-server-thin-host.md), [setup](mcp.md)). Dependency checks keep shared contracts below consumers, reject cycles and account for erased type imports. Pure path operations and erased parser types are explicit architectural exceptions. Both hosts use the same HTTP judgment protocol.

The dependency-free `src/result-types.ts` defines `ResultReportV1`; `core/result-report.ts` builds reports and validates semantic invariants, while `report-schema.ts` supplies the closed transport schema and structural validator. Producers record actual observations rather than reconstructing them from rendered prose. `renderResultReport` projects the same report to self-contained text, retaining native read/runner details. pi/omp publish `details.result`; supported MCP versions publish `structuredContent.result` without introducing a second judgment policy.

## Typed intents and fixed checks

Caller intents compile to typed questions with canonical options and exact statement text. Verification of one combined situation preserves the distinction between holds, contradicted, not addressed and cannot tell, with an exact-statement cross-check that cannot override missing evidence. Custom questions remain uncalibrated. Diff checks use reviewed questions over before/after evidence units; tests are evidence, not changed units to judge. A matrix asks boolean cells across units; a pointer chooses one candidate or none. Neither executes the code.

## Probability is not proof

Leading-option probability (p_max) is the probability of the most likely choice, not the response's separate confidence field. Gray bands and applicable option-order checks expose ambiguity. Missing evidence remains abstention. Preset witnesses use a decoy and a known positive reference to detect a biased setup; failed controls do not promote findings. No mark establishes that unseen evidence is complete. See [result reading](../README.md#read-the-results).

Execution state and judgment band are independent: complete/partial/refused/not judged describe processing, while verdict/unsure/abstain describe admitted judgments. Every requested item is fresh, cache, static or unjudged; static/fallback decisions have no invented probability. Auxiliary controls and passage decisions do not inflate requested-result counts. Missing required controls leave the requested group unjudged. Accounting distinguishes HTTP attempts, questions sent, cache probes, current cost and elapsed time; unknown cost is never reconstructed as zero or historical cached cost. Scoped diagnostics preserve material omissions and useful conditional actions.

## Bounded work, visible limits

Admission limits, request planning, rate limiting and retry bounds are distinct. Oversized evidence is refused or visibly omitted, never silently converted into an ordinary verdict. Per-invocation max_calls and session call/cost limits are separate; control and severity requests count too. Under a session USD limit, requests are admitted one at a time so each admission sees all cost reported so far. Unjudged tests stay selected. Automatic documentation review is the only run-end automation and can request at most one extra turn.

Successful non-command judgments are cached only in session memory by canonical evidence, question and requested model string. Every judgment input, including control and passage decisions, carries admitted authority/root provenance and the resolved base when applicable; that metadata participates in both cache identity and serialized evidence admission. Identical content from different roots or base revisions cannot reuse a judgment. Errors are not cached; command judgments bypass caching. The default openjev alias can move, and an echoed model name does not prove served-model identity. Fractional budgets bound admission, not an exact prediction of the final request's cost.

`src/texts/instructions.ts` is the versioned source for host policy, evidence guidance and current-state presentation. `node scripts/generate-instructions.ts` updates checked-in omp/MCP fragments; `--check` detects drift. Jev is discretionary when it can inform an open decision; native decisive evidence requires no certification call. Unchanged retries and mandatory risk/docs sequences are not recovery policy. pi/omp retain the opt-out documentation hook; MCP has no replacement obligation. Final presentation distinguishes native execution, Jev's static judgment and reported evidence, preserving independent material reservations without requiring an exhaustive history registry.

## Policy thresholds

Values below are implementation policy, not measurement results, universal accuracy guarantees or settings to edit during a session. Boolean bands preserve weak answers as unsure; choice bands require a clear leader. Fixed findings use a separate threshold. Test selection favors retaining potentially affected tests and whole-file commands when name filtering is fragile.

### Judgment policy

| Constant and value | Purpose |
|---|---|
| `BAND_BOOL_GRAY_A = 0.2` | Leave intermediate yes/no probabilities visibly unsure rather than reporting a weak verdict. |
| `BAND_BOOL_YES_MIN = 0.8` | Leave intermediate yes/no probabilities visibly unsure rather than reporting a weak verdict. |
| `BAND_CHOICE_VERDICT_MIN = 0.85` | Require a clear leading option for a choice or level verdict; this does not calibrate arbitrary caller asks. |
| `ORDER_REVERSE_BELOW = 0.85` | Recheck ambiguous substantive option order and expose order sensitivity instead of promoting it. |
| `ORDER_DISAGREE_MIN = 0.1` | Recheck ambiguous substantive option order and expose order sensitivity instead of promoting it. |
| `CANNOT_TELL_MIN = 0.3` | Preserve an explicit missing-evidence outcome before applying ordinary verdict bands. |
| `FLAG_MIN = 0.7` | Use one finding threshold across fixed review checks, distinct from caller-ask bands. |
| `SELECT_MIN = 0.5` | Prefer running an extra test over dropping a potentially affected test. |
| `SELECT_FILE_SHARE = 0.8` | Run the whole file when filtering would save little or introduce fragile name selection. |
| `DOCS_CHECK_MIN = 0.2` | Surface potentially stale wording for manual checking without making it a finding. |
| `WITNESS_LURE_MAX = 0.15` | Use size-aware decoy limits to detect a biased preset setup. |
| `WITNESS_LARGE_LURE_MAX = 0.25` | Use size-aware decoy limits to detect a biased preset setup. |
| `WITNESS_LARGE_CHARS = 13000` | Use size-aware decoy limits to detect a biased preset setup. |
| `COVERAGE_WITNESS_LURE_MAX = 0.2` | Apply the coverage-specific small-decoy policy separately from risk decoys. |
| `WITNESS_ETALON_MIN = 0.7` | Check a known positive reference and enable automatic witnesses on sufficiently large matrices. |
| `WITNESS_AUTO_MIN_CELLS = 8` | Check a known positive reference and enable automatic witnesses on sufficiently large matrices. |

## Engineering bounds

Collection, transport and display limits have separate purposes. The state limit counts serialized characters; byte admission and token planning are different checks. Token estimates plan batching, not guaranteed tokenizer acceptance. Command stream limits are checked after execution and do not cap disk use or stop a running command.

<details>
<summary>Collection, transport and display constants</summary>

### Evidence and request bounds

| Constant and value | Purpose |
|---|---|
| `STATE_MAX_CHARS = 80000` | Bound admitted evidence and describe the file limit consistently; character admission is not guaranteed token acceptance. |
| `FILE_MAX_KB = 80` | Bound admitted evidence and describe the file limit consistently; character admission is not guaranteed token acceptance. |
| `TEST_SOURCE_MAX_BYTES = 1280000` | Bound test-source reads before discovery while keeping constructed states within their separate limit. |
| `ASK_NOTE_MAX_CHARS = 8000` | Keep a combined situation's caller note and directly requested files bounded. |
| `ASK_MAX_FILES = 20` | Keep a combined situation's caller note and directly requested files bounded. |
| `MAX_FILES = 255` | Bound bulk file triage and choice cardinality; pointer choices must leave room for `none`. |
| `CHOICE_MAX_OPTIONS = 255` | Bound bulk file triage and choice cardinality; pointer choices must leave room for `none`. |
| `SCORE_MIN_LEVELS = 2` | Require a small, concrete set of ordered scoring situations. |
| `SCORE_MAX_LEVELS = 10` | Require a small, concrete set of ordered scoring situations. |
| `UNIT_MAX_CHARS = 6000` | Keep changed evidence focused through slices/hunks with local context. |
| `UNIT_CONTEXT_LINES = 8` | Keep changed evidence focused through slices/hunks with local context. |
| `CLOSURE_MAX_CHARS = 20000` | Bound automatically added static declarations; the retained budget is not a demonstrated optimum or a completeness guarantee. |
| `REQUEST_MAX_TOKENS = 60000` | Leave planning headroom when forming question batches, without rejecting admissible states on a heuristic alone. |
| `QUESTION_TOKENS = 1 / 3.3` | Estimate batches only; these coefficients are not exact costs or universal tokenizer bounds. |
| `STATE_TOKENS = 0.283` | Estimate batches only; these coefficients are not exact costs or universal tokenizer bounds. |
| `REQUEST_BASE_TOKENS = 456` | Estimate batches only; these coefficients are not exact costs or universal tokenizer bounds. |
| `RATE_PER_SECOND = 8` | Share throughput and in-flight limits across requests rather than mistaking concurrency for rate control. |
| `CONCURRENCY = 8` | Share throughput and in-flight limits across requests rather than mistaking concurrency for rate control. |
| `TIMEOUT_MS = 10000` | Bound transport waiting and retry attempts. |
| `REQUEST_ATTEMPTS = 3` | Bound transport waiting and retry attempts. |
| `RETRY_BASE_MS = 500` | Back off transient failures with a bounded delay and handle longer server delays explicitly. |
| `RETRY_MAX_MS = 5000` | Back off transient failures with a bounded delay and handle longer server delays explicitly. |
| `HTTP_ERROR_MAX_CHARS = 300` | Keep error diagnostics concise and redact credentials. |
| `GIT_BLOB_BATCH_SIZE = 400` | Bound historical blob batches so object IDs and options fit command-line limits. |
| `RUNNER_PACKAGE_MAX_BYTES = 65536` | Bound local runner-version metadata reads without sending package contents as judgment evidence. |

### Command evidence

| Constant and value | Purpose |
|---|---|
| `ASK_TIMEOUT_S = 60` | Give optional commands a bounded default and caller-selectable maximum. |
| `ASK_TIMEOUT_MAX_S = 300` | Give optional commands a bounded default and caller-selectable maximum. |
| `OUTPUT_REPEAT_MIN = 5` | Group recurring line shapes while preserving rarer failure evidence. |
| `OUTPUT_CHUNK_CHARS = 2500` | Bound the passage-finding stage when compressed output still cannot fit. |
| `OUTPUT_FIND_MAX_CALLS = 40` | Bound the passage-finding stage when compressed output still cannot fit. |
| `OUTPUT_HEAD_SHARE = 0.05` | Reserve beginning/end context within the final evidence stage, not as a substitute for rarity compression. |
| `OUTPUT_TAIL_SHARE = 0.15` | Reserve beginning/end context within the final evidence stage, not as a substitute for rarity compression. |
| `OUTPUT_FILE_MAX_BYTES = 67108864` | Refuse oversized captured streams after execution; this is not a disk or command-execution cap. |
| `OUTPUT_LINE_MAX_CHARS = 8192` | Bound streaming line/shape bookkeeping and report the resulting limits explicitly. |
| `OUTPUT_SHAPE_MAX_COUNT = 2048` | Bound streaming line/shape bookkeeping and report the resulting limits explicitly. |
| `OUTPUT_FAILURE_WINDOW_LINES = 20` | Preserve local failure neighborhoods when identifying the failing test. |

### Documentation collection and result display

| Constant and value | Purpose |
|---|---|
| `DOCS_MAX_SECTIONS = 40` | Bound the set of existing Markdown sections judged by the documentation preset. |
| `HOOK_BUDGET_MS = 15000` | Limit automatic run-end work without turning failures into a blocking host loop. |
| `DOCS_COLLECT_BUDGET_MS = 750` | Stop progressive collection with omissions visible; this is not a strict wall-time or coverage guarantee. |
| `DOCS_NAME_MAX_FILES = 32` | Bound name-owner bookkeeping and per-anchor traversal rather than claiming complete repository reachability. |
| `DOCS_ANCHOR_MAX_FILES = 32` | Bound name-owner bookkeeping and per-anchor traversal rather than claiming complete repository reachability. |
| `CALLER_DISPLAY_MAX_SPANS = 8` | Keep local-caller evidence lines readable while preserving full details. |
| `LIMIT_DISPLAY_MAX_PATHS = 4` | Prioritize actionable limits and documentation locations while reporting remaining counts. |
| `DOCS_DISPLAY_MAX_SECTIONS = 5` | Prioritize actionable limits and documentation locations while reporting remaining counts. |

### File finding

| Constant and value | Purpose |
|---|---|
| `FIND_NAME_CANDIDATES = 128` | Bound the default name-ranking and content-reading stages separately. |
| `FIND_NAME_BATCH = 64` | Bound the default name-ranking and content-reading stages separately. |
| `FIND_FILES_READ = 20` | Bound the default name-ranking and content-reading stages separately. |
| `FIND_READ_PER_CALL = 5` | Judge small groups with keyword-selected evidence rather than bare paths. |
| `FIND_EXCERPT_CHARS = 3000` | Judge small groups with keyword-selected evidence rather than bare paths. |
| `FIND_POINTER_EXCERPT_CHARS = 1500` | Judge small groups with keyword-selected evidence rather than bare paths. |
| `FIND_POINTER_MAX = 8` | Keep the entry-point choice focused on a bounded shortlist. |
| `FIND_NAME_GUARD_MIN = 0.9` | Preserve a strongly named leading candidate when its excerpt is less conclusive. |
| `FIND_NAME_GUARD_TOP = 3` | Preserve a strongly named leading candidate when its excerpt is less conclusive. |
| `FIND_CONFIRM_MIN = 0.8` | Separate entry confirmation from admission to the content shortlist. |
| `FIND_CONTENT_MIN = 0.5` | Separate entry confirmation from admission to the content shortlist. |
| `FIND_GOAL_MIN_WORDS = 5` | Require a behavioral sentence before presenting an unqualified entry verdict. |
| `FIND_QUICK_CANDIDATES = 32` | Offer a smaller bounded first-pass search. |
| `FIND_QUICK_READ = 8` | Offer a smaller bounded first-pass search. |
| `FIND_THOROUGH_CANDIDATES = 256` | Broaden related-file exploration without promising a better entry point. |
| `FIND_THOROUGH_READ = 40` | Broaden related-file exploration without promising a better entry point. |
| `FIND_EXCERPT_HEAD_CHARS = 1000` | Preserve leading file context when building excerpts. |
| `FIND_PATH_WEIGHT = 3` | Prefer lexical goal matches in paths during deterministic pre-ranking. |
| `FIND_GREP_PAGE_SIZE = 1024` | Bound lexical-result pages and streamed excerpt reads. |
| `FIND_READ_CHUNK_BYTES = 16384` | Bound lexical-result pages and streamed excerpt reads. |

### Locating within a file

| Constant and value | Purpose |
|---|---|
| `LOCATE_MIN_KB = 19` | Route small files to direct reading; eligibility uses file bytes, not tokenization. |
| `LOCATE_VERDICT_MIN = 0.7` | Distinguish one clear range, two plausible ranges and a weak choice requiring narrowing. |
| `LOCATE_GRAY_MIN = 0.4` | Distinguish one clear range, two plausible ranges and a weak choice requiring narrowing. |
| `LOCATE_SHRINK_TOP = 3` | Retry only within a narrowed shortlist plus `none`, rather than appending arbitrary context. |
| `LOCATE_SECTION_MAX_LINES = 150` | Keep fallback sections bounded while avoiding tiny fragments. |
| `LOCATE_SECTION_MIN_LINES = 8` | Keep fallback sections bounded while avoiding tiny fragments. |
| `LOCATE_WINDOW_LINES = 80` | Bound streamed windows and their display labels. |
| `LOCATE_LABEL_MAX_CHARS = 120` | Bound streamed windows and their display labels. |
| `LOCATE_WHOLE_MAX_CHARS = 320000` | Bound whole-file admission before using the large-file path. |
| `LOCATE_WHOLE_MAX_BYTES = 1280000` | Bound whole-file admission before using the large-file path. |
| `LOCATE_READ_BUFFER_BYTES = 65536` | Bound the streaming read buffer. |
| `LOCATE_WINDOW_MAX_SERIALIZED_CHARS = 20000` | Leave serialization headroom for multi-window refinement and metadata; this is an engineering bound, not calibrated accuracy. |

### Architecture policy

| Constant | Purpose |
|---|---|
| `IMPORT_LAYERS` | Enforce allowed downward local dependencies among core, presets, adapters, HTTP client and texts, including erased type imports, while rejecting cycles. |

</details>

## Compatibility and limitations

Optional native syntax parsing and file-search acceleration can be absent. Tools report unsupported languages, incomplete parsing and heuristic sections rather than implying precise coverage. Static test discovery reads literal configuration without evaluating third-party code, keeps runtime and type tests separate, and preserves runner/project options. It cannot infer missing test obligations. File finding ranks names then reads bounded excerpts, not every file in the repository. Large-file location uses sections or streamed window outlines with visible limits.

## Glossary

| Term | Definition |
|---|---|
| Evidence state | The JSON evidence assembled for a judgment request. |
| Intent | The typed judgment the caller declares and code compiles into questions. |
| Claim | One self-contained factual statement supplied for verification. |
| Evidence unit | A changed declaration, slice, file or hunk shown with its before/after evidence. |
| Preset | A fixed, reviewed set of questions for a specific diff check. |
| Leading-option probability | The probability of the most likely choice after applicable controls; not the response's separate confidence field. |
| Witness | Known-reference evidence used to check a preset setup, not a runtime guarantee. |
| Result mark | unsure or abstain identifying a conclusion the tool did not confirm. |

## Architecture decisions

See the [architecture decision records](adr/) for durable trade-offs. Start with the [README](../README.md) for installation and follow its six tool references for complete parameter contracts. MCP clients: [setup guide](mcp.md) and [agent instructions](agent-instructions.md).
