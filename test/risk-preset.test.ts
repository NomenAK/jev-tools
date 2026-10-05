import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceUnit } from "../src/core/units.ts";
import type { Answer } from "../src/jev/types.ts";
import {
  evaluateWitnessHealth,
  normalizeProjectDimensions,
  prepareRiskMatrix,
  prepareSeverityBatch,
} from "../src/presets/risk.ts";

const unit = (id: string): EvidenceUnit => ({
  id,
  kind: "function",
  file: "src/a.ts",
  name: "read",
  exported: true,
  before: "function read() { return 1; }",
  after: "function read() { return 2; }",
  beforeRange: { start: 1, end: 1 },
  afterRange: { start: 1, end: 1 },
});

test("a failed repeated witness lowers only findings from its own matrix batch", () => {
  const matrix = prepareRiskMatrix([unit("u001"), unit("u002")], {
    witnesses: "on",
  });
  assert.equal(matrix.ok, true);
  if (!matrix.ok) return;
  const healthy: Record<string, Answer> = {};
  for (const witness of matrix.witnesses)
    healthy[witness.id] = {
      type: "bool",
      p: witness.expected === "no" ? 0.15 : 0.7,
    };
  const lure = matrix.witnesses.find((w) => w.expected === "no");
  assert.ok(lure);
  const firstCell = matrix.cells[0];
  const secondCell = matrix.cells[4];
  assert.ok(firstCell);
  assert.ok(secondCell);
  const first = firstCell.id;
  const second = secondCell.id;
  const health = evaluateWitnessHealth(matrix, {
    ok: true,
    answers: healthy,
    batches: [
      {
        questionIds: [first, ...matrix.witnessQuestionIds],
        answers: { ...healthy, [lure.id]: { type: "bool", p: 0.16 } },
      },
      { questionIds: [second, ...matrix.witnessQuestionIds], answers: healthy },
    ],
  });
  assert.equal(health.healthy, false);
  const reason = health.unhealthyQuestionIds.get(first);
  assert.ok(reason);
  assert.match(reason, /set-up check failed/);
  assert.equal(health.unhealthyQuestionIds.has(second), false);
  assert.equal(health.controls.length, 1);
});

test("project-only questions cannot enable builtin witnesses and unknown restrictions refuse", () => {
  const matrix = prepareRiskMatrix([unit("u001"), unit("u002")], {
    witnesses: "on",
    dimensions: { local_time: "read the local time zone" },
    only: ["local_time"],
  });
  assert.equal(matrix.ok, true);
  if (!matrix.ok) return;
  assert.deepEqual(matrix.witnessQuestionIds, []);
  assert.deepEqual(
    matrix.cells.map((cell) => cell.uncalibrated),
    [true, true],
  );
  assert.equal(normalizeProjectDimensions({}, ["unknown"]).ok, false);
  assert.equal(
    normalizeProjectDimensions({}, ["security", "security"]).ok,
    false,
  );
  assert.equal(
    normalizeProjectDimensions({ security: "a custom rule" }).ok,
    false,
  );
  const warned = normalizeProjectDimensions({
    custom: "never remove a field; preserve its name",
  });
  assert.equal(warned.ok, true);
  if (warned.ok)
    assert.equal(
      warned.warnings[0]?.fact,
      "custom is negated or compound (sent as written)",
    );
});

test("auto counts builtin cells only and class witnesses keep anonymous unit IDs", () => {
  const below = prepareRiskMatrix([unit("u001")], {
    dimensions: {
      one: "change dates",
      two: "change money",
      three: "change labels",
      four: "change colors",
    },
  });
  assert.equal(below.ok, true);
  if (below.ok) assert.deepEqual(below.witnessQuestionIds, []);
  const matrix = prepareRiskMatrix(
    [unit("u001"), { ...unit("u002"), kind: "declaration" }],
    { testFilesPresent: true },
  );
  assert.equal(matrix.ok, true);
  if (!matrix.ok) return;
  assert.equal(
    new Set(
      matrix.witnesses.filter((w) => w.expected === "no").map((w) => w.unitId),
    ).size,
    4,
  );
  assert.equal(matrix.witnesses.filter((w) => w.expected === "yes").length, 3);
  const changedUnits = matrix.state.changedUnits as { id: string }[];
  assert.equal(
    new Set(changedUnits.map((u) => u.id)).size,
    changedUnits.length,
  );
  assert.deepEqual(Object.keys(matrix.state), ["changedUnits"]);
});

