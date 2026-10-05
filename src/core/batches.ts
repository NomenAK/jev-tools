import {
  EVALUATION_MAX_TOKENS,
  QUESTION_TOKENS,
  REQUEST_BASE_TOKENS,
  REQUEST_MAX_TOKENS,
  STATE_TOKENS,
} from "../constants.ts";
import type { Question, State } from "../jev/types.ts";
import type { Result } from "../result.ts";

export interface UnjudgedQuestion {
  id: string;
  reason: string;
}

/**
 * Partition whole question groups for request packing; an oversized group is
 * still sent so the endpoint decides. Separately, questions locally estimated
 * over the per-evaluation budget (base + state + that question) are returned
 * as unjudged with an explicit reason instead of wasting a round trip. The
 * estimate is a heuristic admission policy, not a measurement: the endpoint
 * may disagree in either direction.
 */
export function prepareBatches(
  state: State,
  questions: Record<string, Question>,
  options: {
    groups?: readonly (readonly string[])[];
    witnesses?: readonly string[];
  },
): Result<{
  batches: string[][][];
  unjudged: UnjudgedQuestion[];
}> {
  const witnesses = new Set(options.witnesses ?? []);
  const seen = new Set<string>();
  for (const id of options.witnesses ?? []) {
    if (!Object.hasOwn(questions, id) || seen.has(id))
      return { ok: false, error: `Invalid witness question id: ${id}` };
    seen.add(id);
  }
  const groups: string[][] = [];
  for (const group of options.groups ?? []) {
    if (!group.length)
      return { ok: false, error: "Question groups must not be empty." };
    for (const id of group) {
      if (!Object.hasOwn(questions, id) || seen.has(id))
        return {
          ok: false,
          error: `Invalid or repeated grouped question id: ${id}`,
        };
      seen.add(id);
    }
    groups.push([...group]);
  }
  for (const id of Object.keys(questions)) if (!seen.has(id)) groups.push([id]);
  if (!groups.length && witnesses.size)
    return {
      ok: false,
      error: "Witnesses require at least one judgment group.",
    };
  const costs = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [
      id,
      JSON.stringify(question).length * QUESTION_TOKENS,
    ]),
  );
  // Per-evaluation bound, same coefficients as request planning: one
  // evaluation carries the state plus a single question.
  const stateCost = JSON.stringify(state).length * STATE_TOKENS;
  const unjudged: UnjudgedQuestion[] = [];
  const overBudget = new Set<string>();
  for (const id of Object.keys(questions)) {
    const evaluation = REQUEST_BASE_TOKENS + stateCost + (costs[id] ?? 0);
    if (evaluation > EVALUATION_MAX_TOKENS) {
      overBudget.add(id);
      unjudged.push({
        id,
        reason: `question exceeds the per-evaluation budget (~${Math.round(evaluation)} tokens > EVALUATION_MAX_TOKENS=${EVALUATION_MAX_TOKENS}); not judged`,
      });
    }
  }
  const judged = groups
    .map((group) => group.filter((id) => !overBudget.has(id)))
    .filter((group) => group.length > 0);
  const base =
    REQUEST_BASE_TOKENS +
    stateCost +
    [...witnesses]
      .filter((id) => !overBudget.has(id))
      .reduce((sum, id) => sum + (costs[id] ?? 0), 0);
  const batches: string[][][] = [];
  let batch: string[][] = [];
  let tokens = base;
  for (const group of judged) {
    const cost = group.reduce((sum, id) => sum + (costs[id] ?? 0), 0);
    if (batch.length && tokens + cost > REQUEST_MAX_TOKENS) {
      batches.push(batch);
      batch = [];
      tokens = base;
    }
    batch.push(group);
    tokens += cost;
  }
  if (batch.length) batches.push(batch);
  return { ok: true, batches, unjudged };
}

export function splitGroups(groups: readonly (readonly string[])[]): Result<{
  halves: [readonly (readonly string[])[], readonly (readonly string[])[]];
}> {
  if (groups.length < 2)
    return {
      ok: false,
      error: "Jev max_tokens_exceeded: indivisible question group refused.",
    };
  const middle = Math.ceil(groups.length / 2);
  return { ok: true, halves: [groups.slice(0, middle), groups.slice(middle)] };
}
