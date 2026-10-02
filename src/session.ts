import type { Envelope } from "./core/output.ts";
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
