# Agent instructions for MCP clients

pi and omp inject the jev reading guide and the `jev_ask` policy automatically. The MCP server sends the same text as its `instructions`, but clients may ignore that field. Add the block below to the project's instruction file so the agent knows when to use the tools and how to read their results.

Copy it unchanged, or trim the tool table to the tools you enable. It contains no secrets and is safe to commit.

## The block

```markdown
## Jev evidence tools (jev_* via MCP)

The jev_* tools send repository evidence to a judgment endpoint and return typed answers with probabilities. They complement reading, searching and running code; they do not replace them.

### When to use which

| Tool | Use it when |
|---|---|
| jev_ask | One judgment combines a note, files, an earlier version (base) or a command's output. |
| jev_ask_files | The same questions apply independently to each of many candidate files. |
| jev_find_files | You need the entry point for a behaviour and do not know the filename. |
| jev_locate_in_file | You need the relevant line range in one file of at least 19 KB. |
| jev_check_diff | Changes are complete and need risk, documentation or specification review. |
| jev_select_tests | You need the commands for existing tests affected by the changes (it does not run them). |

Use ordinary search and reading for exact strings, known symbols, filenames, line numbers, counts and arithmetic. Run commands yourself when you need their full output.

### Required habits

- Before concluding that a failure is a bug in the code, a wrong test or an environment problem, or that a plan matches the documentation, pass the relevant files to jev_ask and weigh its answer against your own reading. Include both the failing test and the code it exercises.
- Ask about facts the files show, in positive sentences, with the evidence attached.
- Before reporting a change as done, call jev_check_diff with check "risk", then with check "docs" (MCP has no automatic documentation check). Update or justify every flagged sentence.
- Bound wide asks with max_calls.

### Reading results

- A line with no mark is a verdict: a lead to check before editing, deleting or reporting done, not a proof.
- unsure: the answer is ambiguous or a control failed. Read the passage or file the line points to, or add the file that settles it. Rewording the question does not help.
- abstain: a necessary piece is missing; the line names it. Add that file or command and ask once.
- "no (not shown)" or "not addressed": the evidence does not show it. That is not "false".
- uncalibrated: no measured error rate; treat it as a hint.
- Lines in brackets: what limited the call and the next action or parameter to use.

### Final answers

Identify every conclusion a jev_* tool marked unsure or abstain, say Jev did not confirm it, and name the evidence still needed. If you settled it by reading the decisive evidence yourself, say so and cite that evidence, separately from Jev's result.

### Data

Evidence passed to jev_* tools leaves the machine. Do not pass secrets, credentials or files the user has not agreed to share. jev_ask commands run with normal shell permissions and no sandbox; prefer read-only commands.
```

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

The block restates the guide in [`src/texts/guide.ts`](../src/texts/guide.ts) and the policy in [`rules/jev-ask.md`](../rules/jev-ask.md). Thresholds are in [design](design.md#policy-thresholds). If a release changes them, the server's `instructions` change automatically; update the copied block from this page.
