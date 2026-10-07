import {
  type BudgetRefusal,
  buildEnvelope,
  type Envelope,
  type EnvelopeInput,
  type Yield,
} from "../core/output.ts";
import type { GuideContext } from "../guide.ts";
import type { JudgmentOptions } from "../jev/types.ts";
import { renderEnvelope } from "../render.ts";
import type { Result } from "../result.ts";
import type { ToolRuntime } from "../runtime.ts";
import type { Session } from "../session.ts";

// Per-call judging ceremony shared by every tool: a session/call budget gate
// plus usage recording. The budget stays readable so callers with extra
// guards (docs-check) can wrap beforeRequest without owning the counters.
export function createJudgeOptions({
  signal,
  maxCalls,
  session,
  recordUsage = true,
}: {
  signal?: AbortSignal;
  maxCalls?: number;
  session: Session;
  recordUsage?: boolean;
}): {
  options: JudgmentOptions;
  budget: () => BudgetRefusal | undefined;
  gate: (questionCount: number) => Result<object>;
  gateWith: (reserved: number) => (questionCount: number) => Result<object>;
  spent: () => number;
} {
  let sent = 0;
  let budget: BudgetRefusal | undefined;
  // A caller that holds back part of the cap for a later phase (check-diff
  // keeps the matrix batches for last) passes the held-back count per
  // request; the reported message still names the caller's own max_calls.
  // The reservation is a parameter, not shared mutable state, so concurrent
  // requests cannot observe each other's reservations.
  const gateWith = (reserved: number) => (questionCount: number) => {
    const limit = maxCalls === undefined ? undefined : maxCalls - reserved;
    if (limit !== undefined && sent >= limit) {
      budget = {
        kind: "max_calls",
        message: `max_calls=${maxCalls} reached`,
      };
      return { ok: false as const, error: budget.message };
    }
    const admitted = session.admit(questionCount);
    if (!admitted.ok) {
      budget = { kind: "session", message: admitted.error };
      return admitted;
    }
    sent++;
    return admitted;
  };
  const gate = gateWith(0);
  return {
    budget: () => budget,
    gate,
    gateWith,
    // Lets a caller stop before a request it knows will be refused, without
    // advancing the counter the gate owns.
    spent: () => sent,
    options: {
      signal,
      beforeRequest: gate,
      ...(recordUsage
        ? {
            onUsage: (usage: { inputTokens: number; costUsd: number }) =>
              session.recordUsage(usage),
          }
        : {}),
    },
  };
}

// Tool-result finalization shared by the four registered tools: envelope,
// session recording, guide delivery, rendered text. The metrics spread keeps
// each tool's exact yield shape (some spreads carry extra counters).
export function finishToolCall(
  runtime: ToolRuntime,
  ctx: GuideContext,
  started: number,
  input: Omit<EnvelopeInput, "yield">,
  metrics: Omit<Yield, "elapsedMs"> & Record<string, unknown>,
): {
  envelope: Envelope;
  content: [{ type: "text"; text: string }];
} {
  const envelope = buildEnvelope({
    ...input,
    yield: { ...metrics, elapsedMs: performance.now() - started },
  });
  runtime.session.record(envelope);
  runtime.guide.deliver(ctx);
  return {
    envelope,
    content: [{ type: "text" as const, text: renderEnvelope(envelope) }],
  };
}
