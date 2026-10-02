export const FIND_DESCRIPTION = `Find the files for a goal you describe in plain words, ranked; known names → {{names.byName}}, known strings → {{names.grep}}.
Use for: starting a task in unfamiliar code ("where is proration computed", "what handles webhook retries") when you do not know file names or exact identifiers.
Not for: known strings, regexes or symbols → {{names.grep}}. Files by name → {{names.byName}}. Questions about files you already have → jev_ask_files.

How Jev sees it: it ranks paths by name first, then reads a short passage of the best ones, chosen by your keywords, and picks the entry point among the few that survive. It sees passages, not whole files, and a bare path says little: a full sentence of behavior finds the right file far more often than a few keywords. It cannot count or grep; an identifier you know goes in keywords.

goal: what you are trying to do or find, as one sentence of at least {{FIND_GOAL_MIN_WORDS}} words. Describe behavior, not a guessed identifier: in our tests a full sentence found the right file in 49 of 51 cases, two or three keywords alone in 16 of 21.
keywords: identifiers or terms you already know that should appear in the code; [] if none. They steer the pre-filter and the passage Jev reads.
scope: directories to search instead of the whole repo. A wrong scope returns "none", not a wrong file.
exclude: globs to skip. Excluding tests keeps the entry point but drops the tests and docs from the list.
effort: quick for a first look, default, thorough for a cleaner list of related files (the entry point is rarely better).
max_calls: cap on Jev calls; beyond it the search stops at the best-ranked files so far and says so.

Result: entry: the file to open first with its probability, then the ranked list (probability that the file helps with the goal), and the read to make next. entry: unsure means two files are plausible, the answer depends on the order of the candidates or on a short goal: read the first two. entry: none means nothing fit: rephrase the goal or widen scope. A goal under {{FIND_GOAL_MIN_WORDS}} content words is capped at unsure and the line says so. You receive paths and scores, never file contents. Bracket lines say what limited the call. The reading guide defines every mark once.`;
