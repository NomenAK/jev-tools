# jev_locate_in_file internals

Choose the line range in one large file that serves a behavioral goal. For parameters see [jev_locate_in_file](../tools/jev_locate_in_file.md). For unknown filenames use [jev_find_files](./jev_find_files.md).

## Pipeline (`src/tools/locate.ts:createLocateTool`)

1. `readLocateFile` + `scanRange` (`src/adapters/locate-file.ts`): read the file through a `LOCATE_READ_BUFFER_BYTES` streaming buffer. Files under `LOCATE_MIN_KB` (19 KB, by bytes) are refused with direct-read guidance. Whole-file admission is capped at `LOCATE_WHOLE_MAX_BYTES` / `LOCATE_WHOLE_MAX_CHARS`; larger files take the streamed-window path (windows of `LOCATE_WINDOW_LINES` lines, labels capped at `LOCATE_LABEL_MAX_CHARS`, serialization headroom `LOCATE_WINDOW_MAX_SERIALIZED_CHARS`) — never silent whole-file truncation.
2. `sectionFile` (`src/core/sections.ts`): split into sections — syntax declarations when the optional parser supports the language, Markdown sections for `.md`, otherwise heuristic or window sections; pieces split over `LOCATE_SECTION_MAX_LINES`, merged under `LOCATE_SECTION_MIN_LINES`. Parser gaps yield heuristic sections plus an explicit limit.
3. `sectionState` / `sectionStateFits` (`src/core/locate.ts`): build the outline state within `STATE_MAX_CHARS` and `CHOICE_MAX_OPTIONS`. Two-stage plan: judge the section outline first (`sectionOutline` + outline evidence), then refine the winning block via `scanRange`.
4. Pointer judgment (`pointerQuestion` / `readPointer` / `needsReverse` in `src/core/pointer.ts`) over the candidate ranges plus `none`.

## Decision logic

- Above `LOCATE_VERDICT_MIN` (0.7) an unmarked range is a verdict: read it. From `LOCATE_GRAY_MIN` (0.4) through 0.7, `unsure` lists the two best ranges — read both, not an arbitrary next section. Below 0.4 the tool retries within a narrowed shortlist (top `LOCATE_SHRINK_TOP` plus `none`) and judges again, retaining the original `unsure` band. Option-order sensitivity can also leave the result `unsure`. `none` means no supplied section fits. Values: [design policy](../design.md#judgment-policy).

## Controls and failure modes

- Order-reversal control (`needsReverse` at `ORDER_REVERSE_BELOW`, disagreement past `ORDER_DISAGREE_MIN`) applies to the range choice; several sections can legitimately share a goal and split probability — two plausible ranges do not imply either is wrong.
- Unreadable/invalid evidence, missing Python grammar (named with install guidance), missing configuration, and exhausted session budgets are reported, never converted into a range verdict. A selected window does not prove every relevant declaration was inspected. There is no per-invocation `max_calls`; session budgets still apply.

## What Jev sees vs what stays local

Jev sees the section outline or window texts plus the range-choice question — supplied source, not runtime behavior. Local-only: file streaming, sectioning, outline/refine planning, pointer reading, render.
