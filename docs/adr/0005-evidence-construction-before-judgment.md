# 0005 — Evidence construction before judgment

Status: Accepted

## Context

A confident answer can still be wrong when a required dependency or the object named by a question is absent. Waiting for uncertainty before collecting context cannot repair that failure reliably.

## Decision

Prepare bounded discriminating evidence before judgment. Include the failing test and the code it exercises when distinguishing a bug from a wrong test; recover a named test from command output when identifiable. Add statically resolved declarations through a depth-one import closure under its own budget and report what was added or omitted. An absent or empty named part prevents its question; a uniquely resolvable orphan reference can be added before asking.

For diff checks, construct before-and-after evidence units from declarations, slices, files or hunks. Use fixed outcome or pointer choices when one answer is expected and boolean matrices when multiple units can be relevant. Keep test evidence separate from risk units. Keep policy thresholds in code rather than caller-written questions.

For eligible replaced member accesses, prepare isolated local-caller judgments alongside the risk matrix, using statically resolved callers and providers and including coordinated migrations. Apply the same evidence construction policy to supported Python syntax, imports and test fixtures, with missing grammar capabilities visible.

## Consequences

Static source evidence is never reported as execution. Import closure, local-caller collection and an empty finding list cannot prove completeness of dynamic dependencies or repository-wide safety. Required evidence that cannot fit together remains explicitly unjudged; [bounded evidence](0007-bounded-evidence-visible-limits.md) takes precedence over a plausible verdict.
