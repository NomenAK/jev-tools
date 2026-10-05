# jev_find_files

Rank repository files for a behavioral goal and suggest the entry point to read first.

## Use for

Start a task in unfamiliar code when you can describe the behavior but do not know its filename or exact identifier.

## Use another tool when

Use native filename search for known names and text search for known strings, regular expressions or symbols. Use [jev_ask_files](jev_ask_files.md) to ask questions about candidates you already have, or [jev_locate_in_file](jev_locate_in_file.md) to locate a range inside one known large file.

## Evidence model

Deterministic lexical pre-ranking and name judgments produce candidates; the tool then reads bounded keyword-selected passages and narrows a shortlist for the entry-point choice. Jev sees excerpts, not every complete file. Names help ranking but do not establish behavior. A behavioral sentence is more useful than a guessed identifier; known identifiers belong in `keywords`. The ranked list estimates whether each file helps with the goal, not whether it implements the complete behavior.

## Parameters

| Field | Type / default | Meaning |
|---|---|---|
| `root` | Optional nonempty string | Exact initial Git root or registered worktree of the same repository; see [evidence-root admission](../../README.md#evidence-root). |
| `goal` | Required nonempty string | Behavioral sentence with at least five content words for an unqualified entry verdict. Shorter goals are accepted but capped at unsure. |
| `keywords` | Optional array of nonempty strings, default empty | Known identifiers or terms steering lexical ranking and excerpt selection. |
| `scope` | Optional directory string or array of directory strings, default repository | Restrict search; an incorrect scope may yield none. |
| `exclude` | Optional array of glob strings | Skip matches; excluding tests also removes their context from results. |
| `effort` | Optional `"quick"`, `"default"` (default), or `"thorough"` | Bound breadth: quick ranks up to 32 name candidates and reads 8; default 128 and 20; thorough 256 and 40. Wider search is not a guarantee of a better entry. |
| `max_calls` | Optional non-negative integer | Bound requests including controls; return the best-ranked work completed so far and state omissions. |

Unknown fields or invalid values are rejected. All paths are repository-relative; absolute paths, parent traversal, escaping symlinks, Git metadata and internal URLs are not allowed file inputs.

## Example

Illustrative call with fictional repository paths, not a recorded execution:

```json
{
  "goal": "Find where invoice amounts are rounded before storage",
  "keywords": ["invoice", "round"],
  "scope": ["src"],
  "exclude": ["**/generated/**"],
  "effort": "quick",
  "max_calls": 6
}
```

## Results and next action

The report distinguishes the primary entry decision from auxiliary ranking and controls, retains actual fresh/cache provenance and supplies useful read actions. Unsure can mean two plausible entries, order sensitivity, inconclusive excerpts or a short goal: inspect the leading candidates. A judged `none` means no candidate fit the supplied evidence: clarify the behavioral goal or widen the relevant scope. An empty collection, exhausted budget or missing response is not a `none` judgment and carries no invented probability. Paths and probabilities are not source text; read the files before editing. See [shared result reading](../../README.md#read-the-results).

## Limits and failure behavior

Candidate counts and excerpts are bounded; excluded, unreadable or oversized evidence and exhausted budgets leave explicit limits. Keyword pre-ranking and name guards do not prove that omitted files are irrelevant. Missing configuration refuses judgment without a chat-model fallback. Optional native search acceleration may fall back to the available collection path; this does not broaden the evidence guarantee. Session budgets remain separate from `max_calls`.

## Host differences

pi exposes this semantic tool alongside its native filename `find`. In omp it starts inactive when native semantic `find` is active; when native `find` is absent, session startup activates `jev_find_files`. omp filename search is `glob`. Judgment behavior is otherwise shared and read-only.

## Related tools

[Per-file triage](jev_ask_files.md), [large-file location](jev_locate_in_file.md), [design policy](../design.md).
