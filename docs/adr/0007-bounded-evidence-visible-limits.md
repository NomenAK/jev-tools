# 0007 — Bounded evidence without silent truncation

Status: Accepted

## Context

Evidence collection, transport and display each require bounds. Silently trimming required evidence or splitting a control away from its judgment would change the question while appearing to answer it.

## Decision

Keep character admission limits separate from heuristic token estimates: admission does not guarantee provider acceptance. Subdivide requests only between indivisible judgment groups, keeping exact-claim cross-checks and contrastive controls together and repeating applicable witnesses. Refuse a group that cannot fit, or required pieces that cannot be admitted together, with explicit unjudged work; do not retry an identical rejected request indefinitely.

Apply shared throughput and concurrency limits, bounded transport retries, per-tool call caps and session call/cost budgets. Report exhausted budgets and work not judged.

Capture optional command output privately with bounded execution time and stream bookkeeping. Compress repetitive line shapes by rarity while preserving failure evidence; if it still cannot fit, use bounded passage selection before the caller's judgment. Report overlong lines, shape limits and oversized streams explicitly. The stream-size refusal occurs after execution and is not a disk cap or command sandbox. Head/tail context is not a substitute for rarity compression.

Keep collection omissions and display limits visible. Distinguish a result rendered concisely from evidence that was unavailable to judgment.

## Consequences

A refusal is preferable to an answer about silently altered evidence. Budgeting cannot promise zero provider refusals without a provider token-counting contract. Command permissions remain those of the host, and JEV_TOOLS_ALLOW_COMMAND=0 disables the optional command path.
