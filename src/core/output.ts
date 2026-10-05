import {
  BAND_BOOL_GRAY_A,
  BAND_BOOL_YES_MIN,
  BAND_CHOICE_VERDICT_MIN,
  CANNOT_TELL_MIN,
  LIMIT_DISPLAY_MAX_PATHS,
} from "../constants.ts";
import type { Answer } from "../jev/types.ts";
import type { Item, RawValue } from "../result-types.ts";

export interface Limitation {
  fact: string;
  next: string;
  cause?: string;
  path?: string;
  dependency?: string;
  count?: number;
}
export interface Yield {
  calls: number;
  questions: number;
  costUsd?: number;
  cacheHits: number;
  cacheRequests: number;
  elapsedMs: number;
}
export type Band = "verdict" | "unsure" | "abstain";
export interface DisplayValue {
  head: string | number;
  p: number;
}
export interface Candidate {
  label: string;
  value: DisplayValue;
}
interface CandidateFields {
  orderDependent?: boolean;
  candidates?: readonly Candidate[];
}
export type BandPolicy = (value: DisplayValue, input: AnswerInput) => Band;
export type BudgetRefusal = { kind: "max_calls" | "session"; message: string };
export interface AnswerInput extends CandidateFields {
  unjudged?: boolean;
  source?: "fresh" | "cache";
  publicResult?: string | number | boolean;
  rawValues?: RawValue[];
  reportControls?: Extract<
    Item,
    { treatment: "judged" }
  >["judgment"]["controls"];
  label: string;
  answer?: Exclude<Answer, { type: "unjudged" }>;
  value?: DisplayValue;
  band?: Band;
  uncalibrated?: boolean;
  missing?: string;
  reason?: string;
  verify?: boolean;
}
export type OutputLine =
  | (CandidateFields & {
      type: "answer";
      label: string;
      value: DisplayValue;
      band: Band;
      uncalibrated: boolean;
      source?: "fresh" | "cache";
      publicResult?: string | number | boolean;
      rawValues?: RawValue[];
      reportControls?: Extract<
        Item,
        { treatment: "judged" }
      >["judgment"]["controls"];
      reason?: string;
    })
  | { type: "unjudged"; label: string; reason: string; next: string }
  | { type: "fact"; fact: string; next: string }
  | {
      type: "limit-group";
      cause: string;
      count: number;
      priority: boolean;
      examples: readonly string[];
      remaining: number;
      next: string;
    }
  | {
      type: "collection";
      title: string;
      count: number;
      items: readonly string[];
      next: string;
    }
  | { type: "unchecked"; items: readonly string[] }
  | { type: "refusal"; message: string }
  | { type: "list"; title: string; items: readonly string[] }
  | (CandidateFields & {
      type: "entry";
      candidate: Candidate;
      band: Band;
      relevant?: readonly Candidate[];
      nextRead?: readonly string[];
      orderProbabilities?: readonly [number, number];
    })
  | {
      type: "state";
      files: number;
      integrity: "ok" | "failed";
      warnings: readonly string[];
    }
  | {
      type: "command";
      cwd: string;
      framework: string;
      config?: string;
      project?: string;
      executable: string;
      args: readonly string[];
    }
  | { type: "yield"; value: Yield };
