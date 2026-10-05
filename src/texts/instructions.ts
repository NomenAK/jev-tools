import * as constants from "../constants.ts";
/** Native tool labels are supplied by each host; texts remain host-independent. */
export interface InstructionNames {
  grep: string;
  byName: string;
  semantic: string;
}

/** Version the policy independently of the product release; regenerate static copies. */
export const INSTRUCTION_VERSION = "2026-10-03.1";
export const INSTRUCTION_SOURCE = "src/texts/instructions.ts";

export const USE_POLICY =
  "Use Jev for a bounded semantic judgment when its answer could change an open decision or focus the next inspection, and the relevant evidence is available. Use decisive reading, search or authorized execution directly when it settles the question. Exact lookup, counting and runtime causality belong to native tools. A Jev call is not a prerequisite for a conclusion, a review or task completion; no explanation is needed for choosing native tools.";
export const RECOVERY_POLICY =
  "After an unavailable, refused or out-of-scope result, continue natively within the existing permissions; do not widen sharing or confinement to obtain a judgment. For uncertainty or missing evidence, inspect or obtain the decisive piece, or leave the conclusion open. Revisit Jev only when new evidence, a material context change or a new useful question makes the judgment useful; rewording unchanged evidence is not a reason to retry. There is no retry quota for genuinely changed evidence, and no certification is needed once decisive evidence settles the question. A reached cap or an unjudged result is not evidence of safety or zero affected tests.";
export const EVIDENCE_POLICY = `Before a chosen call, identify the open decision and supply only the evidence needed for a bounded question; a complete prior analysis is not required. Ask about one positive, self-contained observable fact per claim, with its sources, and show both sides of a comparison.
- Failure: relevant output, the failing test and the implementation it exercises; output alone is a lead, not a bug-versus-wrong-test diagnosis. Include configuration or runtime evidence when the hypothesis depends on it. A static judgment does not establish runtime causality.
- Change: current evidence and the earlier reference via base. Use the checkout/root corresponding to the work and admitted by the tool; another clone is not the same context.
- Plan/documentation: precise observable commitments and the passages that constrain them. Local confirmation does not establish that omitted obligations were searched.
- Selection/review: compatible inventory, references and configuration. Suggested commands are not executed commands; existing tests need not cover a new scenario. Read the diff natively for its contents, not as proof of safety or global coverage.`;
export const ASK_GUIDELINE = `jev_ask: ${USE_POLICY}`;
export const CHECK_DIFF_GUIDELINE =
  "jev_check_diff: Review a stable diff for semantic risks, stale documentation or specification drift when that review can inform an open decision. Read the diff natively when you need its contents. Choose risk, docs or spec for the question at hand; neither risk followed by docs nor a Jev review before done is required. Findings are leads within the inspected scope, not proof of global safety or completeness.";

export const PRESENTATION_POLICY = `Report current conclusions first, then decisive evidence, origin and scope, then material reservations. Established means supported by relevant decisive evidence; a reported check remains explicitly reported, not observed execution. Distinguish native reading/execution, Jev's static judgment and testimony. A call count or global status is not proof.
If native evidence settles the same scope and context after a Jev uncertainty, attribute the current conclusion to that evidence; old unsure or abstain results need not be recited as current reservations. A later Jev confirmation is attributed to Jev and retains its static limits. Independent reservations survive either resolution.
Where an uncertainty actually returned by Jev remains material, explicitly say “Jev did not confirm X”, identify the missing evidence or guarantee, its known or indeterminate impact and the evidence to obtain. Preserve that reservation in the main text, summary and recommendation. Name native reservations and unjudged work as such, not as Jev uncertainty. Unresolved contradiction, stale evidence or a different checkout/base/scenario remains a reservation; the latest favorable answer does not win by default.
Keep material limits in the main text, not only behind a link. Do not generalize a checked scenario into a universal guarantee. Separate relevant unestablished hypotheses from observations; omit irrelevant hypotheses. Explain unavailable historical causes only when material to action or requested, without inventing causality.
Use existing history references when useful or requested; no exhaustive historical relay, persistent register or History block is required. A requested audit details available steps separately from the current state and does not reopen settled conclusions. Preserve existing traces; identify unavailable traces when they limit evidence or audit, without reconstructing evidence, executions or call counts. pi/OMP may reference an existing trace; MCP references must be client-accessible or explicitly unavailable.`;
export const DATA_POLICY =
  "Evidence passed to jev_* tools leaves the machine for the configured endpoint. Review its data handling; share only authorized evidence, never secrets or credentials. Host/client approvals still apply. jev_ask commands run with normal shell permissions and no sandbox; prefer read-only commands. Tool choice does not relax quality, proof, approval or confidentiality obligations.";
export const AUTOMATIC_DOCS_POLICY =
  "pi and OMP retain an automatic, opt-out documentation check at task completion (JEV_TOOLS_AUTO_DOCS=0 disables it). It is a host feature, not an agent requirement to call Jev. Inspect any flagged sentence against the change and update it or explain with evidence why it remains correct. The check is limited and does not certify documentation completeness or demonstrated usefulness. A flagged sentence does not require a second call or recursive reviews.";
export const MCP_DOCS_POLICY =
  "MCP has no automatic run-end documentation hook. Its absence does not require manual replacement calls, including risk followed by docs. pi and OMP retain an opt-out host hook; that is an explicit automatic exception, not an agent call requirement.";

