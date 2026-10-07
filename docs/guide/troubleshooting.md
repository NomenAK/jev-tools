# Troubleshooting

Symptoms, the exact message the tools print, and the action that resolves it. Every quoted message is a user-visible string taken from the source files named beside it.

Guide index: [getting started](getting-started.md) · [workflows](workflows.md) · [troubleshooting](troubleshooting.md)

---

## Configuration

### The tools refuse every call

If the endpoint or key is missing, the tools stay registered and answer with the refusal instead of falling back to any chat model:

> jev-tools is not configured: set JEV_TOOLS_URL and JEV_TOOLS_API_KEY, or run /jev-setup in the main interactive terminal.

— `src/texts/configuration.ts`

**Fix.** In the main interactive terminal, run `/jev-setup`, or export `JEV_TOOLS_URL` and `JEV_TOOLS_API_KEY` before starting the host. In print, JSON or RPC modes and in sub-agents no dialog appears; use the environment variables there. See [Configure](../../README.md#configure).

### A field is refused as invalid

A malformed URL, an embedded credential in the URL, a key that is not HTTP-header-compatible, or an empty model is rejected before any call:

> Jev configuration requires a full HTTP(S) URL without embedded credentials, a nonempty HTTP-header-compatible API key, and a nonempty model.

— `src/configuration.ts`

**Fix.** Supply a complete `http://` or `https://` URL with no `user:password@` part, and a key made of header-compatible bytes. The message never echoes your URL or key.

### Saved configuration is not read or written

> Cannot read or save Jev configuration. Check that the configuration directory and config.json are owned by you, private, regular storage without symlinks, and contain valid configuration JSON.

— `src/configuration.ts`

Storage that is a symlink, group/world-accessible, not owned by you, or malformed is refused rather than overwritten. **Fix.** Repair ownership and modes on `$XDG_CONFIG_HOME/jev-agent-tools/` (`0700` directory, `0600` file), or remove the directory and run `/jev-setup` again. The key stored there is plaintext, not encrypted.

### A field is shown as controlled

A field set by the environment or a launch flag is never saved, and setup skips it with:

> Jev ${field} is controlled by the environment or a launch flag; change it before restarting.

— `src/setup.ts`

The key behaves the same way:

> The Jev API key is supplied by the environment and will not be saved.

— `src/setup.ts`

**Fix.** Unset the variable or drop the flag and restart, or accept the controlled value for this run. Precedence per field is environment, flag, this session's setup, saved configuration, then the default model `openjev`.

---

## Budgets and limits

### A budget value is invalid

An invalid value refuses every request; no Jev call is made:

> Invalid JEV_TOOLS_MAX_CALLS: expected a non-negative safe integer. No Jev call was made; correct the environment variable.

> Invalid JEV_TOOLS_MAX_USD: expected a finite non-negative number (fractional USD allowed). No Jev call was made; correct the environment variable.

— `src/session.ts`

**Fix.** `JEV_TOOLS_MAX_CALLS` must be a non-negative safe integer; `JEV_TOOLS_MAX_USD` a finite non-negative number, fractions allowed. Unset the variable for unlimited use; an empty value also means unlimited.

### The session limit is reached

**Illustrative instantiations** of the template in `src/session.ts`, with substituted values:

> JEV_TOOLS_MAX_CALLS=20 reached; session total: 20 Jev calls. No Jev call was made; the human sets this limit

> JEV_TOOLS_MAX_USD=0.50000 reached; session total: $0.51230. No Jev call was made; the human sets this limit

— `src/session.ts`

Session limits are separate from per-invocation `max_calls`, and control requests count. **Fix.** Raise the limit yourself, or start a new session, which resets the counters. A fractional cost budget bounds admission, not the exact cost of a request, so a request can be admitted and still cross the limit.

### The per-invocation cap stops work

> max_calls=8 reached

— each tool's budget path that accepts the parameter: `src/tools/ask.ts`, `src/tools/ask-files.ts`, `src/tools/check-diff.ts`, `src/tools/docs-check.ts`, `src/tools/find.ts`, `src/tools/select-tests.ts` and `src/tools/spec-check.ts`. [jev_locate_in_file](../tools/jev_locate_in_file.md) has no `max_calls`; it is bounded by the session limits alone.

followed by the next action:

> raise max_calls

— `src/core/output.ts`

**Fix.** Raise `max_calls` for that call, or narrow the work. Nothing is silently dropped: unjudged tests stay selected, and unjudged units, callers, sections, requirements and severity are named.

### The evidence is too large for one request

> serialized state exceeds ${STATE_MAX_CHARS} chars (…); serialized parts: …

— `src/core/state.ts`

> File exceeds 80000 chars: <path>; files are never truncated. Split paths into several calls.

— `src/adapters/files.ts`

> state exceeds 8000 chars (…); shorten the note.

— `src/core/state.ts`

> paths exceeds 20 files; split paths into several calls.

— `src/adapters/files.ts`

> At least 261 files exceeds MAX_FILES=255; narrow paths. Largest expanded directories: …

— `src/adapters/ask-files.ts`

> Block plan exceeds the state budget; use grep.

— `src/tools/locate.ts`

> risk state exceeds STATE_MAX_CHARS=80000; rerun with base= a nearer ref

— `src/tools/check-diff.ts`

> required evidence exceeds STATE_MAX_CHARS=80000

— `src/tools/select-tests.ts`

**Fix.** Split the request, shorten the note, move files to the command, or compare against a nearer `base`. Files are never silently shortened into a verdict; refusal names the split.

### Command evidence is too large

> output exceeded 67108864 bytes per stream; narrow command

— `src/adapters/command.ts`

> output requires more than 40 find calls: … bytes before, … chars after compression; narrow command (remove verbosity or filter)

— `src/tools/ask.ts`

> serialized command output exceeds state budget; narrow command or reduce paths

— `src/tools/ask.ts`

The tool's own description adds the standing notice:

> Refused above 64 MiB per stream (nothing on disk is capped). timeout_s defaults to 60, max 300; JEV_TOOLS_ALLOW_COMMAND=0 removes command and timeout_s.

— `src/texts/ask.ts`

**Fix.** Narrow the command, or run it yourself with `bash` and pass the relevant excerpt as a note. Stream limits are checked after execution; they cap neither disk use nor the running command. A timeout gives `exit_code: null` and `timed_out: true`, which is not success.

---

## Marks and results

### A line says `unsure`

The answer is ambiguous or a control failed. For booleans that is a yes/no probability between 0.20 and 0.80; for a category or level, a leading option below 0.85; for fixed findings, a probability in the uncertain band. Some lines name the reason:

> coherence control unjudged; no verdict: rerun with decisive evidence

— `src/core/asks.ts`

> reverse-order control unjudged; no verdict: …

— `src/core/asks.ts`

> two sections share the mass

— `src/tools/locate.ts`

**Fix.** Read the passage or file the line points to. Adding the file that settles it helps; rewording the question does not.

### A line says `abstain`

A needed piece is missing, and the line names it:

> proof missing; add decisive evidence to paths or command

— `src/core/output.ts`

> `<reference>` is empty

— `src/core/ask-references.ts` (`${reference} is empty`, where `<reference>` is a file path or `state`/`output` selector cited in the ask text)

> required evidence is absent or empty

— `src/tools/ask.ts`

> unknown bindings come back abstain naming the missing provider or binding

— the same condition described in `src/texts/check-diff.ts`

**Fix.** Add the named file or command evidence and ask once. If the reference cannot be resolved, an affected ask is not posed at all rather than guessed.

### A line says `not addressed` or `no (not shown)`

The evidence you supplied does not show the statement. That is not the same as false. The `verify` intent separates `holds`, `contradicted`, `not addressed by the state` and `cannot tell`; an exact-statement cross-check cannot by itself prove contradiction. A `contradicted` verdict is demoted to unsure when the refuting evidence may concern another subject — the reason starts `evidence may concern a different subject`.

**Fix.** Supply the file or output that would show it.

### A line says `uncalibrated`

No error rate has been measured for that kind of ask. Custom `free` questions, `classify`, `rate`, `decide` on [jev_ask_files](../tools/jev_ask_files.md) and custom `dimensions` on [jev_check_diff](../tools/jev_check_diff.md) are all marked this way.

**Fix.** Treat a high probability as a hint and read the source.

### Work was left unchecked

> unchecked: …

— `src/render.ts`

> unjudged  <label> — <reason>; <next>

— `src/render.ts`

> 2/3 answers unsure

> read the decisive passage or add its file to paths

— `src/core/output.ts`

**Fix.** Follow the named next action. Unchecked work usually means a request cap, a session budget or a collection bound, not a clean result.

---

## Files and paths

### Files are refused, skipped or truncated

Path confinement is a property of collection, not of judgment. Each refusal names its cause.

**Outside the repository, absolute or parent traversal:**

> Path must remain inside the repository: <path>.

— `src/adapters/files.ts`

> Path escapes the repository: <path>.

— `src/adapters/files.ts`

> Symbolic links are not read: <path>.

— `src/adapters/files.ts`

**Internal URLs passed as files:**

> Internal URLs are not files; use read for <path>.

— `src/adapters/ask-files.ts` (and `src/adapters/locate-file.ts`)

**Git metadata or ignored files:**

> <path>: .git metadata: not sent to Jev

— `src/adapters/files.ts`

> <path>: gitignored: not sent to Jev

— `src/adapters/files.ts`

**Size and type:**

> <path> is empty.

— `src/adapters/files.ts`

> Not a file: <path>.

> Not a text file: <path>.

— `src/adapters/locate-file.ts`

> <path> (build output or dependencies)

> <path> (lockfile)

> <path> (symbolic link)

> <path> (not a regular file)

> <path> (binary or invalid UTF-8)

> <path> (missing)

— `src/adapters/ask-files.ts`; these appear under a `skipped:` list rather than as a refusal

> <N> binary, empty or unreadable paths ignored: …

> narrow scope to text files

— `src/tools/find.ts`

> small file (<N> lines): read it directly

— `src/tools/locate.ts`

**Fix.** Pass repository-relative tracked text paths. Use `glob` or the host's filename search for a name, `read` for a file outside the repository, and `read` directly for a small file.

### A path is refused in a base comparison

> <path>: not a file at comparison base

— `src/adapters/files.ts`

> Cannot resolve base=<ref>: history may be truncated or no shared ancestor is available. Run git fetch --unshallow (or git fetch --deepen=<count>), or choose a base that is an ancestor of HEAD.

— `src/adapters/git-base.ts`

> Git interrupted (cancelled or timed out).

— `src/adapters/git-base.ts`

**Fix.** Fetch more history, or pass a `base` that is an ancestor of `HEAD`.

### An `asks` value is rejected

> Invalid intention or missing field. Example: {"intent":"verify","claims":{"c1":"The file validates tokens"}}

> Invalid asks JSON. Example: {"intent":"verify","claims":{"c1":"The file validates tokens"}}

— `src/core/asks.ts`

> categories.none is reserved; omit it, use a non-reserved option name. Example: {"intent":"classify","categories":{"validation":"Validates arguments"},"pick":"one"}

— `src/core/asks.ts` (the `Example:` clause is fixed text in the template; `none` is the reserved name it reports)

> Provide state, command or at least one path.

— `src/tools/ask.ts`

> Provide at least one path, directory or glob.

— `src/adapters/ask-files.ts`

> timeout_s must be between 1 and 300

— `src/tools/ask.ts`

> state contains reserved key output when command is supplied; rename it in your note

— `src/tools/ask.ts`

> risk state exceeds STATE_MAX_CHARS=80000; rerun with base= a nearer ref

— `src/tools/check-diff.ts`

**Fix.** Use the intent names and field names from the tool reference; `none`, `other`, `cannot_tell` and `not_addressed` are reserved option names, and `other` is added for you.

---

## `entry: none`

`entry: none` means no supplied candidate served the goal, not that the repository lacks the behavior. The accompanying limit names the usual cause:

> scope matched 0 files

> no file shares a word with the goal

> rephrase goal or widen scope

— `src/tools/find.ts`

> no file retained by content or names guard

> rephrase goal or widen scope

— `src/tools/find.ts`

> pointer chose none

> rephrase goal or widen scope

— `src/tools/find.ts`

In [jev_locate_in_file](../tools/jev_locate_in_file.md) the equivalent is:

> no section fits

> search elsewhere

— `src/tools/locate.ts`

**Fix, in order.** Rephrase `goal` as a behavioral sentence of at least five content words; widen or drop `scope`; check that `exclude` globs are not swallowing the implementation; then fall back to native filename search. A goal under five content words is capped at unsure and says so.

---

## Host differences

### omp: `find` versus `jev_find_files`

In omp, `jev_find_files` **starts inactive when the native semantic `find` is active**; when native `find` is absent, session startup activates `jev_find_files`. omp filename search is `glob`. In pi, the semantic tool is exposed alongside the native filename `find` and is always present.

**Fix.** If you expected `jev_find_files` in omp and it is not in the active tool list, check whether native semantic `find` is active. Use native `find` when it is available. See [jev_find_files](../tools/jev_find_files.md#host-differences).

### pi: `rules/` discovery

omp discovers enabled npm plugin rules during normal startup. pi does not automatically discover the package's `rules/` directory; the same decision policy ships as part of the `jev_ask` tool guidelines, so it is present whenever `jev_ask` is active. A forced opaque prompt override, disabled tools or disabled omp rules are not covered by this integration.

**Fix.** If the decision policy seems absent in pi, confirm `jev_ask` is in the active tool list. Do not count on `rules/` being discovered there.

### The reading guide is missing

The shared reading guide reaches you through two different channels. In pi it is recomputed at every `before_agent_start` and attached as a system-prompt section, but only while at least one selected tool name starts with `jev_`; when none is selected the section is removed. In omp it is delivered once as additional context on the first tool call of the session, and that delivery is re-armed on `session_compact` so it is offered again after a compaction.

**Fix.** Nothing to configure; ensure at least one `jev_*` tool is active and that you have made a tool call.

---

## The automatic documentation check did not run

The run-end check is the only automatic automation, it runs at most once per user prompt, and it uses the `docs` preset against changes from `HEAD`, untracked files included. The two hosts trigger it at different moments: omp on `session_stop`, pi on `agent_before_settle` when the outcome is `completed`. It is skipped when:

- the tree is clean — nothing is judged, and the change is not reported;
- configuration is missing, or `JEV_TOOLS_AUTO_DOCS=0`;
- a session budget is invalid or already exhausted;
- the check already ran for the current user prompt, or another check is in flight;
- collection, request or the 15-second run-end budget runs out;
- the only candidate results are `unsure` — merely unsure sections do not request another turn;
- on omp, the run is a sub-agent session or a stop hook is already active.

When it does find something, it requests one additional turn. This is the **template** in `src/texts/run-end.ts` with substituted values, so the path, heading, sentence and unit differ per finding. The sentence is wrapped by `JSON.stringify`, which is where the surrounding quotes come from:

> jev_check_diff (docs) flagged documentation that may no longer match your changes:
>
> - <path> § <heading> — "<sentence>" no longer true after <unit> in <file>
>
> Update them, or say why they are still correct.

— `src/texts/run-end.ts`

Empty comparisons are reported rather than passed over:

> no changed units against <base>

> nothing judged; pass base= or check the working directory

— `src/tools/check-diff.ts`, `src/tools/docs-check.ts` and `src/tools/spec-check.ts`

Partial collection is bounded and visible:

> Candidate limit reached: documentation anchors unexplored.

> Dependency exploration incomplete: collection budget, candidate limit, or per-anchor bound reached.

— `src/core/docs.ts`

> matching documentation unjudged

— `src/tools/docs-check.ts` (a section title, rendered by `src/render.ts` from a `collection` line)

And the preset states its own reach:

> Docs check flags existing sentences the change may have made false; it does not detect missing documentation.

> Also review missing documentation: this check evaluates existing sentences, not documentation completeness.

— `src/tools/docs-check.ts`

**Fix.** Run [jev_check_diff](../tools/jev_check_diff.md) with `{"check":"docs","base":"HEAD"}` yourself. Errors and timeout at run end never block the host, so a silent run is not itself an error.

---

## Cost and usage

### The footer shows `cost unavailable`

The yield footer always reports **calls · questions · cost · cache · time**. This is the **template** in `src/render.ts` with substituted values; the `cost unavailable` branch is taken when `costUsd` is `undefined`:

> <calls> calls · <questions> questions · cost unavailable · cache <hits>/<requests> · <s> s

— `src/render.ts`, which formats the yield value built in `src/core/output.ts`; the literal `cost unavailable` is the `costUsd === undefined` branch there

`cost unavailable` appears when the response carried no usable usage figure: the client reads cost from the response `usage` object and records it only when `input_tokens` and `cost` are present, finite and non-negative. **This is not evidence of a free request** — the call still happened and the other counters are still real.

**Fix.** Check the endpoint's own accounting. Also note that command judgments bypass caching, so the cache counters do not describe command evidence, and a model name echoed by the response does not establish which model was actually served.

### `Jev HTTP 401` / `Jev HTTP 403`

> Jev HTTP 401: <redacted message>; check JEV_TOOLS_API_KEY.

— `src/jev/client.ts`

The API key is redacted from diagnostics, and credentials supplied by the environment are never printed in tool output.

**Fix.** Correct `JEV_TOOLS_API_KEY` or the stored key, then restart or re-run `/jev-setup`.

### `Jev max_tokens_exceeded`

> question exceeds the per-evaluation budget (~N tokens > EVALUATION_MAX_TOKENS=30000); not judged

— `src/core/batches.ts`

This one is decided locally, before any request. The state and that question are
estimated with the same planning coefficients used for request packing; the
estimate is a heuristic, so a question under the bound is still not guaranteed to
be accepted by the endpoint, and a question over it is withheld rather than sent
and rejected. No round trip is spent.

If the endpoint rejects a request anyway:

> Jev max_tokens_exceeded: state too large for a single question; question not judged.

> Jev max_tokens_exceeded: state too large for a single question; remaining questions not judged.

— `src/jev/client.ts`

and, when a question cannot be subdivided any further:

> Jev max_tokens_exceeded: indivisible question group refused.

— `src/core/batches.ts`

A splittable batch is subdivided automatically; only a single indivisible question is left unjudged and reported.

**Fix.** Reduce the evidence — fewer paths, a shorter note, a narrower command, or a nearer `base`.

---

## Quick checklist

1. Configured? The first line of the output is a message, not an answer — read it verbatim.
2. Fields controlled? Environment and flags win and are never saved.
3. Budget valid? Invalid values refuse everything with the exact correction in the message.
4. Evidence admitted? `skipped:`, `unchecked:` and bracketed lines name what never reached judgment.
5. Marks read? `unsure` needs the decisive file, `abstain` needs the named evidence, `uncalibrated` is a hint.
6. Report honest? Every `unsure` or `abstain` conclusion stays labeled unconfirmed unless you settled it yourself and cited the evidence.

Still stuck? Reproduce with synthetic data and report it through the route in [SECURITY.md](../../SECURITY.md) for anything touching trust boundaries, or as an ordinary issue with package and host versions, expected and actual behavior, and a minimal sanitized reproduction.
