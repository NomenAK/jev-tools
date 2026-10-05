import { RECOVERY_POLICY, USE_POLICY } from "./instructions.ts";

export const LOCATE_DESCRIPTION = `Find which line range of ONE big file (over {{LOCATE_MIN_KB}} KB) serves a goal, instead of reading it whole; known string or symbol -> {{names.grep}}.
Use for: a file too big to read whole (over {{LOCATE_MIN_KB}} KB) when you know what you need from it ("where are retries scheduled", "the part that parses flags") and finding a range can focus the next inspection.
Not for: an exact string or symbol → {{names.grep}}. Files under {{LOCATE_MIN_KB}} KB → read them directly. Several files → jev_ask_files or {{names.semantic}}.{{ompOutline}}

How Jev sees it: the file cut into declarations or sections, all glanced at once. Neighboring sections can share an answer (a getter and its setter), splitting the mass into unsure even when both are right: that still points at the right neighborhood. It reads what is written, not what a function does at run time.

path: one repo-relative file.
goal: what you need from the file, as a sentence.

Result: the range as path:start-end with its label and probability, the runners-up, and a \`read:\` list naming the range to open. A leading probability at or above {{LOCATE_VERDICT_MIN}} is a verdict: read that range. Otherwise the line is unsure (\`two sections share the mass\`): read both ranges — usually neighbors, not the next section of the file. A \`none\` (\`no section fits\`) means the goal is probably not in this file: search elsewhere. Missing required answers or controls remain unjudged, without an invented probability. Typed diagnostics name parsing/window limits and native actions; primary and control provenance remain distinct. Marks are defined once in the reading guide.

The decision to call is discretionary: ${USE_POLICY}

${RECOVERY_POLICY}`;
