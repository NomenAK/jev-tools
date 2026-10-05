# Agent instructions for MCP clients

pi and OMP deliver the reading guide and discretionary Jev policy automatically. The MCP server sends the same semantic policy as its `instructions`, with MCP's explicit absence of an automatic docs hook, but clients may ignore that field. Add the generated block below to the project's instruction file so the agent can choose useful evidence tools and report their results accurately.

Copy the block unchanged, or trim the optional tool table to the tools you enable. It contains no secrets and is safe to commit. Copies are not updated automatically: replace them from this page when upgrading a release.

## The block

<!-- BEGIN GENERATED JEV INSTRUCTIONS -->

```markdown
## Jev evidence tools (jev_* via MCP)

<!-- Generated policy 2026-10-03.1 from src/texts/instructions.ts. Update this copied block from docs/agent-instructions.md on each release; pasted copies are not updated automatically. -->

jev_* tools: choosing evidence and reading results.

Use Jev for a bounded semantic judgment when its answer could change an open decision or focus the next inspection, and the relevant evidence is available. Use decisive reading, search or authorized execution directly when it settles the question. Exact lookup, counting and runtime causality belong to native tools. A Jev call is not a prerequisite for a conclusion, a review or task completion; no explanation is needed for choosing native tools.

Before a chosen call, identify the open decision and supply only the evidence needed for a bounded question; a complete prior analysis is not required. Ask about one positive, self-contained observable fact per claim, with its sources, and show both sides of a comparison.
- Failure: relevant output, the failing test and the implementation it exercises; output alone is a lead, not a bug-versus-wrong-test diagnosis. Include configuration or runtime evidence when the hypothesis depends on it. A static judgment does not establish runtime causality.
- Change: current evidence and the earlier reference via base. Use the checkout/root corresponding to the work and admitted by the tool; another clone is not the same context.
- Plan/documentation: precise observable commitments and the passages that constrain them. Local confirmation does not establish that omitted obligations were searched.
- Selection/review: compatible inventory, references and configuration. Suggested commands are not executed commands; existing tests need not cover a new scenario. Read the diff natively for its contents, not as proof of safety or global coverage.

The report begins with execution state: complete means the requested admitted work was processed; partial means some requested work remains unjudged or limited; not_judged means no admissible judgment; refused means a call-wide refusal. These states describe execution, not correctness, safety, documentation completeness or global test coverage. Static selection or conservative fallback can be useful without a Jev judgment; inspect the selection reason and remaining limits.

Context identifies canonical host/server authority, requested and effective root, base and resolved reference, inventory restrictions and command execution/cwd when collected. Compare that context to your actual work before using a result. Unknown, not_collected and not_applicable are distinct, not guessed values or a substitute checkout.

Each item distinguishes a judged result sourced from fresh or cache, static treatment without a Jev judgment, or unjudged work. A cached judgment is not a fresh verification. Only judged items carry a judgment measure; unjudged and static items have no invented probability or confidence. Source and treatment are independent of the probability band.

Jev reads what you pass at a glance. A verdict is a lead to check before an irreversible action, not a proof. About 1 in 100 clear verdicts is wrong, and far more when the evidence is cut, from the wrong file, or depends on a file that was not passed; no mark can see that, so check the evidence yourself before you edit, delete or report done.

Marks:
- unsure: Jev does not see it clearly (yes/no between 0.20 and 0.80; a category or level under 0.85 confidence; findings between their thresholds), or a control of the call failed and the line says which. Inspect the passage or obtain the decisive file; unchanged rewording does not settle it.
- abstain: a necessary piece is missing from what you passed; the line names it. Obtain that piece or leave the conclusion open. A further Jev call is optional when the changed evidence makes it useful.
- "no (not shown)" or "not addressed": the file or state does not show it. That is not "false".
- uncalibrated: no error rate has been measured for this kind of ask; read it as a hint.
- Diagnostics: typed cause, origin, affected scope and materiality explain limits or blocking work, with referenced next actions. An uncertain judged item and work never judged are different. Inspect the named evidence or action without treating a diagnostic as a probability or a clean bill of health.

Accounting separates tool invocation, HTTP attempts, questions actually sent, requested results (fresh/cache/not judged/static), cache probes (hits/requests), auxiliary controls and passage work, current reported cost and elapsed time. These counts are not interchangeable: an HTTP attempt is not a result, a cache probe is not a requested judgment, and a cached result does not imply a request. Unknown current cost means unreported, not zero or reconstructed historical cached cost. Use max_calls to bound a chosen wide ask.

After an unavailable, refused or out-of-scope result, continue natively within the existing permissions; do not widen sharing or confinement to obtain a judgment. For uncertainty or missing evidence, inspect or obtain the decisive piece, or leave the conclusion open. Revisit Jev only when new evidence, a material context change or a new useful question makes the judgment useful; rewording unchanged evidence is not a reason to retry. There is no retry quota for genuinely changed evidence, and no certification is needed once decisive evidence settles the question. A reached cap or an unjudged result is not evidence of safety or zero affected tests.

Report current conclusions first, then decisive evidence, origin and scope, then material reservations. Established means supported by relevant decisive evidence; a reported check remains explicitly reported, not observed execution. Distinguish native reading/execution, Jev's static judgment and testimony. A call count or global status is not proof.
If native evidence settles the same scope and context after a Jev uncertainty, attribute the current conclusion to that evidence; old unsure or abstain results need not be recited as current reservations. A later Jev confirmation is attributed to Jev and retains its static limits. Independent reservations survive either resolution.
Where an uncertainty actually returned by Jev remains material, explicitly say “Jev did not confirm X”, identify the missing evidence or guarantee, its known or indeterminate impact and the evidence to obtain. Preserve that reservation in the main text, summary and recommendation. Name native reservations and unjudged work as such, not as Jev uncertainty. Unresolved contradiction, stale evidence or a different checkout/base/scenario remains a reservation; the latest favorable answer does not win by default.
Keep material limits in the main text, not only behind a link. Do not generalize a checked scenario into a universal guarantee. Separate relevant unestablished hypotheses from observations; omit irrelevant hypotheses. Explain unavailable historical causes only when material to action or requested, without inventing causality.
Use existing history references when useful or requested; no exhaustive historical relay, persistent register or History block is required. A requested audit details available steps separately from the current state and does not reopen settled conclusions. Preserve existing traces; identify unavailable traces when they limit evidence or audit, without reconstructing evidence, executions or call counts. pi/OMP may reference an existing trace; MCP references must be client-accessible or explicitly unavailable.

Ask about facts the files show, in positive sentences, with the evidence attached; do counting and searching with your text search tool or code.

Evidence passed to jev_* tools leaves the machine for the configured endpoint. Review its data handling; share only authorized evidence, never secrets or credentials. Host/client approvals still apply. jev_ask commands run with normal shell permissions and no sandbox; prefer read-only commands. Tool choice does not relax quality, proof, approval or confidentiality obligations.

jev_check_diff: Review a stable diff for semantic risks, stale documentation or specification drift when that review can inform an open decision. Read the diff natively when you need its contents. Choose risk, docs or spec for the question at hand; neither risk followed by docs nor a Jev review before done is required. Findings are leads within the inspected scope, not proof of global safety or completeness.

MCP has no automatic run-end documentation hook. Its absence does not require manual replacement calls, including risk followed by docs. pi and OMP retain an opt-out host hook; that is an explicit automatic exception, not an agent call requirement.

### Optional tool choices

| Tool | Useful open decision |
|---|---|
| jev_ask | One bounded judgment combines a note, files, before/after evidence or command output. |
| jev_ask_files | The same questions apply independently to many candidate files. |
| jev_find_files | Find an entry point by behavior when the filename is unknown. |
| jev_locate_in_file | Find a useful range in one file over 19 KB. |
| jev_check_diff | Review a stable diff for the chosen risk, docs or spec question. |
| jev_select_tests | Suggest commands for existing affected tests when selection can change the execution plan; it never runs them. |

Use your text search tool for exact strings and known symbols, your file-name search tool for known filenames, and native reading or authorized execution for decisive evidence. Tool descriptions retain their full evidence recipes and limitations.
```

