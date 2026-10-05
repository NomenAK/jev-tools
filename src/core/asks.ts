import {
  BAND_BOOL_YES_MIN,
  BAND_CHOICE_VERDICT_MIN,
  CANNOT_TELL_MIN,
  CHOICE_MAX_OPTIONS,
  ORDER_DISAGREE_MIN,
  ORDER_REVERSE_BELOW,
  SAME_SUBJECT_MIN,
  SCORE_MAX_LEVELS,
  SCORE_MIN_LEVELS,
} from "../constants.ts";
import type { Answer, Question } from "../jev/types.ts";
import { isRecord, type Result } from "../result.ts";
import type { AnswerInput, Limitation } from "./output.ts";

export type Ask =
  | { intent: "verify"; about?: string; claims: Record<string, string> }
  | {
      intent: "classify";
      about?: string;
      categories: Record<string, string>;
      pick?: "one" | "many";
      by?: string;
    }
  | { intent: "decide"; about?: string; hypotheses: Record<string, string> }
  | { intent: "rate"; about?: string; dimension: string; levels: string[] }
  | {
      intent: "locate";
      about?: string;
      target: string;
      among: string[];
      count?: "one" | "many";
      attribution?: boolean;
    }
  | { intent: "free"; about?: string; question: Question };
interface Reading {
  id: string;
  askIndex: number;
  label: string;
  kind: "verify" | "decide" | "plain";
  twin?: string;
  controls?: Record<string, string>;
  // Same-subject control id: kept out of controls and out of the
  // first-round group. Tools judge it in a second round only for
  // contradicted first-round verdicts; a missing answer never affects
  // holds/not_addressed, and demotes only contradicted.
  sameSubject?: string;
  uncalibrated: boolean;
  attributable?: boolean;
  among?: string[];
  missing: string;
  options?: Record<string, string>;
  levels?: string[];
}
export interface CompiledAsks {
  asks: Ask[];
  questions: Record<string, Question>;
  groups: string[][];
  readings: Reading[];
  warnings: Limitation[];
}
const gap =
  "If a document, file, requirement or output that the question refers to is missing or empty in the state, choose cannot_tell.";
