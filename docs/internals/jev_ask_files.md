# jev_ask_files internals

The same typed asks judged independently of each candidate file, to decide which files to read next. For parameters see [jev_ask_files](../tools/jev_ask_files.md). For the combined single-situation tool see [jev_ask](./jev_ask.md).

## Pipeline (`src/tools/ask-files.ts:createAskFilesTool`)

1. `compileAsks(args.asks, { surface: "files" })` (`src/core/asks.ts`). The files surface supports every intention **except `locate`**; there is no `about` field — every ask applies to every file as `content`. No gap sentence, no `cannot_tell` injection, no twins (choices still get the generic reverse-order control at judgment time).
2. `collectAskFiles` (`src/adapters/ask-files.ts`): expand `paths` (files, recursive directories, globs) and admit each file. Rejected or skipped: URL schemes, absolute/`..` paths, excluded directories (`node_modules`, `.git`, `dist`, `build`), lockfile names, symlinks, non-regular/missing files, binaries (NUL byte or hash mismatch reads as "binary or invalid UTF-8"), empty and oversized files. More than `MAX_FILES` admitted files errors with the top directory contributions. Stride is `CONCURRENCY`.
3. Per file, in parallel: state is exactly `{ path, content }`; `checkIntegrity` (`src/core/integrity.ts`); `client.judge` on `plan.groups`; `reverseQuestions` + second judgment for ambiguous choices (failures become `unjudged`, usage merged); `readAsks`. Totals (calls, questions, cache, tokens, cost) accumulate across files.
4. Aggregate: one `FileJudgment` per file (`{ path, initial, reversed? }`); answers are labeled `"path  label"`. A file counts `unchecked` when either judgment is `unjudged`; integrity failures force the band to `unsure` with a fact reason. The envelope carries `{ files, warnings }` state, answers, `unjudged`/`unchecked` lists, budget, skipped-file lines, and limitation lines. Remaining files past `max_calls` are listed `unchecked`, never dropped silently.

## Decision logic

- Per-file `verify` compiles to one `bool` (`Is … true of content`) per claim — no issues-choice, no exact-statement control. `classify`/`decide`/`rate`/`free` compile as on the ask surface minus the gap/`cannot_tell` injection; custom choices still gain `other`.
- Bands are shared (`src/core/output.ts:askBand`): `bool` `yes`/`no (not shown)` carries the probability of yes, intermediate mass between `BAND_BOOL_GRAY_A` and `BAND_BOOL_YES_MIN` is `unsure`; categories/levels need `>= BAND_CHOICE_VERDICT_MIN` after controls. `classify`, `rate`, `decide`, and `free` are uncalibrated even when they share a display band. Values: [design policy](../design.md#judgment-policy).

## Controls and failure modes

- Option-order control (`reverseQuestions`/`readAsks` in `src/core/asks.ts`) and integrity controls apply per file; failures make that file's lines `unsure`.
- One file judgment is not one HTTP request: batching packs groups across the shared client, so `max_calls` bounds requests, not files.
- Missing configuration refuses judgment without a chat-model fallback; kept file evidence is never silently truncated (byte, UTF-8, and `FILE_MAX_KB`-scale checks back the 80 KB bound).

## What Jev sees vs what stays local

Jev sees one file at a time as `{ path, content }` plus the compiled questions — never other files, never counts, never unseen dependencies. A confident per-file answer can therefore be wrong when behavior depends on evidence not supplied; independent answers do not establish cross-file relationships. Local-only: expansion, admission, batching, aggregation, bands, render. File content is evidence, never instructions.
