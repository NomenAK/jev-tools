import { WITNESS_AUTO_MIN_CELLS } from "../constants.ts";
import type { Limitation } from "../core/output.ts";
import type { EvidenceUnit } from "../core/units.ts";
import type { Json, Judgment, Question, State } from "../jev/types.ts";
import { isRecord, type Result } from "../result.ts";
import {
  buildWitnessUnits,
  evaluateBatchWitnessHealth,
  type WitnessHealth,
} from "./witnesses.ts";

export type BuiltinRiskDimension =
  | "security"
  | "compatibility"
  | "correctness"
  | "reliability";
export type RiskDimension =
  | { name: BuiltinRiskDimension; statement: string; uncalibrated: false }
  | { name: string; statement: string; uncalibrated: true };
export type RiskCell = { id: string; unitId: string } & (
  | { dimension: BuiltinRiskDimension; uncalibrated: false }
  | { dimension: string; uncalibrated: true }
);
export interface RiskWitness {
  id: string;
  unitId: string;
  dimension: BuiltinRiskDimension;
  expected: "yes" | "no";
  label: string;
  limit: number;
}
export interface RiskMatrix {
  state: State;
  questions: Record<string, Question>;
  cells: RiskCell[];
  witnesses: RiskWitness[];
  witnessQuestionIds: string[];
  groups: string[][];
  dimensions: RiskDimension[];
  warnings: Limitation[];
}
const builtins: Record<BuiltinRiskDimension, string> = {
  security:
    "introduce a security vulnerability, such as bypassing authentication or authorization, exposing secrets, or accepting unsafe input",
  compatibility:
    "break an existing externally visible interface, accepted input, output format, name, or default behavior",
  correctness:
    "make an existing computation or behavior produce an incorrect result",
  reliability:
    "introduce a concrete failure, exception, rejected operation, or loss of availability on a supported path",
};
export function isBuiltinRiskDimension(
  name: string,
): name is BuiltinRiskDimension {
  return Object.hasOwn(builtins, name);
}

export function normalizeProjectDimensions(
  dimensions?: unknown,
  only?: unknown,
): Result<{ dimensions: RiskDimension[]; warnings: Limitation[] }> {
  const result: RiskDimension[] = Object.keys(builtins)
    .filter(isBuiltinRiskDimension)
    .map((name) => ({ name, statement: builtins[name], uncalibrated: false }));
  const warnings: Limitation[] = [];
  if (dimensions !== undefined) {
    if (!isRecord(dimensions))
      return {
        ok: false,
        error: "dimensions must be a record of names and positive statements.",
      };
    for (const [name, statement] of Object.entries(dimensions)) {
      if (Object.hasOwn(builtins, name))
        return {
          ok: false,
          error: `dimensions cannot override reserved built-in dimension ${name}.`,
        };
      if (
        !name.trim() ||
        typeof statement !== "string" ||
        !statement.trim() ||
        statement.trim().endsWith("?")
      )
        return {
          ok: false,
          error: `dimension ${name} needs a non-empty statement, not a question.`,
        };
      result.push({ name, statement, uncalibrated: true });
      // Same advisory lexical check as the claim compiler, never a semantic refusal.
      if (/\b(not|never|no longer|without)\b|;|\band\b/i.test(statement))
        warnings.push({
          fact: `${name} is negated or compound (sent as written)`,
          next: "use one positive fact when possible",
        });
    }
  }
  if (only !== undefined) {
    if (
      !Array.isArray(only) ||
      !only.length ||
      only.some((name) => typeof name !== "string")
    )
      return {
        ok: false,
        error: "only must be a non-empty list of dimension names.",
      };
    const selected = new Set<string>();
    for (const name of only as string[]) {
      if (selected.has(name))
        return {
          ok: false,
          error: `only contains duplicate dimension ${name}.`,
        };
      if (!result.some((dimension) => dimension.name === name))
        return { ok: false, error: `unknown risk dimension ${name}.` };
      selected.add(name);
    }
    return {
      ok: true,
      dimensions: result.filter((dimension) => selected.has(dimension.name)),
      warnings,
    };
  }
  return { ok: true, dimensions: result, warnings };
}

