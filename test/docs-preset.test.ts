import assert from "node:assert/strict";
import test from "node:test";
import type { Answer } from "../src/jev/types.ts";
import { readDocsJudgment } from "../src/presets/docs.ts";

const candidate = {
  path: "docs/api.md",
  heading: "Refunds",
  start: 2,
  end: 4,
  sentences: [{ id: "s1", text: "Refunds remain available for thirty days." }],
  units: [
    {
      id: "u001",
      kind: "declaration" as const,
      file: "src/limits.ts",
      name: "WINDOW",
      exported: true,
      before: "const WINDOW = 30",
      after: "const WINDOW = 14",
      beforeRange: null,
      afterRange: null,
    },
  ],
};
function choice(
  probabilities: Record<string, number>,
  selected: string,
): Answer {
  return { type: "choice", choice: selected, confidence: 0.99, probabilities };
}
test("docs thresholds retain the designated sentence without promoting the review band", () => {
  for (const [p, band] of [
    [0.199, undefined],
    [0.2, "unsure"],
    [0.699, "unsure"],
    [0.7, "verdict"],
  ] as const) {
    const finding = readDocsJudgment(candidate, {
      status: choice(
        { unrelated: 0, still_true: 1 - p, now_false: p },
        p < 0.5 ? "still_true" : "now_false",
      ),
      sentence: choice({ s1: 0.99, none: 0.01 }, "s1"),
    });
    assert.equal(finding?.band, band);
    if (finding) {
      assert.equal(finding.probability, p);
      assert.equal(
        finding.sentence?.text,
        "Refunds remain available for thirty days.",
      );
      assert.equal(finding.section.path, "docs/api.md");
    }
  }
});
test("missing sentence evidence cannot produce a docs verdict", () => {
  const finding = readDocsJudgment(candidate, {
    status: choice({ unrelated: 0, still_true: 0, now_false: 1 }, "now_false"),
    sentence: choice({ none: 1, s1: 0 }, "none"),
  });
  assert.equal(finding?.band, "unsure");
  assert.equal(finding?.sentence, undefined);
});
