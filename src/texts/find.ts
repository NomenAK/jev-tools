import { RECOVERY_POLICY, USE_POLICY } from "./instructions.ts";

export const FIND_DESCRIPTION = `Find the files for a goal you describe in plain words, ranked; known names → {{names.byName}}, known strings → {{names.grep}}.
Use for: starting a task in unfamiliar code ("where is proration computed", "what handles webhook retries") when you do not know file names or exact identifiers.
Not for: known strings, regexes or symbols → {{names.grep}}. Files by name → {{names.byName}}. Questions about files you already have → jev_ask_files.

How Jev sees it: names first, then a short passage of the best candidates — never whole files. Write the goal as one behavior sentence of at least {{FIND_GOAL_MIN_WORDS}} words (shorter goals are capped at unsure); prefer a full sentence of behavior over a few keywords. Put identifiers you already know in keywords, where they steer the pre-filter and the passage Jev reads. Jev cannot count or grep.

goal: what you are trying to do or find, as one sentence of at least {{FIND_GOAL_MIN_WORDS}} words. Describe behavior, not a guessed identifier: in our tests a full sentence found the right file in 49 of 51 cases, two or three keywords alone in 16 of 21.
keywords: identifiers or terms you already know that should appear in the code; [] if none. They steer the pre-filter and the passage Jev reads.
scope: directories to search instead of the whole repo. An empty scope produces no judgment; a judged "none" means no supplied candidate fit, not proof about unseen files.
exclude: globs to skip. Excluding tests keeps the entry point but drops the tests and docs from the list.
effort: quick searches fewer candidates for a first look, default, thorough searches more (wider net, slower).
max_calls: cap on Jev calls; beyond it the search stops at the best-ranked files so far and says so.

Result: the primary entry decision names the file to open with its actual probability and fresh/cache provenance; auxiliary rankings, controls and native read actions remain distinct. Unsure means two files are plausible, the answer depends on candidate order or the goal is short: read the leading candidates. A judged none means nothing supplied fit: inspect the goal or admitted scope before deciding the next action. Empty collection or missing responses are unjudged, never synthetic none probabilities. A goal under {{FIND_GOAL_MIN_WORDS}} content words is capped at unsure. You receive paths and scores, never file contents. Typed diagnostics name limits, omissions and useful next actions. The reading guide defines every mark once.

${USE_POLICY}

${RECOVERY_POLICY}`;
