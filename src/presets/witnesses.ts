import {
  COVERAGE_WITNESS_LURE_MAX,
  WITNESS_ETALON_MIN,
  WITNESS_LARGE_CHARS,
  WITNESS_LARGE_LURE_MAX,
  WITNESS_LURE_MAX,
} from "../constants.ts";
import { isTestFile } from "../core/diff.ts";
import type { Limitation } from "../core/output.ts";
import type { EvidenceUnit } from "../core/units.ts";
import type { Judgment } from "../jev/types.ts";
export type WitnessReference = "security" | "compatibility" | "correctness";
export interface WitnessUnit {
  unit: EvidenceUnit;
  label: string;
  reference?: WitnessReference;
  limit: number;
  evidenceOnly?: boolean;
}
export interface WitnessExpectation {
  id: string;
  expected: "yes" | "no";
  label: string;
  dimension?: string;
  limit: number;
}
export interface WitnessHealth {
  healthy: boolean;
  failures: Limitation[];
  controls: Limitation[];
  unhealthyQuestionIds: ReadonlyMap<string, string>;
}
export function buildWitnessUnits(
  units: readonly EvidenceUnit[],
  options: { testFilesPresent?: boolean } = {},
): WitnessUnit[] {
  const result: WitnessUnit[] = [];
  const templates: {
    kind: EvidenceUnit["kind"];
    file: string;
    name: string;
    before: string;
    after: string;
    reference?: WitnessReference;
    label: string;
  }[] = [
    {
      kind: "function",
      file: "src/slug.ts",
      name: "slugify",
      before: "function slugify(s) { return s.trim().toLowerCase(); }",
      after:
        "function slugify(s) { const trimmed = s.trim(); return trimmed.toLowerCase(); }",
      label: "neutral refactor",
    },
    {
      kind: "function",
      file: "src/format.ts",
      name: "formatLine",
      before: "function formatLine(s) { return s + '\\n'; }",
      after: "function formatLine(s) { return s + '\\n'; }",
      label: "unchanged function",
    },
  ];
  const classes = new Set(
    units.map((unit) => (isTestFile(unit.file) ? "test" : unit.kind)),
  );
  if (options.testFilesPresent) classes.add("test");
  for (const kind of classes) {
    if (kind === "function") continue;
    if (kind === "test")
      templates.push({
        kind: "file",
        file: "test/cli.test.ts",
        name: "cli test",
        before:
          "test('flag', () => expect(parseArgs(['--legacy'])).toEqual({ mode: true }));",
        after:
          "test('flag', () => expect(parseArgs(['--compat'])).toEqual({ mode: true }));",
        label: "test that follows a rename",
      });
    else if (kind === "file")
      templates.push({
        kind,
        file: "config/settings.json",
        name: "settings",
        before: '{"port":8080,"enabled":true}',
        after: '{"enabled":true,"port":8080}',
        label: "configuration",
      });
    else if (kind === "declaration")
      templates.push({
        kind,
        file: "src/limits.ts",
        name: "MAX_ITEMS",
        before: "export const MAX_ITEMS = 1000;",
        after: "export const MAX_ITEMS = 1_000;",
        label: "declaration",
      });
    else
      templates.push({
        kind,
        file: "src/render.ts",
        name: "render",
        before: "const value = item.name;\nreturn value;",
        after: "const label = item.name;\nreturn label;",
        label: `${kind} neutral rename`,
      });
  }
  templates.push(
    {
      kind: "function",
      file: "src/accounts.ts",
      name: "deleteAccount",
      before:
        "function deleteAccount(user, account) { if (user.role !== 'admin') throw Error('forbidden'); return db.delete(account); }",
      after:
        "function deleteAccount(user, account) { return db.delete(account); }",
      reference: "security",
      label: "authorization removed",
    },
    {
      kind: "function",
      file: "src/money.ts",
      name: "formatPrice",
      before:
        "export function formatPrice(amount) { return amount.toFixed(2); }",
      after:
        "export function formatMoney(amount) { return amount.toFixed(2); }",
      reference: "compatibility",
      label: "export renamed",
    },
    {
      kind: "function",
      file: "src/discount.ts",
      name: "applyDiscount",
      before:
        "function applyDiscount(price, discount) { return price - discount; }",
      after:
        "function applyDiscount(price, discount) { return price + discount; }",
      reference: "correctness",
      label: "discount sign reversed",
    },
  );
  const ids = new Set(units.map((unit) => unit.id));
  let number = 1;
  for (const template of templates) {
    let unitId: string;
    do {
      unitId = `w${String(number++).padStart(3, "0")}`;
    } while (ids.has(unitId));
    ids.add(unitId);
    const unit: EvidenceUnit = {
      id: unitId,
      kind: template.kind,
      file: template.file,
      name: template.name,
      exported: true,
      before: template.before,
      after: template.after,
      beforeRange: { start: 1, end: template.before.split("\n").length },
      afterRange: { start: 1, end: template.after.split("\n").length },
    };
    result.push({
      unit,
      label: template.label,
      ...(template.reference ? { reference: template.reference } : {}),
      limit: template.reference
        ? WITNESS_ETALON_MIN
        : template.before.length + template.after.length >= WITNESS_LARGE_CHARS
          ? WITNESS_LARGE_LURE_MAX
          : WITNESS_LURE_MAX,
    });
  }
  return result;
}