test("severity preserves local proof and missing witnesses visibly fail the affected batch", () => {
  const proof = {
    source: "static code only; not executed",
    provider: { before: "old", after: "new" },
  };
  const severity = prepareSeverityBatch([
    { unit: unit("u001"), dimension: "reliability", callerEvidence: proof },
  ]);
  assert.deepEqual(severity.state.callerEvidence, proof);
  assert.deepEqual(severity.ids, ["u001_reliability"]);
  // The dimension reaches the model through the question, never through a
  // state field: a single field cannot name several dimensions at once, and
  // Jev does not see question ids.
  assert.equal(severity.state.dimension, undefined);
  assert.equal(severity.state.dimensions, undefined);
  assert.match(
    severity.questions.u001_reliability?.instructions ?? "",
    /"reliability" dimension/,
  );
  const matrix = prepareRiskMatrix([unit("u001")], {
    witnesses: "on",
    only: ["reliability"],
  });
  assert.equal(matrix.ok, true);
  if (!matrix.ok) return;
  assert.equal(
    matrix.witnesses.some((w) => w.expected === "yes"),
    false,
  );
  const health = evaluateWitnessHealth(matrix, {
    ok: true,
    answers: {},
    batches: [{ questionIds: ["u001:reliability"], answers: {} }],
  });
  const reason = health.unhealthyQuestionIds.get("u001:reliability");
  assert.ok(reason);
  assert.match(reason, /unjudged/);
});

test("severity state is identical whether one or many dimensions ride the request", () => {
  const single = prepareSeverityBatch([
    { unit: unit("u001"), dimension: "security" },
  ]);
  const many = prepareSeverityBatch([
    { unit: unit("u001"), dimension: "security" },
    { unit: unit("u001"), dimension: "reliability" },
  ]);
  // Batching changes only how many questions ride the request, never the
  // evidence the model is shown.
  assert.deepEqual(many.state, single.state);
  assert.deepEqual(many.ids, ["u001_security", "u001_reliability"]);
  for (const id of many.ids) {
    const question = many.questions[id];
    assert.equal(question?.type, "score");
    assert.match(question?.instructions ?? "", /changed unit u001/);
  }
  assert.match(
    many.questions.u001_security?.instructions ?? "",
    /"security" dimension/,
  );
  assert.match(
    many.questions.u001_reliability?.instructions ?? "",
    /"reliability" dimension/,
  );
  assert.equal(prepareSeverityBatch([]).ids.length, 0);
});

test("a failed reference lowers project findings in that batch without project witness questions", () => {
  const matrix = prepareRiskMatrix([unit("u001")], {
    witnesses: "on",
    dimensions: { custom: "change a date format" },
  });
  assert.equal(matrix.ok, true);
  if (!matrix.ok) return;
  const answers: Record<string, Answer> = {};
  for (const witness of matrix.witnesses)
    answers[witness.id] = {
      type: "bool",
      p: witness.expected === "yes" ? 0.7 : 0.15,
    };
  const reference = matrix.witnesses.find((w) => w.expected === "yes");
  assert.ok(reference);
  answers[reference.id] = { type: "bool", p: 0.69 };
  assert.equal(
    matrix.witnessQuestionIds.some((id) => id.endsWith(":custom")),
    false,
  );
  const health = evaluateWitnessHealth(matrix, {
    ok: true,
    answers,
    batches: [{ questionIds: ["u001:custom"], answers }],
  });
  const reason = health.unhealthyQuestionIds.get("u001:custom");
  assert.ok(reason);
  assert.match(reason, /reference/);
});

test("transport failures report unavailable witnesses and unrelated batches do not taint findings", () => {
  const matrix = prepareRiskMatrix([unit("u001")], { witnesses: "on" });
  assert.ok(matrix.ok);
  const failed = evaluateWitnessHealth(matrix, {
    ok: false,
    error: "Jev timeout",
  });
  const reason = failed.unhealthyQuestionIds.get("u001:security");
  assert.ok(reason);
  assert.match(reason, /witness control unavailable: Jev timeout/);
  assert.doesNotMatch(reason, /set-up check failed/);
  assert.equal(
    failed.controls[0]?.next,
    "check Jev availability or raise max_calls",
  );
  const healthy: Record<string, Answer> = {};
  for (const witness of matrix.witnesses)
    healthy[witness.id] = {
      type: "bool",
      p: witness.expected === "yes" ? 0.9 : 0.05,
    };
  const result = evaluateWitnessHealth(matrix, {
    ok: true,
    answers: healthy,
    batches: [
      { questionIds: ["unrelated"], answers: {} },
      { questionIds: ["u001:security"], answers: healthy },
    ],
  });
  assert.equal(result.healthy, true);
  assert.deepEqual(result.controls, []);
});
