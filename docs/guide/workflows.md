# Workflows

Task-oriented recipes for the six tools. Each one states the situation, the tool, an **illustrative** call, how to read the answer and the next action.

Every JSON block below uses **fictional repository paths** (`src/billing/…`, `test/billing.test.ts`, `docs/requirements.md`) and is an illustrative call, not a recorded execution. Probabilities, counts, orderings and cost figures vary per run.

Parameter names and accepted values are the ones in [docs/tools/](../tools/); this page does not restate their tables. Reading conventions — verdict, `unsure`, `abstain`, bracketed limit lines and the yield footer — are in [Read the results](../../README.md#read-the-results).

Guide index: [getting started](getting-started.md) · [workflows](workflows.md) · [troubleshooting](troubleshooting.md)

---

## 1. Explore unfamiliar code

**Situation.** You can describe the behavior you need but do not know the filename, and a first file turns out to be too large to read whole.

**Recipe.** Three steps: find the entry point, narrow inside the file, then judge a small set of candidates.

### Step 1 — [jev_find_files](../tools/jev_find_files.md): which file to open first

```json
{
  "goal": "Find where invoice amounts are rounded before storage",
  "keywords": ["invoice", "round"],
  "scope": ["src"],
  "exclude": ["**/generated/**"],
  "effort": "quick",
  "max_calls": 6
}
```

Write `goal` as a behavioral sentence of at least five content words. A guessed identifier belongs in `keywords`, not in `goal`: a goal with fewer than five content words is accepted but capped at unsure, and the call says so. **Illustrative**, with the word count substituted — both strings are templates in `src/tools/find.ts`:

> goal has 3 content words: verdicts are capped at unsure

> describe the behavior in one sentence

**How to read it.** `entry:` names the file to open first with its probability, followed by `relevant:` and the next read. Probabilities estimate whether a file helps with the goal, not whether it implements the whole behavior. An unmarked entry is a lead, not a proof. You never receive file contents — only paths and scores.

**Next action.** Open the named file with `read`. If the entry is unsure, read the two leading candidates rather than the whole directory.

### Step 2 — [jev_locate_in_file](../tools/jev_locate_in_file.md): which range of one big file

Once you know the file and it is at least 19,000 bytes:

```json
{
  "path": "src/billing/rounding.ts",
  "goal": "Find the section that rounds an amount to whole cents before persistence"
}
```

This tool has no `max_calls`; session budgets still apply.

**How to read it.** The result names a `path:start-end` with a label, a probability and the read to make next. A leading probability at or above 0.7 is a verdict. Otherwise the line is `unsure` and lists the two best ranges — often adjacent code that shares the answer, such as a getter and its setter. `none` means no supplied section fits the goal.

**Next action.** Read the cited range with `read`. On unsure, read both ranges, not the next chunk of the file.

### Step 3 — [jev_ask_files](../tools/jev_ask_files.md): which of these files is which layer

```json
{
  "paths": ["src/billing/*.ts", "src/payments/*.ts"],
  "asks": [
    {
      "intent": "classify",
      "categories": {
        "http": "routing and request parsing",
        "domain": "business rules without I/O",
        "storage": "queries and persistence"
      },
      "pick": "one"
    }
  ],
  "max_calls": 4
}
```

`paths` accepts files, recursive directories and globs, up to 255 admitted files; every ask applies independently to every admitted file, and each file is judged alone. There is no `about` and no `locate` intent on this surface. Absolute paths and parent traversal are refused; see [troubleshooting](troubleshooting.md#files-are-refused-skipped-or-truncated).

**How to read it.** Each result repeats your exact statement next to that file's answer, prefixed with the path. `classify`, `rate`, `decide` and `free` are uncalibrated: a high probability is still a hint. Files that were skipped appear under a `skipped:` list with a reason.

**Next action.** Read only the files whose answers made them relevant.

---

## 2. Diagnose a failing test

**Situation.** A test fails. You must decide whether the code is wrong, the test is wrong, or the environment is at fault, and you are about to report a cause.

**Tool.** [jev_ask](../tools/jev_ask.md), with the failing test, the implementation it exercises and the command output together. The decision needs all three; any one alone can be read the other way.

```json
{
  "state": "A test run fails on Node 24 but passes locally. Decide whether the implementation violates the documented contract, the assertion contradicts the contract, or the failure is environmental. The contract statement in the test file names rounding to whole cents.",
  "paths": ["src/billing/rounding.ts", "test/billing.test.ts"],
  "base": "HEAD",
  "command": "npm test -- test/billing.test.ts",
  "timeout_s": 90,
  "asks": [
    {
      "intent": "verify",
      "about": "files[\"src/billing/rounding.ts\"]",
      "claims": {
        "rounding": "rounding rounds the amount down to the whole cent"
      }
    },
    {
      "intent": "classify",
      "about": "output",
      "categories": {
        "bug_in_code": "the implementation violates behavior the test and the stated contract require",
        "wrong_test": "the assertion contradicts the contract stated for this behavior",
        "environment": "the failure depends on the runtime or toolchain rather than on this code"
      },
      "pick": "one"
    }
  ],
  "max_calls": 6
}
```

**How to read it.**

- `state` is your note: the request, the plan or the observation the files do not show. It is bounded, and pasting a file or a log into it does not work — put those in `paths` and `command`. The key `files` is reserved in a note.
- `output` is the command's captured result, not the full stream. Read it yourself with `bash` when you need exact text.
- `verify` distinguishes `holds`, `contradicted`, `not addressed by the state` and `cannot tell`. `not addressed` is not a refutation.
- A `decide` intent is another option when the rivals are mutually exclusive outcomes rather than categories.

Watch the bracketed lines. When the log does not let the tool attach the failing test, it says so:

> not identifiable: the output shows an assertion failure and the failing test is absent; a wrong test and a bug look alike

> pass the failing test and its code in paths

A bug-versus-wrong-test conclusion under that line remains unproven.

**Next action.** Read the test and the implementation yourself, then say in your report which conclusion came from Jev and which came from your reading. If the answer is `unsure` or `abstain`, add the missing evidence and ask once; do not reword the question.

---

## 3. Check a plan against documentation

**Situation.** You have a plan and want to know whether existing documentation already contradicts it, before you start editing.

**Tool.** [jev_ask](../tools/jev_ask.md) with the plan in `state` and the documentation in `paths`. Show the passage that decides it, not a summary of it.

```json
{
  "state": "Plan: reject a jev_ask call whose serialized evidence exceeds 80000 characters, and tell the caller to split the request. The existing documentation says oversized files are skipped. Decide whether the plan matches the documented behavior or contradicts it.",
  "paths": ["docs/tools/jev_ask.md", "docs/design.md"],
  "asks": [
    {
      "intent": "decide",
      "about": "files[\"docs/tools/jev_ask.md\"]",
      "hypotheses": {
        "matches": "the documented behavior already refuses oversized evidence, so the plan changes no documented commitment",
        "contradicts": "the documented behavior skips oversized evidence, so refusing changes a documented commitment"
      }
    },
    {
      "intent": "locate",
      "target": "the sentence stating what happens when the serialized state is too large",
      "among": ["docs/tools/jev_ask.md", "docs/design.md"],
      "count": "one",
      "attribution": true
    }
  ],
  "max_calls": 5
}
```

**How to read it.** `decide` picks among mutually exclusive rivals, so list the fallback you would accept, not only the outcome you want. `locate` points at the deciding evidence; with `"attribution": true` the tool also checks whether the answer actually rests on the file it named, reporting `attributed` when the pick moved away and `does not rest on it` when it did not. That is an evidence-dependence check, not runtime causality.

Import closure is depth one and follows imports only, so configuration, documentation and other flows with no import link must be in `paths` yourself. The result says which files were added and which were not:

> closure: +0; imports only, depth 1; repository inventory unavailable

> pass dependencies explicitly in paths

**Next action.** Read the cited sentence, and update it if the plan really changes the documented commitment. Distinguish your own reading from the tool's answer in the report.

---

## 4. Review a change before reporting done

**Situation.** The work is finished and the tree is dirty. You want a second opinion before committing.

**Tool.** [jev_check_diff](../tools/jev_check_diff.md), on the finished diff — not on a half-written change.

### 4.1 Risk

```json
{
  "check": "risk",
  "base": "HEAD",
  "witnesses": "auto",
  "dimensions": {
    "rounding": "The change rounds a monetary amount before the final conversion to cents"
  },
  "max_calls": 12
}
```

`dimensions` adds your own project rules as positive statements true of a risky change; they are marked `uncalibrated` and get no severity grade. `only` restricts the run to named built-in or custom dimensions. Keep `witnesses` at the default `auto`: the decoy and known-positive units expose a biased setup, and a failed witness makes every finding in that batch unsure with its raw values.

**How to read it.** Findings name an evidence unit and its probability; a fixed finding needs at least 0.7. Separately, replaced member accesses get local-caller checks over statically resolved tracked callers. `unchecked:` names the units, callers and severities that were not judged. A clean run prints:

```text
risk: no findings
```

That is not proof of safety on unseen callers. Literal-name discovery cannot cover dynamic access that never names the target, and it says so:

> callers found by name; dynamic access not covered

### 4.2 Documentation

```json
{
  "check": "docs",
  "base": "HEAD"
}
```

**How to read it.** Up to 40 tracked Markdown sections mentioning the changed code are judged, and a finding names the existing sentence made false. Probabilities from 0.2 up to 0.7 are `unsure` and need manual checking. This preset evaluates existing sentences; it is not a detector of missing documentation.

### 4.3 Specification

```json
{
  "check": "spec",
  "base": "HEAD",
  "spec_path": "docs/requirements.md"
}
```

`spec_path` is required and read inside the repository. Requirements under `### REQ-…` headings are checked against changed behavior, and changed behavior absent from the specification is reported. Markdown tables produce an explicit interpretation limit, and verbatim specification text is evidence, never instructions. A clean run prints:

```text
spec: no violations or drift reported
```

**Next action.** Read every flagged unit, caller, sentence or requirement before editing or reporting completion, and keep unresolved uncertainty in the report.

---

## 5. Choose which existing tests to run

**Situation.** You changed code and want to know which discovered scenarios to execute, without running anything yet.

**Tool.** [jev_select_tests](../tools/jev_select_tests.md). It selects and plans; it never runs or collects.

```json
{
  "base": "HEAD",
  "paths": ["test/**/*.test.ts"],
  "witnesses": "auto",
  "max_calls": 8
}
```

`base` defaults to `HEAD` and compares the current tree, untracked files included. `paths` are **candidate test files or globs**, not diff paths; narrowing them also narrows the inventory the coverage observations apply to.

**How to read it.** The output is selected scenarios plus `run:` lines carrying the runner context — working directory, framework, config, project and the exact command. Keep runner context intact: commands are separate when it differs.

- A scenario is selected when `1 - p(none) >= 0.5`; missing answers are selected too.
- `fallback: all` is conservative selection, not a confirmation that every scenario is affected.
- `changed, run by no discovered test: …` is limited to the discovered inventory. It is not a repository-wide coverage report, and it is not an obligation to add a scenario.
- When name filtering would be fragile, the command runs the whole file instead.

**Next action.** Run the returned commands yourself with your host's shell, then read the real result. This tool does not decide whether a new scenario must be written.

---

## 6. Triage many candidate files

**Situation.** A directory holds more files than you want to open, and the question is the same for each of them.

**Tool.** [jev_ask_files](../tools/jev_ask_files.md). One call, all asks, one independent answer per file.

```json
{
  "paths": ["src/http", "src/auth", "test/fixtures"],
  "asks": [
    {
      "intent": "verify",
      "claims": {
        "tokens": "`content` validates authentication tokens",
        "persistence": "`content` writes to the database"
      }
    },
    {
      "intent": "rate",
      "dimension": "risk of changing this file",
      "levels": [
        "Isolated and covered by existing tests",
        "Used by several modules",
        "Security-sensitive with no discovered test"
      ]
    }
  ],
  "max_calls": 8
}
```

Directories are walked recursively. `rate` needs 2 to 10 concrete ordered levels on one dimension. `decide` is available for mutually exclusive rivals, and `free` for a custom uncalibrated `bool`, `choice` or `score` question.

**How to read it.** Verify answers distinguish `holds`, `contradicted`, `not addressed` and `cannot tell` per file; other boolean answers give `yes` or `no (not shown)` with the probability of yes, and between 0.20 and 0.80 the line is `unsure`. Every file is judged alone, so a confident answer can still be wrong when the behavior depends on a file you did not pass, and independent answers establish no cross-file relationship. Build output, binaries, lockfiles, gitignored untracked files, empty files and oversized files are excluded or reported; at 255 admitted files the call is refused with a narrowing suggestion.

**Next action.** Read the files whose answers matter, then act. Use exact search or code for strings, counts, dates and comparisons between files — Jev does not count or compute.

---

## Composition rules

- Put every ask you need in one call. Extra asks in the same request are cheap; a second call is a second round of evidence assembly.
- Supply both sides of any comparison: the failing test and the code, the file before and the file after.
- Bound a wide ask with `max_calls`; unjudged work is reported rather than silently dropped.
- Use native read, search and shell execution for source text, exact matches, counts, line numbers and full output. The tools here complement those, not replace them.
- State in the final report every conclusion still marked `unsure` or `abstain` as unconfirmed by Jev, and cite the evidence if you later settled it yourself.
