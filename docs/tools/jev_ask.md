# jev_ask

Ask typed questions about one situation assembled from a note, files, earlier versions and optional command output.

## Use for

Compare a failing test with the code it calls, check a plan against documentation, or judge behavior that depends on several pieces of evidence. Provide both sides of a comparison and the evidence that distinguishes rival explanations.

## Use another tool when

Use [jev_ask_files](jev_ask_files.md) for independent answers per file. Use native read or shell execution when you need source text or full output, and native search for exact matches. Use [jev_check_diff](jev_check_diff.md) for fixed review checks over a finished diff.

## Evidence model

The tool assembles one JSON situation. A note appears as `state`; repository files as `files["path"]`; historical versions as `files_before["path"]`; and command evidence as `output` with `command`, `exit_code`, `timed_out`, `stdout` and `stderr`. You receive answers, not the assembled file contents or captured output. Jev reads the evidence at a glance; it does not count, calculate or infer missing dependencies. Evidence outweighs an explanation of its role.

Before judgment, bounded depth-one static import closure adds supported used declarations and data files, including before/after versions when applicable. A closure diagnostic records additions and gaps; it cannot establish completeness or discover relationships without imports. Explicit `files[...]` and `files_before[...]` selectors name required evidence. Ordinary lexical mentions such as `.only` or `process.env` do not create missing-file vetoes, and names printed in command output are not disk evidence. An exact path with directory segments never falls back to another file with the same basename. For abbreviated references, a uniquely matching supplied file takes precedence over inventory discovery; ambiguity is reported, not guessed.

One canonical path stores each file version; lightweight aliases do not duplicate content. Current and base versions remain distinct, and the 20-file limit counts distinct file identities, not their versions. A before-only selector can load historical content without a current file. `null` denotes a proven absent base version, not unavailable evidence. Missing/empty requirements exclude their question group and its controls; a requirement in the global note applies to all groups. Numeric zero and boolean false are not empty evidence.

For recognizable assertion failures, the tool attempts to attach the failing test named by the log. An unidentifiable target produces a warning; any bug-versus-wrong-test conclusion under that warning remains unproven. Pass the failing test and implementation yourself whenever possible.

## Parameters

At least one of `state`, `paths` or `command` must provide evidence.

