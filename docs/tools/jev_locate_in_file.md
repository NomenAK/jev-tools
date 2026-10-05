# jev_locate_in_file

Choose the line range in one large file that serves a behavioral goal, then read that range directly.

## Use for

A known file is too large to read whole and you need the part serving a particular goal, such as retry scheduling or flag parsing. Prefer goal-based location to opening arbitrary successive chunks.

## Use another tool when

Use native text search for known symbols or strings, direct reading for files smaller than 19 KB, [jev_find_files](jev_find_files.md) for unknown filenames, and [jev_ask_files](jev_ask_files.md) for independent questions about multiple files.

## Evidence model

Code splits the file into declarations or sections and constructs a choice over relevant ranges. Larger files use streamed window outlines and refinement, with explicit limitations. Jev reads supplied source, not runtime behavior. Several sections can legitimately share a goal, dividing probability between them; two plausible ranges do not imply that either is wrong. Optional parser failures use heuristic sections and report the gap.

## Parameters

| Field | Type / default | Meaning |
|---|---|---|
| `root` | Optional nonempty string | Exact initial Git root or registered worktree of the same repository; see [evidence-root admission](../../README.md#evidence-root). |
| `path` | Required nonempty string | One repository-relative file, at least 19,000 bytes. |
| `goal` | Required nonempty string | Sentence describing the behavior you need to find. |

There is no per-invocation `max_calls` parameter; session budgets still apply. Unknown fields are rejected. Absolute paths, parent traversal, escaping symlinks, Git metadata and internal URLs are not file inputs.

## Example

Illustrative call with a fictional repository path, not a recorded execution:

```json
{
  "path": "src/scheduler.ts",
  "goal": "Find the section that reschedules tasks after a transient failure"
}
```

## Results and next action

A result names `path:start-end`, a label, probability and the next read. A leading probability at or above 0.7 is a verdict: read it. Otherwise the result is unsure listing the two best ranges by probability: read both, not an arbitrary next section. Option-order sensitivity can also leave the result unsure. `none` means no supplied section fits: search elsewhere or clarify the goal. See [shared result reading](../../README.md#read-the-results).

The versioned report preserves actual primary/control values and their fresh/cache source. Missing required control answers produce unjudged work rather than a synthesized range or probability. Typed diagnostics retain parsing/window omissions and native next actions, including searching elsewhere for a judged `none`.

## Limits and failure behavior

Small files are refused with direct-read guidance. Whole-file admission is bounded by 320,000 characters and 1,280,000 bytes; larger files take the streamed-window path, not silent whole-file truncation. Window serialization, fallback section sizes, parsing support and choice cardinality are separately bounded. Unreadable or invalid evidence, missing configuration and exhausted session budgets are reported rather than producing a range verdict. Missing optional Python grammar is named with installation guidance. A selected window does not prove every relevant declaration was inspected.

The serialized judgment budget includes per-call evidence provenance. Block planning, excerpt allocation and full-text refinement reserve that metadata capacity before selecting evidence; provenance never silently pushes an otherwise planned request past admission. Selected blocks still require at least two sections and obey the choice limit.

## Host differences

omp `read` already outlines code files: use this tool when that outline does not tell you which range serves your goal. Both hosts use the same judgment protocol; omp marks the tool read-only.

## Related tools

[Semantic file finding](jev_find_files.md), [per-file triage](jev_ask_files.md), [design policy](../design.md).
