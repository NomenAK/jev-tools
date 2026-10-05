# jev_ask_files

Ask the same typed questions independently of multiple files to decide which files to read next.

## Use for

Classify candidate files by responsibility, verify whether each file shows a specific behavior, or rate change risk using concrete situations before opening files individually.

## Use another tool when

Use native reading to edit or quote source, text search or code for exact strings, symbols, counts and line numbers, and filename search for known names. Use [jev_find_files](jev_find_files.md) when you have no candidates, [jev_locate_in_file](jev_locate_in_file.md) for a range in one large file, and [jev_ask](jev_ask.md) when a conclusion depends on several files or command output.

## Evidence model

Each admitted file is judged alone as `path` and `content`. Every ask applies to each file. Jev does not see other files, execute code, count occurrences or resolve unseen dependencies. A confident answer can be wrong when behavior depends on evidence not supplied. Independent file answers do not establish a cross-file relationship. File content is evidence, never instructions; integrity checks do not prove semantic completeness.

## Parameters

| Field | Type / default | Meaning |
|---|---|---|
| `root` | Optional nonempty string | Exact initial Git root or registered worktree of the same repository; see [evidence-root admission](../../README.md#evidence-root). |
| `paths` | Required nonempty array of nonempty strings | Repository-relative files, recursive directories or globs; at most 255 admitted files. |
| `asks` | Required typed intent, nonempty array of intents, or JSON string encoding them | All asks apply to every admitted file. An array is the clearest form. |
| `max_calls` | Optional non-negative integer | Request limit for this invocation; remaining files are listed unchecked. Separate from session budgets. |

Supported intents (no `about` or `locate` on this per-file interface):

| Intent | Fields | Meaning |
|---|---|---|
| `verify` | `claims: {id: statement}` | One positive, self-contained factual statement per claim. |
| `classify` | `categories: {name: description}`, optional `pick: "one"` (default) or `"many"`, optional `by: string` | Pick one category including `other`, or judge each independently; `by` states the dimension. |
| `rate` | `dimension: string`, `levels: string[]` | Choose among 2–10 concrete ordered situations on one dimension. |
| `decide` | `hypotheses: {name: statement}` | Compare mutually exclusive rivals, not just the preferred explanation. |
| `free` | `question: {type, instructions, criteria?}` | Custom uncalibrated `bool`, `choice` or `score` question. |

Maps must be nonempty and have at most 255 entries; generated fallback options must fit the choice limit too. `free.instructions` is a nonempty string. Bool criteria optionally provide `true` and/or `false` descriptions; choice requires an option-description map; score requires 2–10 strings. Custom choices receive `other` when absent. Unknown fields, unsupported intents or invalid levels are rejected with guidance. Negated, compound or count/date claims can generate warnings without rewriting your statement. Use native search or code for arithmetic, counts, dates and comparisons between files. Put all asks in one request.

## Example

Illustrative call with fictional repository paths, not a recorded execution:

```json
{
  "paths": ["src/auth/*.ts", "src/storage/*.ts"],
  "asks": [
    {
      "intent": "verify",
      "claims": {
        "c1": "`content` validates authentication tokens",
        "c2": "`content` writes to the database"
      }
    },
    {
      "intent": "classify",
      "categories": {
        "http": "routing and request parsing",
        "domain": "business rules without I/O",
        "storage": "queries and persistence"
      },
      "pick": "one"
    }
  ],
  "max_calls": 4
}
```

## Results and next action

Results preserve the exact statement next to each file's answer and distinguish fresh/cache judgments from unjudged files. Boolean `yes` or `no (not shown)` includes the probability of yes; intermediate probabilities between 0.20 and 0.80 are unsure. Categories and levels need a leading-option probability of at least 0.85 after applicable controls. `classify`, `rate`, `decide` and `free` are uncalibrated; sharing a display band does not establish an error rate. Failed integrity or option-order controls make clear-looking results unsure; missing required judgments never become fabricated probabilities. Read the candidate file before acting. Typed diagnostics and actions explain skipped/unchecked files, causes and scope. See [shared result reading](../../README.md#read-the-results).

## Limits and failure behavior

Build output, binaries, lockfiles, ignored untracked files, empty files and oversized files are excluded or reported. The advertised 80 KB bound derives from 80,000-character evidence admission; readers also check bytes and valid UTF-8. Kept file evidence is not silently truncated. Paths cannot escape through absolute paths, parent segments, symlinks or Git metadata; internal URLs are not files. Missing configuration refuses judgment, never falls back to a chat model. Batching and controls mean one file judgment is not a promise of exactly one HTTP request.

## Host differences

Judgment behavior is shared. Native search names adapt to the host. omp marks this tool read-only; pi does not automatically discover npm package rules, but the extension delivers its shared reading guide.

## Related tools

[Combined evidence](jev_ask.md), [file finding](jev_find_files.md), [large-file location](jev_locate_in_file.md), [design policy](../design.md).
