import type { Envelope } from "./core/output.ts";
import type { JudgmentOptions } from "./jev/types.ts";
import type { Result } from "./result.ts";

export interface SessionLimits {
  maxCalls?: number;
  maxUsd?: number;
  configurationError?: string;
}
export interface SessionCounters {
  calls: number;
  questions: number;
  unsure: number;
  abstain: number;
  refusals: number;
  costUsd: number;
  cacheHits: number;
}
export function readSessionLimits(env: NodeJS.ProcessEnv): SessionLimits {
  const maxCalls = Number(env.JEV_TOOLS_MAX_CALLS);
  const maxUsd = Number(env.JEV_TOOLS_MAX_USD);
  if (
    env.JEV_TOOLS_MAX_CALLS?.trim() &&
    (!Number.isSafeInteger(maxCalls) || maxCalls < 0)
  )
    return {
      configurationError:
        "Invalid JEV_TOOLS_MAX_CALLS: expected a non-negative safe integer. No Jev call was made; correct the environment variable.",
    };
  if (env.JEV_TOOLS_MAX_USD?.trim() && (!Number.isFinite(maxUsd) || maxUsd < 0))
    return {
      configurationError:
        "Invalid JEV_TOOLS_MAX_USD: expected a finite non-negative number (fractional USD allowed). No Jev call was made; correct the environment variable.",
    };
  return {
    ...(env.JEV_TOOLS_MAX_CALLS?.trim() &&
    Number.isSafeInteger(maxCalls) &&
    maxCalls >= 0
      ? { maxCalls }
      : {}),
    ...(env.JEV_TOOLS_MAX_USD?.trim() && Number.isFinite(maxUsd) && maxUsd >= 0
      ? { maxUsd }
      : {}),
  };
}
export class Session {
  private counters: SessionCounters = {
    calls: 0,
    questions: 0,
    unsure: 0,
    abstain: 0,
    refusals: 0,
    costUsd: 0,
    cacheHits: 0,
  };
  private readonly limits: SessionLimits;
  // USD gate: at most one admitted request in flight under a USD limit.
  private gateHeld = false;
  private gateEpoch = 0;
  private gateWaiters = new Set<() => void>();
  constructor(limits: SessionLimits) {
    this.limits = limits;
  }
  refusal(): string | undefined {
    const { maxCalls, maxUsd, configurationError } = this.limits;
    if (configurationError) return configurationError;
    if (maxCalls !== undefined && this.counters.calls >= maxCalls)
      return `JEV_TOOLS_MAX_CALLS=${maxCalls} reached; session total: ${this.counters.calls} Jev calls. No Jev call was made; the human sets this limit`;
    if (maxUsd !== undefined && this.counters.costUsd >= maxUsd)
      return `JEV_TOOLS_MAX_USD=${maxUsd.toFixed(5)} reached; session total: $${this.counters.costUsd.toFixed(5)}. No Jev call was made; the human sets this limit`;
    return undefined;
  }
  admit(questions: number): Result<Record<never, never>> {
    const error = this.refusal();
    if (error) {
      this.counters.refusals++;
      return { ok: false, error };
    }
    this.counters.calls++;
    this.counters.questions += questions;
    return { ok: true };
  }
  /**
   * Under a USD limit, admit one request at a time so each admission sees the
   * cost reported by every earlier request; without it, concurrent batches are
   * all admitted before any cost arrives and overshoot the limit. Only the
   * final admitted request can then exceed the limit, as documented.
   *
   * `awaitAdmission` reserves the gate atomically: the availability check and
   * `gateHeld = true` run with no await between them, so two callers cannot
   * both pass. It resolves to a release function that the client calls on
   * every exit path (response, refusal, failure, abort); release is
   * idempotent and ignores a gate that `reset()` already replaced.
   */
  requestGate(): Pick<JudgmentOptions, "awaitAdmission"> {
    return {
      awaitAdmission: async (signal) => {
        if (this.limits.maxUsd === undefined) return undefined;
        while (this.gateHeld) {
          signal?.throwIfAborted();
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              this.gateWaiters.delete(wake);
              reject(signal?.reason);
            };
            const wake = () => {
              signal?.removeEventListener("abort", onAbort);
              resolve();
            };
            this.gateWaiters.add(wake);
            signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
        signal?.throwIfAborted();
        this.gateHeld = true;
        const epoch = this.gateEpoch;
        let released = false;
        return () => {
          if (released || epoch !== this.gateEpoch) return;
          released = true;
          this.gateHeld = false;
          this.wakeGateWaiters();
        };
      },
    };
  }
  // Every waiter rechecks; the first to run reserves, the rest wait again.
  private wakeGateWaiters(): void {
    const waiters = [...this.gateWaiters];
    this.gateWaiters.clear();
    for (const wake of waiters) wake();
  }
  recordUsage(usage: { costUsd: number }): void {
    this.counters.costUsd += usage.costUsd;
  }
  record(envelope: Envelope): void {
    for (const line of envelope.lines) {
      if (line.type === "answer" && line.band === "unsure")
        this.counters.unsure++;
      if (line.type === "answer" && line.band === "abstain")
        this.counters.abstain++;
      if (line.type === "yield") {
        this.counters.cacheHits += line.value.cacheHits;
      }
    }
  }
  snapshot(): Readonly<SessionCounters> {
    return { ...this.counters };
  }
  reset(): void {
    // A new session generation: outstanding release functions become no-ops.
    this.gateEpoch++;
    this.gateHeld = false;
    this.wakeGateWaiters();
    this.counters = {
      calls: 0,
      questions: 0,
      unsure: 0,
      abstain: 0,
      refusals: 0,
      costUsd: 0,
      cacheHits: 0,
    };
  }
}