export interface Envelope {
  lines: readonly OutputLine[];
}
export interface EnvelopeInput {
  state?: Omit<Extract<OutputLine, { type: "state" }>, "type">;
  answers?: readonly AnswerInput[];
  unjudged?: readonly { label: string; reason: string; next: string }[];
  lines?: readonly Extract<
    OutputLine,
    { type: "list" | "entry" | "command" | "collection" }
  >[];
  policy?: BandPolicy;
  controls?: readonly Limitation[];
  limitations?: readonly Limitation[];
  limitationPriorityPaths?: readonly string[];
  unchecked?: readonly string[];
  refusal?: string;
  budget?: BudgetRefusal;
  yield: Yield;
}
export function askBand(value: DisplayValue, input: AnswerInput): Band {
  const answer = input.answer;
  if (answer?.type === "bool")
    return value.p <= BAND_BOOL_GRAY_A || value.p >= BAND_BOOL_YES_MIN
      ? "verdict"
      : "unsure";
  if (answer && (answer.probabilities.cannot_tell ?? 0) >= CANNOT_TELL_MIN)
    return "abstain";
  return value.p >= BAND_CHOICE_VERDICT_MIN ? "verdict" : "unsure";
}
function displayValue(input: AnswerInput): DisplayValue {
  if (input.value) return input.value;
  const answer = input.answer;
  if (!answer)
    throw new Error("An answer requires a typed value or a Jev answer");
  if (answer.type === "bool")
    return { head: answer.p >= 0.5 ? "yes" : "no (not shown)", p: answer.p };
  const p = input.verify
    ? Math.max(
        answer.probabilities.holds ?? 0,
        answer.probabilities.contradicted ?? 0,
        (answer.probabilities.not_addressed ?? 0) +
          (answer.probabilities.cannot_tell ?? 0),
      )
    : Math.max(...Object.values(answer.probabilities));
  return { head: answer.type === "choice" ? answer.choice : answer.score, p };
}
export function buildEnvelope(input: EnvelopeInput): Envelope {
  const lines: OutputLine[] = [];
  if (input.budget?.kind === "session" && input.yield.calls === 0)
    return {
      lines: [
        { type: "refusal", message: input.budget.message },
        { type: "yield", value: input.yield },
      ],
    };
  if (input.state) lines.push({ type: "state", ...input.state });
  const failed = (input.controls ?? [])
    .map((control) => control.fact)
    .join("; ");
  for (const item of input.answers ?? []) {
    if (item.unjudged) {
      lines.push({
        type: "unjudged",
        label: item.label,
        reason: item.reason ?? "required group answer missing",
        next:
          item.missing ?? "inspect the available evidence without a judgment",
      });
      continue;
    }
    const value = displayValue(item);
    const initial = item.band ?? (input.policy ?? askBand)(value, item);
    const band = initial === "verdict" && failed ? "unsure" : initial;
    const reason =
      band === "abstain"
        ? (item.reason ??
          item.missing ??
          "proof missing; add decisive evidence to paths or command")
        : failed && initial === "verdict"
          ? failed
          : item.reason;
    lines.push({
      type: "answer",
      label: item.label,
      value,
      band,
      uncalibrated: item.uncalibrated ?? false,
      ...((item.source ?? item.answer?.source)
        ? { source: item.source ?? item.answer?.source }
        : {}),
      ...(item.publicResult !== undefined
        ? { publicResult: item.publicResult }
        : {}),
      ...(item.rawValues ? { rawValues: item.rawValues } : {}),
      ...(item.reportControls ? { reportControls: item.reportControls } : {}),
      ...(reason ? { reason } : {}),
      ...(item.orderDependent !== undefined
        ? { orderDependent: item.orderDependent }
        : {}),
      ...(item.candidates ? { candidates: item.candidates } : {}),
    });
  }
  for (const item of input.unjudged ?? [])
    lines.push({ type: "unjudged", ...item });
  for (const line of input.lines ?? [])
    lines.push(
      line.type === "entry" && line.band === "verdict" && failed
        ? { ...line, band: "unsure" }
        : line,
    );
  if (input.refusal) lines.push({ type: "refusal", message: input.refusal });
  if (input.budget?.kind === "session")
    lines.push({ type: "refusal", message: input.budget.message });
  for (const fact of input.controls ?? [])
    lines.push({ type: "fact", ...fact });
  const groups = new Map<
    string,
    Omit<Extract<OutputLine, { type: "limit-group" }>, "examples"> & {
      examples: string[];
    }
  >();
  for (const limit of input.limitations ?? []) {
    if (
      !limit.cause ||
      !limit.path ||
      input.limitationPriorityPaths === undefined
    ) {
      lines.push({ type: "fact", fact: limit.fact, next: limit.next });
      continue;
    }
    const priority =
      input.limitationPriorityPaths?.includes(limit.path) ?? false;
    const key = JSON.stringify([priority, limit.cause, limit.next]);
    const group = groups.get(key) ?? {
      type: "limit-group",
      cause: limit.cause,
      count: 0,
      priority,
      examples: [],
      remaining: 0,
      next: limit.next,
    };
    group.count += limit.count ?? 1;
    if (priority || group.examples.length < LIMIT_DISPLAY_MAX_PATHS)
      group.examples.push(
        `${limit.path}${limit.dependency ? ` (${limit.dependency})` : ""}`,
      );
    else group.remaining++;
    groups.set(key, group);
  }
  lines.push(
    ...[...groups.values()].sort(
      (a, b) => Number(b.priority) - Number(a.priority),
    ),
  );
  if (input.budget?.kind === "max_calls")
    lines.push({
      type: "fact",
      fact: input.budget.message,
      next: "raise max_calls",
    });
  if (input.unchecked?.length)
    lines.push({ type: "unchecked", items: input.unchecked });
  const gray = lines.reduce(
    (count, line) =>
      count + Number(line.type === "answer" && line.band === "unsure"),
    0,
  );
  if (gray > 0)
    lines.push({
      type: "fact",
      fact: `${gray}/${input.answers?.length ?? 0} answers unsure`,
      next: "read the decisive passage or add its file to paths",
    });
  lines.push({ type: "yield", value: input.yield });
  return { lines };
}
