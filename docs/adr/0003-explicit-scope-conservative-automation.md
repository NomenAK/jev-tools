# 0003 — Explicit scope and conservative automation

Status: Accepted

## Context

Repository navigation, change review and test selection involve different evidence and next actions. Broad automatic suggestions could be mistaken for complete knowledge of the repository.

## Decision

Expose six explicit tools: jev_ask for one combined situation, jev_ask_files for independent judgments of files, jev_find_files for discovery, jev_locate_in_file for ranges, jev_check_diff for fixed reviews and jev_select_tests for existing test plans. Hide jev_find_files in omp when its native find tool is active.

Allow only one automatic run-end documentation check of a dirty tree. A flagged stale sentence can request another turn; errors do not block the host or cause an automatic review loop. JEV_TOOLS_AUTO_DOCS=0 disables the hook.

Do not infer required new test scenarios, missing documentation or arbitrary companion edits from incomplete collection. Test selection and residual coverage checks describe only the discovered inventory.

## Consequences

Callers retain control of consequential actions and must read or execute the evidence indicated by results. A clean review is not a completeness guarantee. Automatic documentation checking targets existing sentences, not an inferred obligation to write new documentation.
