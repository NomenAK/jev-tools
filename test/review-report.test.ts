import assert from "node:assert/strict";
import test from "node:test";
import { validateResultReport } from "../src/core/result-report.ts";
import { ReviewReport } from "../src/tools/review-report.ts";

const evidence = {
  authority: { path: "/repo", origin: "host" as const },
  effectiveRoot: { path: "/repo-wt", origin: "override" as const },
  requestedBase: "HEAD",
  resolvedBase: "abc123",
};
const metrics = {
  calls: 1,
  questions: 2,
  cacheHits: 1,
  cacheRequests: 2,
  elapsedMs: 4,
};

test("negative review results remain requested results with mixed source accounting", () => {
  const producer = new ReviewReport();
  producer.expect("a", "Unit A correctness", "unit");
  producer.expect("b", "Section B", "section");
  producer.answer("a", { type: "bool", source: "fresh", p: 0.01 });
  producer.answer("b", {
    type: "choice",
    source: "cache",
    choice: "still_true",
    confidence: 0.99,
    probabilities: { still_true: 0.99, now_false: 0.01 },
  });
  const report = producer.build("jev_check_diff", evidence, metrics);
  assert.equal(report.execution, "complete");
  assert.equal(report.items.length, 2);
  assert.deepEqual(report.accounting.requestedResults, {
    total: { status: "known", value: 2 },
    fresh: 1,
    cache: 1,
    notJudged: 0,
    static: 0,
  });
  assert.equal(report.accounting.costUsd.status, "unknown");
  assert.deepEqual(validateResultReport(report), []);
});

test("missing required control invalidates primary answer without inventing a band", () => {
  const producer = new ReviewReport();
  producer.expect("section", "Documentation section", "section");
  producer.answer(
    "section",
    {
      type: "choice",
      source: "fresh",
      choice: "now_false",
      confidence: 1,
      probabilities: { now_false: 1 },
    },
    {},
    [{ type: "unjudged", reason: "call cap", cause: "call_budget" }],
  );
  const report = producer.build("jev_check_diff", evidence, metrics);
  assert.equal(report.execution, "not_judged");
  assert.ok(report.items[0]);
  assert.equal(report.items[0].treatment, "not_judged");
  assert.equal("judgment" in report.items[0], false);
  assert.equal(report.diagnostics[0]?.cause, "control_failure");
  assert.equal(report.accounting.auxiliary.controls.notJudged, 1);
  assert.equal(report.accounting.httpAttempts, 1);
  assert.deepEqual(validateResultReport(report), []);
});

test("static selection and unjudged fallback occupy distinct accounting partitions", () => {
  const producer = new ReviewReport();
  producer.expect("touched", "Touched scenario", "scenario");
  producer.static("touched", "touched", true);
  producer.expect("fallback", "Unjudged scenario", "scenario");
  producer.diagnose(
    "not_configured",
    "No configured Jev endpoint",
    "Unjudged scenario",
    ["fallback"],
  );
  const fallback = producer.items.get("fallback");
  assert.ok(fallback);
  fallback.selection = {
    selected: true,
    reason: "conservative_fallback",
  };
  const report = producer.build("jev_select_tests", evidence, {
    ...metrics,
    calls: 0,
    questions: 0,
  });
  assert.equal(report.execution, "partial");
  assert.equal(report.accounting.requestedResults.static, 1);
  assert.equal(report.accounting.requestedResults.notJudged, 1);
  assert.equal(report.items[1]?.source, "none");
  assert.deepEqual(validateResultReport(report), []);
});

test("empty diff is no judgment while invalid root is refused without a fabricated inventory", () => {
  const empty = new ReviewReport();
  empty.diagnose(
    "no_changed_units",
    "No changed units against HEAD",
    "HEAD",
    [],
    false,
  );
  assert.equal(
    empty.build("jev_check_diff", evidence, metrics).execution,
    "not_judged",
  );
  const invalid = new ReviewReport();
  invalid.refusal = true;
  invalid.diagnose(
    "invalid_root",
    "Root is outside registered worktrees",
    "/other",
  );
  const report = invalid.build(
    "jev_check_diff",
    { authority: evidence.authority, requestedRoot: "/other" },
    { ...metrics, calls: 0, questions: 0 },
  );
  assert.equal(report.execution, "refused");
  assert.equal(report.context.effectiveRoot.status, "unknown");
  assert.deepEqual(report.context.inventories, []);
  assert.deepEqual(validateResultReport(report), []);
});

test("unmatched selection criterion preserves useful selected candidates but exposes partial scope", () => {
  const producer = new ReviewReport();
  producer.expect("test", "Matched touched scenario", "scenario");
  producer.static("test", "touched", true);
  producer.diagnose(
    "criteria_no_match",
    "legacy/** matches no discovered tests",
    "legacy/**",
  );
  const report = producer.build("jev_select_tests", evidence, metrics);
  assert.equal(report.execution, "partial");
  assert.equal(report.items[0]?.selection?.selected, true);
  assert.equal(report.diagnostics[0]?.cause, "criteria_no_match");
  assert.deepEqual(validateResultReport(report), []);
});

test("bool results keep primitive values and exact raw controls with source provenance", () => {
  const producer = new ReviewReport();
  producer.expect("coverage", "Scenario executes changed unit", "scenario");
  producer.answer(
    "coverage",
    { type: "bool", source: "cache", p: 0.1 },
    { band: "unsure" },
    [{ type: "bool", source: "fresh", p: 0.9 }],
  );
  const report = producer.build("jev_select_tests", evidence, metrics);
  const item = report.items[0];
  assert.ok(item && item.treatment === "judged");
  assert.equal(typeof item.judgment.result, "boolean");
  assert.equal(item.source, "cache");
  assert.equal(item.judgment.band, "unsure");
  assert.deepEqual(item.judgment.rawValues[0]?.probability, {
    status: "known",
    value: 0.1,
  });
  assert.equal(item.judgment.controls[0]?.source, "fresh");
  assert.deepEqual(item.judgment.controls[0]?.rawValues[0]?.probability, {
    status: "known",
    value: 0.9,
  });
  assert.deepEqual(validateResultReport(report), []);
});

test("failure preserves the actual transport cause without a fabricated answer", () => {
  const producer = new ReviewReport();
  producer.expect("requirement", "Requirement", "requirement");
  producer.failure(
    { ok: false, error: "request failed", cause: "transport_failure" },
    ["requirement"],
  );
  const report = producer.build("jev_check_diff", evidence, metrics);
  assert.equal(report.execution, "not_judged");
  assert.equal(report.diagnostics[0]?.cause, "transport_failure");
  assert.equal(report.items[0]?.source, "none");
  assert.deepEqual(validateResultReport(report), []);
});
