import { posix } from "node:path";
import type { Question, State } from "../jev/types.ts";
import type { EvidenceUnit } from "./units.ts";

export interface CoverageWitnessUnit {
  unit: EvidenceUnit;
  label: string;
  reference?: "security" | "compatibility" | "correctness";
  limit: number;
  evidenceOnly?: boolean;
}
export interface CoverageWitnessExpectation {
  id: string;
  expected: "yes" | "no";
  label: string;
  limit: number;
}

/** Keep synthetic execution evidence in every real residual batch. */
export function prepareCoverageWitnesses(
  state: State,
  questions: Record<string, Question>,
  witnesses: readonly CoverageWitnessUnit[],
): {
  state: State;
  questions: Record<string, Question>;
  witnesses: readonly CoverageWitnessExpectation[];
} {
  const file = state.testFile;
  const testFile =
    file && typeof file === "object" && !Array.isArray(file)
      ? file
      : { path: "test/preset-check.test.ts", text: "" };
  const path =
    typeof testFile.path === "string"
      ? testFile.path
      : "test/preset-check.test.ts";
  const bodies: string[] = [];
  const imports: string[] = [];
  const scenarios = ["direct call", "renamed call", "indirect read"];
  let referenceIndex = 0;
  const expectations: CoverageWitnessExpectation[] = [];
  const witnessQuestions: Record<string, Question> = {};
  for (const witness of witnesses) {
    const { unit } = witness;
    if (witness.evidenceOnly) continue;
    const scenario = witness.reference
      ? (scenarios[referenceIndex++] ?? "direct call")
      : "direct call";
    if (witness.reference) {
      const callable =
        unit.name === "LIMIT"
          ? "withinLimit"
          : unit.after?.match(/export\s+function\s+([\w$]+)/)?.[1];
      if (callable) {
        const imported = posix.relative(posix.dirname(path), unit.file);
        imports.push(
          `import {${callable}} from '${imported.startsWith(".") ? imported : `./${imported}`}';`,
        );
        bodies.push(`test('${scenario}', () => ${callable}(2));`);
      }
    }
    const id = `coverage_${unit.id}`;
    expectations.push({
      id,
      expected: witness.reference ? "yes" : "no",
      label: witness.label,
      limit: witness.limit,
    });
    witnessQuestions[id] = {
      type: "bool",
      instructions: `When test ${scenario} runs, does the after version of unit ${unit.id} (${unit.after?.match(/export\s+function\s+([\w$]+)/)?.[1] ?? unit.name}) execute or get read, directly or through functions it calls?`,
    };
  }
  return {
    state: {
      ...state,
      ...(witnesses.length
        ? {
            testFile: {
              ...testFile,
              text: `${testFile.text ?? ""}\n${imports.join("\n")}\n${bodies.join("\n")}`,
            },
          }
        : {}),
      changedUnits: [
        ...(Array.isArray(state.changedUnits) ? state.changedUnits : []),
        ...witnesses.map(({ unit }) => ({
          id: unit.id,
          kind: unit.kind,
          file: unit.file,
          name: unit.name,
          exported: unit.exported,
          before: unit.before,
          after: unit.after,
          usedBy: [],
        })),
      ],
    },
    questions: { ...questions, ...witnessQuestions },
    witnesses: expectations,
  };
}