<!-- END GENERATED JEV INSTRUCTIONS -->

## Where to put it

| Client | File | Notes |
|---|---|---|
| Claude Code | `CLAUDE.md` at the project root | See [CLAUDE.md](#claudemd). `CLAUDE.local.md` for a personal, uncommitted copy. |
| Codex CLI, and agents that read `AGENTS.md` | `AGENTS.md` at the project root | See [AGENTS.md](#agentsmd). |
| Kiro | `.kiro/steering/jev.md` | See [Kiro steering](#kiro-steering). |
| Cursor, VS Code, Windsurf, Claude Desktop | The client's project rules or custom instructions | Paste the block; Claude Desktop has no project file, so add it to the project's instructions in the app. |

### CLAUDE.md

Either paste the block into `CLAUDE.md`, or keep it in its own file and import it. Claude Code expands `@path` references in `CLAUDE.md` when it starts:

```markdown
# Project instructions

@docs/jev-agent-instructions.md
```

Save the block as `docs/jev-agent-instructions.md` for that form.

### AGENTS.md

Paste the block under its own heading. Codex reads `AGENTS.md`; Claude Code reads it too.

### Kiro steering

Save as `.kiro/steering/jev.md` with front matter that includes it in every session:

```markdown
---
inclusion: always
---

<the block>
```

## Keeping it current

The versioned canonical fragments and host renderers live in [`src/texts/instructions.ts`](../src/texts/instructions.ts). Runtime guides, descriptions/guidelines, the OMP rule and this MCP block reuse them; the MCP block includes policy version, source and copy-update instructions. Thresholds continue to come from [policy constants](design.md#policy-thresholds).

After changing the canonical policy, run `node scripts/generate-instructions.ts` to regenerate this block and `rules/jev-ask.md`. Run `node scripts/generate-instructions.ts --check` to reject stale generated outputs. During release verification, inspect delivery across pi/OMP/MCP for semantic parity, including the automatic pi/OMP hook versus no MCP hook; shared wording is not evidence of agent behavior. A release updates runtime/server instructions, not instruction blocks already pasted into external projects. Update those copies from this page; no synchronization with external copies is claimed.

## Automatic hook and evaluation costs

pi and OMP preserve the existing automatic run-end docs hook and its conditions/budget; `JEV_TOOLS_AUTO_DOCS=0` disables it. This is an explicit exception to agent-discretionary calls, not a requirement to invoke Jev, and does not certify complete documentation. MCP has no hook and no required manual replacement. In usage evaluation, record hook cost separately from discretionary calls and include both in full-task cost; no product price, budget setting or new runtime counter is introduced by this instruction policy.