export function prepareRiskMatrix(
  units: readonly EvidenceUnit[],
  options: {
    witnesses?: "off" | "auto" | "on";
    dimensions?: Record<string, string>;
    only?: string[];
    testFilesPresent?: boolean;
  } = {},
): Result<RiskMatrix> {
  const normalized = normalizeProjectDimensions(
    options.dimensions,
    options.only,
  );
  if (!normalized.ok) return normalized;
  const builtinDimensions = normalized.dimensions.filter(
    (dimension): dimension is Extract<RiskDimension, { uncalibrated: false }> =>
      !dimension.uncalibrated,
  );
  const enabled =
    builtinDimensions.length > 0 &&
    units.length > 0 &&
    options.witnesses !== "off" &&
    (options.witnesses === "on" ||
      units.length * builtinDimensions.length >= WITNESS_AUTO_MIN_CELLS);
  const changedUnits = units.map((unit) => ({ ...unit }));
  const questions: Record<string, Question> = {};
  const cells: RiskCell[] = [];
  const witnesses: RiskWitness[] = [];
  const groups: string[][] = [];
  for (const unit of units) {
    const group: string[] = [];
    for (const dimension of normalized.dimensions) {
      const id = `${unit.id}:${dimension.name}`;
      questions[id] = riskQuestion(unit, dimension);
      cells.push(
        dimension.uncalibrated
          ? {
              id,
              unitId: unit.id,
              dimension: dimension.name,
              uncalibrated: true,
            }
          : {
              id,
              unitId: unit.id,
              dimension: dimension.name,
              uncalibrated: false,
            },
      );
      group.push(id);
    }
    groups.push(group);
  }
  if (enabled) {
    for (const witness of buildWitnessUnits(units, options)) {
      const unit = witness.unit;
      changedUnits.push(unit);
      for (const dimension of builtinDimensions) {
        const id = `${unit.id}:${dimension.name}`;
        questions[id] = riskQuestion(unit, dimension);
        if (!witness.reference || witness.reference === dimension.name)
          witnesses.push({
            id,
            unitId: unit.id,
            dimension: dimension.name,
            expected: witness.reference ? "yes" : "no",
            label: witness.label,
            limit: witness.limit,
          });
      }
    }
  }
  // All witness questions must repeat together, even non-health reference dimensions.
  const realIds = new Set(cells.map((cell) => cell.id));
  const witnessQuestionIds = Object.keys(questions).filter(
    (id) => !realIds.has(id),
  );
  return {
    ok: true,
    state: { changedUnits: changedUnits.map((unit) => ({ ...unit })) },
    questions,
    cells,
    witnesses,
    witnessQuestionIds,
    groups,
    dimensions: normalized.dimensions,
    warnings: normalized.warnings,
  };
}
function riskQuestion(unit: EvidenceUnit, dimension: RiskDimension): Question {
  return {
    type: "bool",
    instructions: `Look only at changed unit ${unit.id} (${unit.file}, ${unit.name}); compare its before and after versions. Does this change ${dimension.statement}?`,
    criteria: {
      true: "The before/after evidence shows the stated risky change in this unit.",
      false: dimension.uncalibrated
        ? "The stated project condition is not shown by this change."
        : "The stated risky change is not shown. A new function alone, an unchanged result, an equivalent refactor, or a test following a coordinated rename does not count.",
    },
  };
}

export interface SeverityCell {
  unit: EvidenceUnit;
  dimension: BuiltinRiskDimension;
  callerEvidence?: Json;
}

/**
 * One severity request per unit: every dimension of that unit shares its state,
 * so `prepareBatches` packs their score questions into a single request. The
 * state carries only the unit and its caller evidence; the dimension each score
 * question concerns is stated in that question, because Jev never sees question
 * ids and a single state field cannot name several dimensions at once.
 */
export function prepareSeverityBatch(cells: readonly SeverityCell[]): {
  state: State;
  questions: Record<string, Question>;
  ids: string[];
} {
  const [first, ...rest] = cells;
  if (!first) return { state: {}, questions: {}, ids: [] };
  const state: State = { changedUnits: [{ ...first.unit }] };
  if (first.callerEvidence !== undefined)
    state.callerEvidence = first.callerEvidence;
  const questions: Record<string, Question> = {};
  const ids: string[] = [];
  for (const cell of [first, ...rest]) {
    const id = `${cell.unit.id}_${cell.dimension}`;
    ids.push(id);
    questions[id] = {
      type: "score",
      instructions: `Assuming changed unit ${cell.unit.id} (${cell.unit.file}, ${cell.unit.name}) exhibits the suspected concern in the "${cell.dimension}" dimension, rate the likely production impact of that concern only. Preserve the complete before/after caller and provider evidence when present.`,
      criteria: [
        "No meaningful impact or no supported issue",
        "Minor or narrowly limited impact",
        "Significant correctness, reliability, compatibility, or security impact",
        "Critical security, data-loss, or widespread outage impact",
      ],
    };
  }
  return { state, questions, ids };
}

export function evaluateWitnessHealth(
  matrix: RiskMatrix,
  judgment: Judgment,
): WitnessHealth {
  return evaluateBatchWitnessHealth(
    matrix.cells.map((cell) => cell.id),
    matrix.witnesses,
    judgment,
  );
}
