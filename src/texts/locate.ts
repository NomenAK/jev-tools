export const LOCATE_DESCRIPTION = `Find which line range of ONE big file (over {{LOCATE_MIN_KB}} KB) serves a goal, instead of reading it whole; known string or symbol -> {{names.grep}}.
Use for: a file too big to read whole (over {{LOCATE_MIN_KB}} KB) when you know what you need from it ("where are retries scheduled", "the part that parses flags"). Prefer it over reading the file in chunks.
Not for: an exact string or symbol → {{names.grep}}. Files under {{LOCATE_MIN_KB}} KB → read them directly. Several files → jev_ask_files or {{names.semantic}}.{{ompOutline}}

How Jev sees it: code cuts the file into declarations or sections, and Jev reads them all at a glance and picks the one that serves the goal. Several sections often share the answer (a getter and its setter), so the mass splits and the pick looks unsure even when both are right. It reads what is written, not what a function does at run time.

path: one repo-relative file.
goal: what you need from the file, as a sentence.

Result: the range as path:start-end with its label and probability, and the read call to make next. An unmarked line above {{LOCATE_VERDICT_MIN}} is a verdict: read that range. unsure ({{LOCATE_GRAY_MIN}} to {{LOCATE_VERDICT_MIN}}) lists the two best by probability, often adjacent code that shares the answer, not the next section of the file: read both. Below {{LOCATE_GRAY_MIN}} Jev is asked once more among the three best plus none; the original unsure band is retained. A "none" means no section fits and the goal is probably not in this file: search elsewhere. Bracket lines say what limited the call. The reading guide defines every mark once.`;
