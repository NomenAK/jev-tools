# 0004 — Compile typed intents instead of accepting raw question maps

Status: Accepted

## Context

Caller-written question wording and option sets can drift even when the intended judgment is the same. A typed declaration can enforce a consistent shape without establishing the truth of its answer.

## Decision

Accept typed asks and compile verify, classify, rate, decide and locate intents into canonical questions and options. Accept an array, a single intent object or its JSON representation; reject invalid intent contracts with guidance. Fix substantive option order by template and add applicable other and cannot_tell outcomes.

Preserve the exact supplied claim text in verification results. Warn about negation or compound claims without silently rewriting or reversing their polarity. jev_ask verification combines issue outcomes with an exact-statement boolean cross-check.

Retain free for custom bool, choice or score questions, visibly marked uncalibrated. The compiler supplies required structural safeguards but does not turn arbitrary wording into a calibrated preset.

## Consequences

Consumers get consistent result structure and explicit escape-hatch limits. Canonical compilation is a form and policy guarantee, not proof of better accuracy. Typed asks remain distinct from the fixed review questions described in [Evidence construction before judgment](0005-evidence-construction-before-judgment.md).