export const GUIDE_TEMPLATE = `jev_* tools: choosing evidence and reading results.

${USE_POLICY}

${EVIDENCE_POLICY}

The report begins with execution state: complete means the requested admitted work was processed; partial means some requested work remains unjudged or limited; not_judged means no admissible judgment; refused means a call-wide refusal. These states describe execution, not correctness, safety, documentation completeness or global test coverage. Static selection or conservative fallback can be useful without a Jev judgment; inspect the selection reason and remaining limits.

Context identifies canonical host/server authority, requested and effective root, base and resolved reference, inventory restrictions and command execution/cwd when collected. Compare that context to your actual work before using a result. Unknown, not_collected and not_applicable are distinct, not guessed values or a substitute checkout.

Each item distinguishes a judged result sourced from fresh or cache, static treatment without a Jev judgment, or unjudged work. A cached judgment is not a fresh verification. Only judged items carry a judgment measure; unjudged and static items have no invented probability or confidence. Source and treatment are independent of the probability band.

Jev reads what you pass at a glance. A verdict is a lead to check before an irreversible action, not a proof. About 1 in 100 clear verdicts is wrong, and far more when the evidence is cut, from the wrong file, or depends on a file that was not passed; no mark can see that, so check the evidence yourself before you edit, delete or report done.

Marks:
- unsure: Jev does not see it clearly (yes/no between {{BAND_BOOL_GRAY_A}} and {{BAND_BOOL_YES_MIN}}; a category or level under {{BAND_CHOICE_VERDICT_MIN}} confidence; findings between their thresholds), or a control of the call failed and the line says which. Inspect the passage or obtain the decisive file; unchanged rewording does not settle it.
- abstain: a necessary piece is missing from what you passed; the line names it. Obtain that piece or leave the conclusion open. A further Jev call is optional when the changed evidence makes it useful.
- "no (not shown)" or "not addressed": the file or state does not show it. That is not "false".
- uncalibrated: no error rate has been measured for this kind of ask; read it as a hint.
- Diagnostics: typed cause, origin, affected scope and materiality explain limits or blocking work, with referenced next actions. An uncertain judged item and work never judged are different. Inspect the named evidence or action without treating a diagnostic as a probability or a clean bill of health.

Accounting separates tool invocation, HTTP attempts, questions actually sent, requested results (fresh/cache/not judged/static), cache probes (hits/requests), auxiliary controls and passage work, current reported cost and elapsed time. These counts are not interchangeable: an HTTP attempt is not a result, a cache probe is not a requested judgment, and a cached result does not imply a request. Unknown current cost means unreported, not zero or reconstructed historical cached cost. Use max_calls to bound a chosen wide ask.

${RECOVERY_POLICY}

${PRESENTATION_POLICY}

Ask about facts the files show, in positive sentences, with the evidence attached; do counting and searching with {{names.grep}} or code.

${DATA_POLICY}`;

export type InstructionHost = "pi" | "omp" | "mcp";
export function renderAgentInstructions(
  host: InstructionHost,
  names: InstructionNames,
): string {
  const values: Record<string, string | number> = {
    BAND_BOOL_GRAY_A: constants.BAND_BOOL_GRAY_A.toFixed(2),
    BAND_BOOL_YES_MIN: constants.BAND_BOOL_YES_MIN.toFixed(2),
    BAND_CHOICE_VERDICT_MIN: constants.BAND_CHOICE_VERDICT_MIN.toFixed(2),
    ...Object.fromEntries(
      Object.entries(names).map(([key, value]) => [`names.${key}`, value]),
    ),
  };
  const guide = GUIDE_TEMPLATE.replace(
    /{{([^}]+)}}/g,
    (_match, key: string) => {
      const value = values[key];
      if (value === undefined)
        throw new Error(`Unknown instruction interpolation: ${key}`);
      return String(value);
    },
  );
  return `${guide}\n\n${CHECK_DIFF_GUIDELINE}\n\n${host === "mcp" ? MCP_DOCS_POLICY : AUTOMATIC_DOCS_POLICY}`;
}
export function renderOmpRule(): string {
  return `---\nalwaysApply: true\n---\n<!-- Generated policy ${INSTRUCTION_VERSION} from ${INSTRUCTION_SOURCE}; run node scripts/generate-instructions.ts after editing the source. -->\n${USE_POLICY}\n\n${EVIDENCE_POLICY}\n\n${RECOVERY_POLICY}\n\n${CHECK_DIFF_GUIDELINE}\n\n${PRESENTATION_POLICY}\n\n${AUTOMATIC_DOCS_POLICY}\n\n${DATA_POLICY}\n`;
}
export function renderMcpProjectBlock(names: InstructionNames): string {
  return `## Jev evidence tools (jev_* via MCP)\n\n<!-- Generated policy ${INSTRUCTION_VERSION} from ${INSTRUCTION_SOURCE}. Update this copied block from docs/agent-instructions.md on each release; pasted copies are not updated automatically. -->\n\n${renderAgentInstructions("mcp", names)}\n\n### Optional tool choices\n\n| Tool | Useful open decision |\n|---|---|\n| jev_ask | One bounded judgment combines a note, files, before/after evidence or command output. |\n| jev_ask_files | The same questions apply independently to many candidate files. |\n| jev_find_files | Find an entry point by behavior when the filename is unknown. |\n| jev_locate_in_file | Find a useful range in one file over ${constants.LOCATE_MIN_KB} KB. |\n| jev_check_diff | Review a stable diff for the chosen risk, docs or spec question. |\n| jev_select_tests | Suggest commands for existing affected tests when selection can change the execution plan; it never runs them. |\n\nUse ${names.grep} for exact strings and known symbols, ${names.byName} for known filenames, and native reading or authorized execution for decisive evidence. Tool descriptions retain their full evidence recipes and limitations.\n`;
}