| Field | Type / default | Meaning |
|---|---|---|
| `root` | Optional nonempty string | Exact initial Git root or registered worktree of the same repository; see [evidence-root admission](../../README.md#evidence-root). |
| `state` | Optional string, at most 8,000 characters | Short request, plan or observation not shown by the files; not a place to paste files or logs. JSON object text is accepted, but reserved evidence keys such as `files`, `files_before`, `evidence` and `output` cannot be supplied by the note. |
| `paths` | Optional array of nonempty strings, at most 20 | Repository-relative files to read; not recursive directory or glob triage. |
| `base` | Optional nonempty Git ref | Add historical versions for the resolved revision; only established absence is `null`. Use `HEAD` for uncommitted before/after questions. Both versions count toward serialized evidence admission. |
| `command` | Optional nonempty string | Execute `bash -c` at the repository root with `CI=1`, normal shell permissions and no additional sandbox. |
| `timeout_s` | Optional number, default 60, range 1–300 | Command timeout in seconds. |
| `asks` | Required intent, nonempty intent array, or JSON string encoding them | Typed questions; one intent per judgment. |
| `max_calls` | Optional non-negative integer | Limit requests including controls and output passage finding; unjudged work is reported. |

All intents may add `about: string` naming the relevant evidence, such as `state`, `output`, `files` or `files["src/billing.ts"]`.

| Intent | Fields | Meaning |
|---|---|---|
| `verify` | `claims: {id: statement}` | Verify one positive self-contained factual statement per claim, preserving its exact text. |
| `classify` | `categories: {name: description}`, optional `pick: "one"` (default) or `"many"`, optional `by: string` | Pick a category or independently judge each; `by` describes the dimension. |
| `decide` | `hypotheses: {name: statement}` | Choose among mutually exclusive rivals, including fallback outcomes. |
| `rate` | `dimension: string`, `levels: string[]` | Choose among 2–10 concrete ordered situations on one dimension. |
| `locate` | `target: string`, nonempty `among: string[]`, optional `count: "one"` (default) or `"many"`, optional `attribution: boolean` | Identify candidates serving the target. Attribution is supported only for `count: "one"`. |
| `free` | `question: {type, instructions, criteria?}` | Custom uncalibrated bool, choice or score. |

Nonempty maps are limited to 255 entries, including room for generated choice fallbacks. `free.instructions` must be nonempty; bool criteria optionally describe `true`/`false`, choice criteria map options to descriptions, and score criteria contain 2–10 levels. Unknown fields and invalid intent shapes are rejected. Claims should not be questions, counts, dates or compound assertions; warnings preserve your original wording. Put every ask you need in one request. Attribution makes an additional judgment without the pointed file: `attributed` means the pick moved away; `does not rest on it` means it did not. This is an evidence-dependence check, not runtime causality.

## Example

Illustrative call with fictional repository paths, not a recorded execution:

```json
{
  "paths": ["src/billing.ts", "test/billing.test.ts"],
  "base": "HEAD",
  "asks": [
    {
      "intent": "verify",
      "about": "files[\"src/billing.ts\"]",
      "claims": {"rounding": "prorate rounds down to the whole cent"}
    },
    {
      "intent": "classify",
      "about": "files",
      "categories": {
        "bug_in_code": "the implementation violates behavior required by the test and contract",
        "wrong_test": "the assertion contradicts the documented contract"
      },
      "pick": "one"
    }
  ],
  "max_calls": 4
}
```

## Results and next action

Verification distinguishes `holds`, `contradicted`, `not addressed by the state` and `cannot tell`. An exact-statement boolean cross-check cannot override evidence issues or prove contradiction alone; scope/evidence disagreement produces unsure with raw values. Choices under 0.85 or failed controls produce unsure; missing evidence produces abstain and names the needed piece. Read surprising files or output directly. Add the decisive evidence rather than rewording. See [shared result reading](../../README.md#read-the-results).

## Limits and failure behavior

Serialized evidence, including keys and escapes, is bounded to 80,000 characters. Oversized files/state are refused with a split suggestion, not silently shortened. Repository file confinement rejects escaping paths and internal URLs.

Commands are captured in private temporary files and cleaned up. Captured streams over 64 MiB are refused after execution; this neither caps disk usage nor interrupts execution. Repeated line shapes are compressed; lines over 8,192 characters and more than 2,048 distinct shapes produce visible notices. If compression still cannot fit, bounded passage judgments retain failure details and beginning/end context with omission markers. Command output reaches this stage before immutable file/note budget refusal, including calls with base snapshots and import closure. Excessive passage work is refused with guidance to narrow the command. Reports distinguish not started, finished and unknown execution, preserve observed cwd/exit/timeout even if later processing fails, and do not equate a judgment refusal with an unexecuted command. A timeout gives `exit_code: null` and `timed_out: true`, not success; cancellation stops without judgment. Command calls bypass caching. `JEV_TOOLS_ALLOW_COMMAND=0` disables command evidence. Missing endpoint/key refuses judgment without a chat-model fallback.

## Host differences

omp assigns read approval without `command` and execution approval with it. pi does not add per-tool execution approval: the command has the shell's ordinary permissions. Both hosts receive shared reading guidance; in pi the decision policy is part of this tool's guidelines while `jev_ask` is active, whereas omp discovers enabled package rules normally. Forced prompt overrides or disabled rules can bypass guidance.

## Related tools

[Per-file triage](jev_ask_files.md), [fixed diff review](jev_check_diff.md), [design policy](../design.md).
