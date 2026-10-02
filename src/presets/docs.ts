import { DOCS_CHECK_MIN, FLAG_MIN } from "../constants.ts";
import type { DocSentence, DocsCandidate } from "../core/docs.ts";
import type { Band } from "../core/output.ts";
import type { EvidenceUnit } from "../core/units.ts";
import type { Answer, Question, State } from "../jev/types.ts";

export interface DocsFinding {
  section: Omit<DocsCandidate, "units" | "sentences">;
  sentence?: DocSentence;
  units: readonly EvidenceUnit[];
  probability: number;
  band: Band;
  reason?: string;
}
export function prepareDocsCheck(candidate: DocsCandidate): {
  state: State;
  questions: Record<string, Question>;
} {
  return {
    state: {
      doc: {
        path: candidate.path,
        heading: candidate.heading,
        sentences: candidate.sentences.map(({ id, text }) => ({ id, text })),
      },
      changedUnits: candidate.units.map((unit) => ({ ...unit })),
    },
    questions: {
      status: {
        type: "choice",
        instructions:
          "Compare the before and after changed units to the documentation section. What is the effect of these changes on the existing documentation? Judge only statements in this section, not missing new documentation.",
        criteria: {
          unrelated:
            "The changed code does not affect what this section describes.",
          still_true:
            "The changes affect the documented code but the section remains true.",
          now_false:
            "At least one existing sentence becomes false or misleading because of the code changes.",
        },
      },
      sentence: {
        type: "choice",
        instructions:
          "Which sentence in this documentation section is made false or misleading by the before-to-after code changes? Choose none if no sentence is made false.",
        criteria: Object.fromEntries([
          ...candidate.sentences.map((sentence) => [
            sentence.id,
            sentence.text,
          ]),
          ["none", "No existing sentence is made false by the changes."],
        ]),
      },
    },
  };
}
export function readDocsJudgment(
  candidate: DocsCandidate,
  answers: Readonly<Record<string, Answer>>,
): DocsFinding | undefined {
  const status = answers.status;
  if (status?.type !== "choice") return undefined;
  const probability = status.probabilities.now_false ?? 0;
  if (probability < DOCS_CHECK_MIN) return undefined;
  const pointer = answers.sentence;
  const sentence =
    pointer?.type === "choice"
      ? candidate.sentences.find((item) => item.id === pointer.choice)
      : undefined;
  return {
    section: {
      path: candidate.path,
      heading: candidate.heading,
      start: candidate.start,
      end: candidate.end,
    },
    sentence,
    units: candidate.units,
    probability,
    band: probability >= FLAG_MIN && sentence ? "verdict" : "unsure",
    ...(!sentence
      ? { reason: "selected sentence absent: read the section" }
      : {}),
  };
}
