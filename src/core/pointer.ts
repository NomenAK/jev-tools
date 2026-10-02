import { ORDER_DISAGREE_MIN, ORDER_REVERSE_BELOW } from "../constants.ts";
import type { Question } from "../jev/types.ts";

export function pointerQuestion({
  instructions,
  noneLabel,
  candidates,
  reverse = false,
}: {
  instructions: string;
  noneLabel: string;
  candidates: readonly { id: string; label: string }[];
  reverse?: boolean;
}): Extract<Question, { type: "choice" }> {
  const ordered = reverse ? [...candidates].reverse() : candidates;
  return {
    type: "choice",
    instructions,
    criteria: Object.fromEntries([
      ...ordered.map((candidate) => [candidate.id, candidate.label]),
      ["none", noneLabel],
    ]),
  };
}
export function needsReverse(
  probabilities: Readonly<Record<string, number>>,
  candidateCount: number,
): boolean {
  return (
    candidateCount > 1 &&
    Math.max(...Object.values(probabilities)) < ORDER_REVERSE_BELOW
  );
}
export function readPointer(
  first: Readonly<Record<string, number>>,
  second?: Readonly<Record<string, number>>,
) {
  const ranked = Object.entries(first)
    .map(([id, p]) => ({ id, p: second ? (p + (second[id] ?? 0)) / 2 : p }))
    .sort((a, b) => b.p - a.p);
  const head = ranked[0];
  return {
    ranked,
    orderDependent: !!(
      second &&
      head &&
      Math.abs((first[head.id] ?? 0) - (second[head.id] ?? 0)) >
        ORDER_DISAGREE_MIN
    ),
  };
}
