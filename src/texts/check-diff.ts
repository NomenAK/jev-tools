import {
  BAND_BOOL_GRAY_A,
  CANNOT_TELL_MIN,
  DOCS_CHECK_MIN,
  DOCS_MAX_SECTIONS,
  FLAG_MIN,
} from "../constants.ts";
import { CHECK_DIFF_GUIDELINE, RECOVERY_POLICY } from "./instructions.ts";

export const CHECK_DIFF_DESCRIPTION = `${CHECK_DIFF_GUIDELINE}
Use for: a semantic review of a stable diff when risks, existing documentation or specification obligations remain an open decision.
Not for: reading the diff -> bash git diff. Choosing tests to run -> jev_select_tests. Work in progress: verdicts on a half-written diff are noise.

How Jev sees it: the diff cut into changed units (a function, a slice of a big one, a declaration, a config file), each shown before and after, with tests kept aside as evidence, never as units. The questions are fixed and reviewed; you write none, and Jev runs nothing.
For replaced member accesses, risk also checks the statically resolved local callers (found by literal name, aliases included) in separate calls. This is source text, not an execution: coordinated edits count, unknown providers, cut pieces, and metaprogramming stay unchecked, and a clean shown caller does not clear the unseen ones. Dynamic access that names no literal is not covered.

check: risk names units with correctness, security, compatibility or reliability risk and grades severity. docs checks up to ${DOCS_MAX_SECTIONS} tracked Markdown sections mentioning changed code or source importing it, naming an existing sentence that may no longer match the change. It is not an exhaustive detector of missing documentation (independent measurement: 2/45 docs obligations found on 180 partial got/zod commits). spec checks each ### REQ-… requirement and names changed behavior absent from the specification.
base: a git ref to compare against (as for a pull request); default is HEAD plus untracked files.
spec_path: required for spec; a repository Markdown specification with ### REQ-… headings. Specification text is passed as evidence; Jev has no instruction/data separation, so text inside the specification can sway an answer. Markdown tables are reported as a limit.
dimensions: project rules as {"name":"a positive statement that is true of a risky change"}; asked alongside the built-ins, marked uncalibrated, without severity. only: restrict risk to these dimension names.
witnesses: off | auto (default) | on. Leave it on auto.
max_calls: cap on all Jev calls, including caller checks and severity; beyond it, units, callers, sections, requirements, and severity are listed unchecked. Caller checks run once per changed unit, not per caller, and count toward the cap.

Result: typed review items retain positive and negative results, unjudged work, context, provenance and scoped diagnostics. Findings name a unit, doc sentence or requirement and probability. A finding requires probability >= ${FLAG_MIN}. docs probability of now_false between ${DOCS_CHECK_MIN} and ${FLAG_MIN} is unsure (needs checking), without another call. Local caller probability between ${BAND_BOOL_GRAY_A} and ${FLAG_MIN} is unsure; cannot_tell >= ${CANNOT_TELL_MIN} is abstain and names the missing provider/binding. Every finding of a failed witness batch is unsure, with raw values and the reason. Local limits do not lower the separate matrix. No findings is not proof of safety on unseen callers or completeness of docs. Diagnostics name limits and useful next actions; the reading guide defines marks.

${RECOVERY_POLICY}`;
