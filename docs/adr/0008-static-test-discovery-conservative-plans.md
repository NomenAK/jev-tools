# 0008 — Static test discovery and conservative execution plans

Status: Accepted

## Context

Finding tests related to a changed unit is not the same as determining how a runner executes them. Evaluating third-party configuration during discovery would introduce unrequested execution.

## Decision

Discover existing tests from tracked sources, literal configuration, scripts and static imports without evaluating configuration or automatically collecting tests. Preserve runner, working directory, configuration, project and framework boundaries in separate command plans, including project options. Keep runtime and type-test evidence and commands separate.

Select touched tests directly, follow statically resolved import closure through unchanged intermediates and applicable pytest fixtures, and judge remaining scenarios against changed-unit evidence. Retain tests when judgment is missing or unavailable. Use the selection threshold conservatively; when at least 80% of a file is selected, names are uncertain or counts are unknown, run the whole file.

For unsupported, dynamic or unresolved runners, keep the plan unsure and identify the next manual action rather than inventing executable arguments. Residual exported-unit coverage checks apply only within the discovered inventory.

## Consequences

The tool returns plans and never runs them. The caller must execute the commands and inspect results. Static discovery cannot establish all repository tests or a requirement to add a new scenario; these scope limits follow [Explicit scope and conservative automation](0003-explicit-scope-conservative-automation.md).
