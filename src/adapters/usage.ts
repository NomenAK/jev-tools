import type { JudgmentMetadata } from "../jev/types.ts";

export function hostUsage(isOmp: boolean, usage: JudgmentMetadata["usage"]) {
  if (isOmp || !usage) return {};
  return {
    usage: {
      input: usage.inputTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.inputTokens,
      cost: {
        input: usage.costUsd,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: usage.costUsd,
      },
    },
  };
}