/** Frozen embedded-after coverage template; independent of risk witnesses. */
export function buildCoverageWitnessUnits(
  units: readonly EvidenceUnit[],
): WitnessUnit[] {
  const templates = [
    [
      "normalize",
      "src/normalize.js",
      "export function normalize(s) { return s.trim().toLowerCase(); }",
      "export function normalize(s) { const v = s.trim(); return v.toLowerCase(); }",
    ],
    [
      "formatLine",
      "src/format.js",
      "export function formatLine(s) { return s + '\\n'; }",
      "export function formatLine(s) { return s + '\\n'; }",
    ],
    [
      "MAX_ITEMS",
      "src/count.js",
      "export const MAX_ITEMS = 1000;",
      "export const MAX_ITEMS = 1_000;",
    ],
    [
      "increment",
      "src/increment.js",
      "export function increment(n) { return n - 1; }",
      "export function increment(n) { return n + 1; }",
    ],
    [
      "formatPrice",
      "src/price.js",
      "export function formatPrice(n) { return n.toFixed(2); }",
      "export function formatMoney(n) { return n.toFixed(2); }",
    ],
    [
      "LIMIT",
      "src/limit.js",
      "export const LIMIT = 3;",
      "export const LIMIT = 4;",
    ],
    [
      "withinLimit",
      "src/limit.js",
      "export function withinLimit(n) { return n <= LIMIT; }",
      "export function withinLimit(n) { return n <= LIMIT; }",
    ],
  ] as const;
  const ids = new Set(units.map((unit) => unit.id));
  let number = 1;
  return templates.map(([name, file, before, after], index) => {
    let id: string;
    do {
      id = `w${String(number++).padStart(3, "0")}`;
    } while (ids.has(id));
    ids.add(id);
    const reference = index >= 3 && index < 6;
    return {
      unit: {
        id,
        name,
        file,
        before,
        after,
        kind:
          name === "LIMIT" || name === "MAX_ITEMS" ? "declaration" : "function",
        exported: true,
        beforeRange: null,
        afterRange: null,
      },
      label: name,
      ...(reference ? { reference: "correctness" as const } : {}),
      ...(name === "withinLimit" ? { evidenceOnly: true } : {}),
      limit: reference ? WITNESS_ETALON_MIN : COVERAGE_WITNESS_LURE_MAX,
    };
  });
}
export function evaluateBatchWitnessHealth(
  questionIds: readonly string[],
  witnesses: readonly WitnessExpectation[],
  judgment: Judgment,
): WitnessHealth {
  const failures: Limitation[] = [];
  const unhealthyQuestionIds = new Map<string, string>();
  const realIds = new Set(questionIds);
  const batches = judgment.batches ?? [
    {
      questionIds: [...questionIds],
      answers: judgment.ok ? judgment.answers : {},
    },
  ];
  for (const batch of batches) {
    if (!batch.questionIds.some((id) => realIds.has(id))) continue;
    const unavailable: string[] = [];
    const reasons: string[] = [];
    for (const witness of witnesses) {
      const answer = batch.answers[witness.id];
      const dimension = witness.dimension ? ` ${witness.dimension}` : "";
      if (!judgment.ok) unavailable.push(judgment.error);
      else if (answer?.type !== "bool")
        unavailable.push(
          `${witness.label}${dimension} unjudged${answer?.type === "unjudged" ? `: ${answer.reason}` : ""}`,
        );
      else if (
        witness.expected === "no"
          ? answer.p > witness.limit
          : answer.p < witness.limit
      )
        reasons.push(
          `${witness.expected === "no" ? "decoy" : "reference"} "${witness.label}"${dimension} at ${answer.p.toFixed(2)} (limit ${witness.limit})`,
        );
    }
    if (!reasons.length && !unavailable.length) continue;
    const batchFailures: Limitation[] = [];
    if (reasons.length)
      batchFailures.push({
        fact: `set-up check failed: ${reasons.join("; ")}`,
        next: "rerun with base= a nearer ref and complete before/after units",
      });
    if (unavailable.length)
      batchFailures.push({
        fact: `witness control unavailable: ${[...new Set(unavailable)].join("; ")}`,
        next: "check Jev availability or raise max_calls",
      });
    failures.push(...batchFailures);
    const reason = batchFailures.map((failure) => failure.fact).join("; ");
    for (const id of batch.questionIds)
      if (realIds.has(id)) unhealthyQuestionIds.set(id, reason);
  }
  return {
    healthy: failures.length === 0,
    failures,
    controls: failures,
    unhealthyQuestionIds,
  };
}