const other = "None of these substantive options applies.";
const cannot = "The state does not contain the evidence needed to decide.";
const bool = (text: string): Question => ({
  type: "bool",
  instructions: text,
  criteria: {
    true: "The statement is shown true.",
    false: "The statement is not shown true.",
  },
});
const text = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;
const record = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.keys(v).length > 0 && Object.values(v).every(text);
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function canonical(criteria: Record<string, string>): Record<string, string> {
  const first = ["none", "not_addressed"].filter((k) => k in criteria);
  const last = ["other", "cannot_tell"].filter((k) => k in criteria);
  const middle = Object.keys(criteria)
    .filter((k) => !first.includes(k) && !last.includes(k))
    .sort((a, b) => hash(a) - hash(b) || a.localeCompare(b));
  return Object.fromEntries(
    [...first, ...middle, ...last].map((k) => [k, criteria[k] ?? ""]),
  );
}
function reverse(
  q: Extract<Question, { type: "choice" }>,
): Extract<Question, { type: "choice" }> {
  const keys = Object.keys(q.criteria);
  const middle = keys
    .filter(
      (k) => !["none", "not_addressed", "other", "cannot_tell"].includes(k),
    )
    .reverse();
  let index = 0;
  return {
    ...q,
    criteria: Object.fromEntries(
      keys.map((k) => {
        const key = ["none", "not_addressed", "other", "cannot_tell"].includes(
          k,
        )
          ? k
          : (middle[index++] ?? k);
        return [key, q.criteria[key] ?? ""];
      }),
    ),
  };
}
// Reversal permutes only substantive options, so with 0 or 1 of them the
// reversed question is byte-identical and the client cache would answer it
// from the first run: there is no order risk to check, so no twin is needed.
function reversesOrder(q: Extract<Question, { type: "choice" }>): boolean {
  const keys = Object.keys(q.criteria);
  const reversed = Object.keys(reverse(q).criteria);
  return keys.some((key, index) => key !== reversed[index]);
}
export function compileAsks(
  input: unknown,
  { surface }: { surface: "ask" | "files" },
): Result<CompiledAsks> {
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return {
        ok: false,
        error:
          'Invalid asks JSON. Example: {"intent":"verify","claims":{"c1":"The file validates tokens"}}',
      };
    }
  }
  const values = Array.isArray(input) ? input : [input];
  const plan: CompiledAsks = {
    asks: [],
    questions: {},
    groups: [],
    readings: [],
    warnings: [],
  };
  const fail = (): Result<CompiledAsks> => ({
    ok: false,
    error:
      'Invalid intention or missing field. Example: {"intent":"verify","claims":{"c1":"The file validates tokens"}}',
  });
  if (!values.length) return fail();
  let questionCount = 0;
  function lint(id: string, s: string, claim = false) {
    if (claim && /\b(not|never|no longer|without)\b|;|\band\b/i.test(s))
      plan.warnings.push({
        fact: `${id} is negated or compound (sent as written)`,
        next: "use one positive fact when possible",
      });
    if (
      /\b(how many|how much|count|number of)\b|\b(exactly|at least|at most|more than|fewer than)\s+\d+|\b\d+\s+(times|lines|calls|occurrences|files)\b|\d{4}-\d{2}-\d{2}|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,4}\b|\b\d{1,4}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(before|after|since|until)\s+\d{4}/i.test(
        s,
      )
    )
      plan.warnings.push({
        fact: `${id} asks for a count or a date: Jev does not count`,
        next: "use grep or code",
      });
  }
  for (const [index, value] of values.entries()) {
    if (
      !isRecord(value) ||
      typeof value.intent !== "string" ||
      (value.about !== undefined && !text(value.about))
    )
      return fail();
    const allowed: Record<string, readonly string[]> = {
      verify: ["claims"],
      classify: ["categories", "pick", "by"],
      decide: ["hypotheses"],
      rate: ["dimension", "levels"],
      locate: ["target", "among", "count", "attribution"],
      free: ["question"],
    };
    if (
      Object.keys(value).some(
        (k) =>
          ![
            "intent",
            "about",
            ...(allowed[String(value.intent)] ?? []),
          ].includes(k),
      )
    )
      return fail();
    const about =
      typeof value.about === "string"
        ? value.about
        : surface === "files"
          ? "content"
          : "the state";
    const group: string[] = [];
    const add = (q: Question, grouped = true) => {
      const id = `q${++questionCount}`;
      plan.questions[id] = q;
      if (grouped) group.push(id);
      return id;
    };
    const choice = (
      instructions: string,
      criteria: Record<string, string>,
      fixed = false,
    ): Question => ({
      type: "choice",
      instructions:
        surface === "ask" ? `${instructions}\n${gap}` : instructions,
      criteria: fixed
        ? criteria
        : canonical({
            ...criteria,
            ...(surface === "ask" ? { cannot_tell: cannot } : {}),
          }),
    });
    const reading = (
      id: string,
      label: string,
      kind: Reading["kind"] = "plain",
      extra: Partial<Reading> = {},
    ) => {
      const match = about.match(/^files\["(.+)"\]$/);
      const missing =
        about === "output"
          ? "add the missing output through command"
          : match
            ? `read ${match[1]} and add it to paths`
            : ["state", "the state"].includes(about)
              ? "complete the state note"
              : `add decisive evidence for ${about} to paths`;
      plan.readings.push({
        id,
        askIndex: index,
        label,
        kind,
        uncalibrated: kind !== "verify",
        missing,
        ...extra,
      });
      plan.groups.push(group.splice(0));
    };
    if (value.intent === "verify") {
      if (
        !record(value.claims) ||
        Object.values(value.claims).some((s) => s.trim().endsWith("?"))
      )
        return fail();
      for (const [claim, s] of Object.entries(value.claims)) {
        lint(claim, s, true);
        const label = `${claim} ${JSON.stringify(s)}`;
        const q = choice(
          `For ${about}, which issue describes this exact statement: ${s}`,
          {
            not_addressed: "The state does not address this statement.",
            holds: "The state shows this statement holds.",
            contradicted: "The state shows this statement is contradicted.",
            cannot_tell: cannot,
          },
          true,
        );
        const id = add(q);
        const twin = add(reverse(q as Extract<Question, { type: "choice" }>));
        const check = add(
          bool(`Is the following statement true of ${about}: ${s}`),
        );
        // Second-round control: compiled here so the question text is fixed,
        // but kept out of the first-round group. Tools judge it only for
        // readings whose first round is a contradicted verdict.
        const same = add(
          bool(
            `Does the evidence in ${about} that bears on this statement concern the same subject (same entity, file, version, run and moment) as the statement: ${s}`,
          ),
          false,
        );
        reading(id, label, "verify", {
          twin,
          controls: { exact: check },
          sameSubject: same,
        });
      }
    } else if (value.intent === "decide" || value.intent === "classify") {
      const criteria =
        value.intent === "decide" ? value.hypotheses : value.categories;
      if (record(criteria)) {
        const reserved = Object.keys(criteria).find((key) =>
          ["none", "other", "cannot_tell", "not_addressed"].includes(key),
        );
        if (reserved)
          return {
            ok: false,
            error: `${value.intent === "classify" ? "categories" : "hypotheses"}.${reserved} is reserved; omit it${reserved === "other" ? ", the compiler adds other automatically" : ", use a non-reserved option name"}. Example: {"intent":"classify","categories":{"validation":"Validates arguments"},"pick":"one"}`,
          };
      }
      if (
        !record(criteria) ||
        (value.pick !== undefined &&
          !["one", "many"].includes(String(value.pick)))
      )
        return fail();
      const sorted = canonical(criteria);
      for (const [k, s] of Object.entries(sorted)) lint(k, s);
      if (value.intent === "classify" && value.pick === "many") {
        for (const [k, s] of Object.entries(sorted))
          reading(add(bool(`For ${about}: ${s}`)), `${k} ${JSON.stringify(s)}`);
      } else {
        const id = add(
          choice(
            `Which option holds for ${about}${text(value.by) ? ` by ${value.by}` : ""}?`,
            { ...sorted, other },
          ),
        );
        const controls: Record<string, string> = {};
        if (value.intent === "decide")
          for (const [k, s] of Object.entries(sorted))
            controls[k] = add(
              bool(`Is the following statement true of ${about}: ${s}`),
            );
        reading(
          id,
          `${value.intent}${index + 1}`,
          value.intent === "decide" ? "decide" : "plain",
          { controls, options: sorted },
        );
      }
    } else if (value.intent === "rate") {
      if (
        !text(value.dimension) ||
        !Array.isArray(value.levels) ||
        value.levels.length < SCORE_MIN_LEVELS ||
        value.levels.length > SCORE_MAX_LEVELS ||
        !value.levels.every(
          (s) =>
            text(s) &&
            !/^\s*(\d+(\.\d+)?|low|medium|moderate|high)\s*$/i.test(s),
        )
      )
        return fail();
      for (const [i, s] of value.levels.entries())
        lint(`rate${index + 1}.${i + 1}`, s);
      reading(
        add({
          type: "score",
          instructions: `Rate ${value.dimension} of ${about}`,
          criteria: value.levels,
        }),
        value.dimension,
        "plain",
        { levels: value.levels },
      );
    } else if (value.intent === "locate") {
      if (
        surface !== "ask" ||
        !text(value.target) ||
        !Array.isArray(value.among) ||
        !value.among.length ||
        !value.among.every(text) ||
        new Set(value.among).size !== value.among.length ||
        (value.count !== undefined &&
          !["one", "many"].includes(String(value.count))) ||
        (value.attribution !== undefined &&
          typeof value.attribution !== "boolean")
      )
        return fail();
      if (value.count === "many")
        for (const candidate of value.among)
          reading(
            add(bool(`Does ${candidate} in ${about} ${value.target}?`)),
            `${candidate} ${JSON.stringify(value.target)}`,
          );
      else
        reading(
          add(
            choice(`Which candidate in ${about} ${value.target}?`, {
              none: "No candidate matches.",
              ...Object.fromEntries(
                value.among.map((k) => [
                  k,
                  `Candidate ${k} matches the target.`,
                ]),
              ),
            }),
          ),
          value.target,
          "plain",
          { attributable: value.attribution === true, among: value.among },
        );
      if (value.attribution && value.count === "many")
        plan.warnings.push({
          fact: "attribution applies only to locate count: one",
          next: "use count: one for an ablation, or inspect each matrix match",
        });
    } else if (value.intent === "free") {
      const q = value.question;
      if (
        !isRecord(q) ||
        !text(q.instructions) ||
        Object.keys(q).some(
          (k) => !["type", "instructions", "criteria"].includes(k),
        )
      )
        return fail();
      lint(`free${index + 1}`, q.instructions, true);
      if (q.type === "bool") {
        if (
          q.criteria !== undefined &&
          (!isRecord(q.criteria) ||
            Object.entries(q.criteria).some(
              ([k, v]) =>
                !["true", "false"].includes(k) || typeof v !== "string",
            ))
        )
          return fail();
        reading(
          add(q as Question),
          `free${index + 1} ${JSON.stringify(q.instructions)}`,
        );
      } else if (q.type === "choice") {
        if (!record(q.criteria)) return fail();
        const criteria = { ...q.criteria };
        if (!("other" in criteria)) {
          criteria.other = other;
          plan.warnings.push({
            fact: `free${index + 1}: other added`,
            next: "cover all possible outcomes",
          });
        }
        reading(
          add(choice(q.instructions, criteria)),
          `free${index + 1} ${JSON.stringify(q.instructions)}`,
        );
      } else if (q.type === "score") {
        if (
          !Array.isArray(q.criteria) ||
          q.criteria.length < SCORE_MIN_LEVELS ||
          q.criteria.length > SCORE_MAX_LEVELS ||
          !q.criteria.every(text)
        )
          return fail();
        reading(
          add(q as Question),
          `free${index + 1} ${JSON.stringify(q.instructions)}`,
        );
      } else return fail();
    } else return fail();
    plan.asks.push(value as unknown as Ask);
  }
  if (
    Object.values(plan.questions).some(
      (q) =>
        q.type === "choice" &&
        Object.keys(q.criteria).length > CHOICE_MAX_OPTIONS,
    )
  )
    return fail();
  return { ok: true, ...plan };
}
function probabilities(
  a: Answer | undefined,
): Record<string, number> | undefined {
  return a?.type === "choice" ? a.probabilities : undefined;
}
function merged(p: Record<string, number>, verify: boolean) {
  return verify
    ? {
        holds: p.holds ?? 0,
        contradicted: p.contradicted ?? 0,
        not_addressed: (p.not_addressed ?? 0) + (p.cannot_tell ?? 0),
      }
    : p;
}
function top(p: Record<string, number>): string {
  return Object.keys(p).sort((a, b) => (p[b] ?? 0) - (p[a] ?? 0))[0] ?? "other";
}
interface FirstRoundChoice {
  original: Record<string, number>;
  second: Record<string, number> | undefined;
  p: Record<string, number>;
  values: Record<string, number>;
  head: string;
  mass: number;
  band: AnswerInput["band"];
  reason: string | undefined;
}
// First-round head and band for a choice reading, up to but excluding the
// same-subject and reverse-order controls. Shared by readAsks and
// sameSubjectQuestions so the second round fires exactly for contradicted
// verdicts. Undefined when the first round cannot name a head.
function firstRoundChoice(
  r: Reading,
  answers: Record<string, Answer>,
  reversed: Record<string, Answer>,
): FirstRoundChoice | undefined {
  const answer = answers[r.id];
  const members = [
    r.id,
    ...(r.twin ? [r.twin] : []),
    ...Object.values(r.controls ?? {}),
  ];
  if (members.some((id) => !answers[id] || answers[id]?.type === "unjudged"))
    return undefined;
  if (answer?.type !== "choice") return undefined;
  const original = answer.probabilities;
  const second = probabilities(r.twin ? answers[r.twin] : reversed[r.id]);
  const p = second
    ? Object.fromEntries(
        Object.keys(original).map((k) => [
          k,
          ((original[k] ?? 0) + (second[k] ?? 0)) / 2,
        ]),
      )
    : original;
  const values = merged(p, r.kind === "verify");
  let head = top(values);
  let mass = values[head] ?? 0;
  let band: AnswerInput["band"] =
    (p.cannot_tell ?? 0) >= CANNOT_TELL_MIN
      ? "abstain"
      : mass >= BAND_CHOICE_VERDICT_MIN
        ? "verdict"
        : "unsure";
  if (band === "abstain") {
    head = "cannot_tell";
    mass = p.cannot_tell ?? 0;
  }
  let reason: string | undefined;
  const exact = r.controls?.exact ? answers[r.controls.exact] : undefined;
  if (
    r.kind === "verify" &&
    exact?.type === "bool" &&
    ((head === "holds" && exact.p < 0.5) ||
      (head === "contradicted" && exact.p >= 0.5) ||
      (["not_addressed", "cannot_tell"].includes(head) &&
        exact.p >= BAND_BOOL_YES_MIN))
  ) {
    band = "unsure";
    reason = `scope/evidence disagreement: issues ${head} ${mass.toFixed(2)}, bool ${exact.p >= 0.5 ? "yes" : "no"} ${exact.p.toFixed(2)}; no verdict: ${r.missing}`;
  }
  if (r.kind === "decide") {
    const entries = Object.entries(r.controls ?? {});
    const conflict = entries.find(([k, id]) => {
      const a = answers[id];
      return (
        a?.type === "bool" &&
        ((k === head && a.p < 0.5) ||
          (["other", "cannot_tell"].includes(head) && a.p >= BAND_BOOL_YES_MIN))
      );
    });
    if (conflict) {
      const a = answers[conflict[1]];
      if (a?.type === "bool") {
        band = "unsure";
        reason = `scope/evidence disagreement: choice ${head} ${mass.toFixed(2)}, ${conflict[0]} ${JSON.stringify(r.options?.[conflict[0]])} bool ${a.p >= 0.5 ? "yes" : "no"} ${a.p.toFixed(2)}; no verdict: ${r.missing}`;
      }
    }
  }
  if (
    Object.values(r.controls ?? {}).some((id) => answers[id]?.type !== "bool")
  ) {
    band = "unsure";
    reason =
      "coherence control unjudged; no verdict: rerun with decisive evidence";
  }
  return { original, second, p, values, head, mass, band, reason };
}
export function reverseQuestions(
  plan: CompiledAsks,
  answers: Record<string, Answer>,
): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const r of plan.readings) {
    const q = plan.questions[r.id];
    const p = probabilities(answers[r.id]);
    if (
      !r.twin &&
      q?.type === "choice" &&
      p &&
      reversesOrder(q) &&
      Math.max(...Object.values(p)) < ORDER_REVERSE_BELOW
    )
      questions[r.id] = reverse(q);
  }
  return questions;
}
// Second-round controls for contradicted first-round verdicts, in the same
// request structure as reverseQuestions: one extra judge call for all such
// readings, on the same state. Tools count the call against max_calls; a
// refused or failed round leaves the control unjudged and readAsks demotes.
export function sameSubjectQuestions(
  plan: CompiledAsks,
  answers: Record<string, Answer>,
  reversed: Record<string, Answer> = {},
): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const r of plan.readings) {
    if (r.kind !== "verify" || !r.sameSubject) continue;
    const first = firstRoundChoice(r, answers, reversed);
    if (first?.head === "contradicted" && first.band === "verdict") {
      const question = plan.questions[r.sameSubject];
      if (question) questions[r.sameSubject] = question;
    }
  }
  return questions;
}
export function readAsks(
  plan: CompiledAsks,
  answers: Record<string, Answer>,
  reversed: Record<string, Answer> = {},
): AnswerInput[] {
  const result: AnswerInput[] = [];
  for (const r of plan.readings) {
    const answer = answers[r.id];
    const members: [string, string][] = [
      [r.id, r.kind === "verify" && r.twin ? "issues" : "judgment"],
      ...(r.twin ? [[r.twin, "twin"] as [string, string]] : []),
      ...Object.entries(r.controls ?? {}).map(
        ([name, id]) => [id, `${name} bool`] as [string, string],
      ),
    ];
    const missing = members.filter(
      ([id]) => !answers[id] || answers[id]?.type === "unjudged",
    );
    if (missing.length) {
      const reason = missing
        .map(([id, name]) => {
          const a = answers[id];
          return `${name} unjudged: ${a?.type === "unjudged" ? a.reason : "missing answer"}`;
        })
        .join("; ");
      result.push({
        label: r.label,
        unjudged: true,
        reason: `${reason}; ${r.missing}`,
        uncalibrated: r.uncalibrated,
      });
      continue;
    }
    if (!answer || answer.type === "unjudged") continue;
    if (answer.type !== "choice") {
      const question = plan.questions[r.id];
      const levels =
        r.levels ??
        (question?.type === "score" ? question.criteria : undefined);
      const level =
        answer.type === "score"
          ? r.levels?.[Math.round(answer.score)]
          : undefined;
      let reason: string | undefined;
      if (answer.type === "score" && levels) {
        const peak = Math.max(0, ...Object.values(answer.probabilities));
        // Unsure path only: a verdict's leading mass already pins the score,
        // while a split unsure mass makes the expected score misleading.
        if (peak < BAND_CHOICE_VERDICT_MIN) {
          const rank = (key: string) => {
            const at = levels.indexOf(key);
            return at >= 0 ? at : /^\d+$/.test(key) ? Number(key) : -1;
          };
          const [topA, topB] = Object.entries(answer.probabilities).sort(
            (a, b) => b[1] - a[1],
          );
          const ia = topA ? rank(topA[0]) : -1;
          const ib = topB ? rank(topB[0]) : -1;
          if (
            ia >= 0 &&
            ib >= 0 &&
            ia < levels.length &&
            ib < levels.length &&
            Math.abs(ia - ib) > 1
          )
            reason = `split between non-adjacent levels ${ia} and ${ib}`;
        }
      }
      result.push({
        label: level ? `${r.label} ${JSON.stringify(level)}` : r.label,
        source: answer.source,
        ...(answer.type === "bool" ? { publicResult: answer.p >= 0.5 } : {}),
        answer,
        rawValues:
          answer.type === "bool"
            ? [
                {
                  label: "bool",
                  value: answer.p >= 0.5,
                  probability: { status: "known", value: answer.p },
                },
              ]
            : Object.entries(answer.probabilities).map(([label, value]) => ({
                label,
                value: label,
                probability: { status: "known" as const, value },
              })),
        uncalibrated: r.uncalibrated,
        ...(reason ? { reason } : {}),
      });
      continue;
    }
    const first = firstRoundChoice(r, answers, reversed);
    if (!first) continue;
    const { original, second, p, values } = first;
    let { head, mass, band, reason } = first;
    // Same-subject control only ever demotes a contradicted verdict, and only
    // the second round judges it: the control targets false contradictions
    // drawn from neighbouring-subject evidence (another entity, file,
    // version, run or moment), while false support is guarded by the
    // exact-statement control above — so holds is never re-examined here. A
    // missing or unjudged control demotes too: without it the contradiction
    // is unproven.
    if (r.kind === "verify" && head === "contradicted" && band === "verdict") {
      const same = r.sameSubject ? answers[r.sameSubject] : undefined;
      if (same?.type !== "bool" || same.p < SAME_SUBJECT_MIN) {
        band = "unsure";
        reason =
          same?.type === "bool"
            ? `evidence may concern a different subject (same-subject p ${same.p.toFixed(2)} below ${SAME_SUBJECT_MIN}); no verdict: ${r.missing}`
            : `same-subject control unjudged${same?.type === "unjudged" ? `: ${same.reason}` : ""}; no verdict: ${r.missing}`;
      }
    }
    if (
      Object.values(r.controls ?? {}).some((id) => answers[id]?.type !== "bool")
    ) {
      result.push({
        label: r.label,
        unjudged: true,
        reason: "required coherence control has no valid bool response",
        missing: r.missing,
      });
      continue;
    }
    if (!r.twin && Object.hasOwn(reversed, r.id) && !second) {
      result.push({
        label: r.label,
        unjudged: true,
        reason: "required reverse-order control unjudged",
        missing: r.missing,
      });
      continue;
    }
    const firstMerged = merged(original, r.kind === "verify");
    const secondMerged = second
      ? merged(second, r.kind === "verify")
      : undefined;
    const compared = top(values);
    result.push({
      label: r.options?.[head]
        ? `${r.label} ${JSON.stringify(r.options[head])}`
        : r.label,
      answer: { ...answer, probabilities: p, choice: head },
      source: answer.source,
      rawValues: Object.entries(original).map(([label, value]) => ({
        label,
        value: label,
        probability: { status: "known" as const, value },
      })),
      reportControls: [
        ...members.slice(1).map(([id, label]) => ({
          id,
          label,
          answer: answers[id],
          kind: "cross_check" as const,
        })),
        ...(!r.twin && reversed[r.id]
          ? [
              {
                id: `${r.id}:reverse`,
                label: "reverse order",
                answer: reversed[r.id],
                kind: "order" as const,
              },
            ]
          : []),
      ].flatMap(({ id, label, answer: a, kind }) => {
        if (!a || a.type === "unjudged" || !a.source) return [];
        return [
          {
            id,
            kind,
            source: a.source,
            outcome: label,
            rawValues:
              a.type === "bool"
                ? [
                    {
                      label,
                      value: a.p >= 0.5,
                      probability: { status: "known" as const, value: a.p },
                    },
                  ]
                : Object.entries(a.probabilities).map(([key, value]) => ({
                    label: key,
                    value: key,
                    probability: { status: "known" as const, value },
                  })),
          },
        ];
      }),
      value: { head, p: mass },
      band,
      reason,
      missing: r.missing,
      uncalibrated: r.uncalibrated,
      orderDependent:
        !!secondMerged &&
        Math.abs((firstMerged[compared] ?? 0) - (secondMerged[compared] ?? 0)) >
          ORDER_DISAGREE_MIN,
    });
  }
  return result;
}
