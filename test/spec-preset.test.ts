import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceUnit } from "../src/core/units.ts";
import { prepareSpecCheck, readSpecJudgment } from "../src/presets/spec.ts";

const units: EvidenceUnit[] = [
  {
    id: "u001",
    kind: "function",
    file: "a.ts",
    name: "refund",
    exported: true,
    before: null,
    after: "export function refund() { return 1 }",
    beforeRange: null,
    afterRange: { start: 1, end: 1 },
  },
];
test("spec preserves requirement text, ignores fenced fake requirements and reports the drift pointer", () => {
  const text =
    "# Specification\n### REQ-001 Expiration\nReject expired tokens.\n```md\n### REQ-FAKE\n```\n### REQ-002 Flags\nName unknown flags in errors.";
  const prepared = prepareSpecCheck(text, units);
  assert.equal(prepared.requirements.length, 2);
  assert.ok(
    prepared.questions.req1?.instructions.includes("Reject expired tokens."),
  );
  assert.ok(
    String(prepared.state.specification).includes(
      '<specification_context verbatim="true">',
    ),
  );
  const findings = readSpecJudgment(prepared, {
    req1: {
      type: "choice",
      choice: "violates",
      confidence: 1,
      probabilities: { violates: 0.7, conforms: 0.3, not_touched: 0 },
    },
    req2: {
      type: "choice",
      choice: "conforms",
      confidence: 1,
      probabilities: { violates: 0.2, conforms: 0.8, not_touched: 0 },
    },
    drift: {
      type: "choice",
      choice: "u001",
      confidence: 1,
      probabilities: { u001: 0.99, none: 0.01 },
    },
  });
  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ["requirement", "drift"],
  );
  assert.equal(findings[0]?.probability, 0.7);
  assert.equal(findings[1]?.unit?.name, "refund");
});
test("tables are a named specification limit and a neutral drift does not become a finding", () => {
  const prepared = prepareSpecCheck(
    "### REQ-001\n| Name | Value |\n| --- | --- |\n| a | b |",
    units,
  );
  assert.ok(prepared.tableWarning);
  assert.deepEqual(
    readSpecJudgment(prepared, {
      req1: {
        type: "choice",
        choice: "not_touched",
        confidence: 1,
        probabilities: { not_touched: 1, conforms: 0, violates: 0 },
      },
      drift: {
        type: "choice",
        choice: "none",
        confidence: 1,
        probabilities: { none: 1, u001: 0 },
      },
    }),
    [],
  );
});
test("requirements retain subsections but exclude the next peer or ancestor", () => {
  const prepared = prepareSpecCheck(
    "### REQ-001 Auth\nReject expiry.\n#### Details\nUse UTC.\n## Appendix\nUnrelated context.\n  ### REQ-002 Flags\nReject unknown flags.",
    units,
  );
  assert.deepEqual(
    prepared.requirements.map(({ label, text, start, end }) => ({
      label,
      text,
      start,
      end,
    })),
    [
      {
        label: "REQ-001 Auth",
        text: "### REQ-001 Auth\nReject expiry.\n#### Details\nUse UTC.",
        start: 1,
        end: 4,
      },
      {
        label: "REQ-002 Flags",
        text: "  ### REQ-002 Flags\nReject unknown flags.",
        start: 7,
        end: 8,
      },
    ],
  );
});
