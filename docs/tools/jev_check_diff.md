# jev_check_diff

Review a finished diff for risk, stale existing documentation or specification drift using fixed questions.

## Use for

Review completed changes before committing or reporting completion, review a branch against a Git ref, or check whether existing documentation remains true after source changes.

## Use another tool when

Use native `git diff` execution to read the diff, [jev_select_tests](jev_select_tests.md) to choose existing tests, and [jev_ask](jev_ask.md) for your own typed judgment. Do not review a half-written change as if it were complete.

## Evidence model

Changed declarations, slices, files or hunks become before/after evidence units. Tests are supporting evidence, never units to judge. Preset questions are fixed in code; the caller chooses a check, not raw questions. Jev does not run the code. Verbatim specification text is evidence, not instructions.

## Parameters

| Field | Type / default | Meaning |
|---|---|---|
| `check` | Required `"risk"`, `"docs"` or `"spec"` | Select the preset below. |
| `base` | Optional nonempty Git ref, default `HEAD` | Compare the current tree, including untracked files, with this revision. |
| `spec_path` | Optional nonempty repository-relative string | Required for `spec`: Markdown specification with `### REQ-…` headings. |
| `witnesses` | Optional `"off"`, `"auto"` (default), `"on"` | Control decoy/reference evidence in the built-in risk matrix. |
| `dimensions` | Optional map of names to nonempty statements | Additional risk rules: positive statements true of a risky change. Built-in names are reserved. Marked uncalibrated, without severity or witnesses. |
| `only` | Optional nonempty array of distinct nonempty names | Restrict risk to named built-in or custom dimensions; custom names must be supplied in `dimensions`. |
| `max_calls` | Optional non-negative integer | Bound all requests, including local-caller checks, controls and severity; unjudged work remains unchecked. |

Custom dimensions and `only` apply to risk and are ignored by docs/spec. Unknown fields, invalid risk dimensions or unresolved refs are rejected with guidance. File paths follow repository confinement.

### risk

Ask built-in correctness, security, compatibility and reliability questions, then grade flagged risks by severity. Optional witnesses check the setup with decoy and known-positive evidence. Failed witnesses make findings unsure with raw values and a reason.

For replaced member accesses, separate local-caller checks inspect statically resolved tracked callers, including import aliases, and their imported providers. They account for coordinated caller/provider edits. Literal-name discovery cannot cover dynamic access that never names the target. Unknown providers, partial units and metaprogramming remain visibly unchecked. Local checks run once per eligible unit, not once per caller; local evidence limits do not invalidate the separate risk matrix.

### docs

Judge up to 40 existing tracked Markdown sections mentioning changed code or importing source, and identify the existing sentence made false. Collection and traversal limits are visible. This is not an exhaustive detector of missing documentation, arbitrary companion edits or every stale sentence.

### spec

Judge requirements under `### REQ-…` headings against changed behavior and identify behavior absent from the specification. `spec_path` is required and read inside the repository. Markdown tables produce an explicit interpretation limit; an arbitrary document without requirement headings is not treated as a complete specification.

## Example

Illustrative call with a fictional repository convention, not a recorded execution:

```json
{
  "check": "risk",
  "base": "HEAD",
  "witnesses": "auto",
  "dimensions": {
    "rounding": "The change rounds a monetary amount before the final conversion to cents"
  },
  "max_calls": 12
}
```

For another preset, use `{"check":"docs","base":"HEAD"}` or `{"check":"spec","base":"HEAD","spec_path":"docs/requirements.md"}`; these are also illustrative calls, not recorded executions.

## Results and next action

Findings name the evidence unit, stale sentence or requirement and its probability. Fixed findings require at least 0.7. Docs probabilities from 0.2 up to 0.7 are unsure without an additional judgment; read the indicated wording. Local-caller probabilities between 0.2 and 0.7 are unsure; `cannot_tell` at least 0.3 is abstain naming the missing provider or binding. Failed witness batches remain unsure. Read flagged source, callers or documentation before editing and preserve unresolved uncertainty in reports. See [shared result reading](../../README.md#read-the-results).

## Limits and failure behavior

No findings is not proof of safety, unseen-caller coverage or complete documentation. Unjudged units, callers, sections, requirements and severity are named when request or session budgets stop work. Parser gaps and unresolved dynamic providers remain limits, not invented answers. Missing configuration refuses judgment without a chat-model fallback. Static collection is bounded and does not evaluate third-party code.

## Host differences

Explicit checks share the same read-only contract in pi and omp. The extension also runs only the docs preset automatically at eligible run end; see [automatic documentation checking](../../README.md#automatic-documentation-check). Risk and spec never run automatically.

## Related tools

[Typed situation judgment](jev_ask.md), [existing test selection](jev_select_tests.md), [design policy](../design.md).
