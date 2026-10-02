import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEnvelope } from "../src/core/output.ts";
import { renderEnvelope } from "../src/render.ts";

const yieldData = {
  calls: 1,
  questions: 1,
  costUsd: 0.00006,
  cacheHits: 0,
  cacheRequests: 1,
  elapsedMs: 900,
};
test("bool cuts include both verdict edges", () => {
  for (const [p, band] of [
    [0.2, "verdict"],
    [0.200001, "unsure"],
    [0.799999, "unsure"],
    [0.8, "verdict"],
  ] as const) {
    const model = buildEnvelope({
      answers: [{ label: "claim", answer: { type: "bool", p } }],
      yield: yieldData,
    });
    assert.equal(
      model.lines[0]?.type === "answer" && model.lines[0].band,
      band,
    );
  }
});
test("choice reads maximum probability, never Jev confidence", () => {
  for (const [p, band] of [
    [0.849999, "unsure"],
    [0.85, "verdict"],
  ] as const) {
    const model = buildEnvelope({
      answers: [
        {
          label: "choice",
          answer: {
            type: "choice",
            choice: "yes",
            confidence: 1,
            probabilities: { yes: p, no: 1 - p },
          },
        },
      ],
      yield: yieldData,
    });
    assert.equal(
      model.lines[0]?.type === "answer" && model.lines[0].band,
      band,
    );
  }
});
test("failed control demotes every verdict, preserves abstention and raw values", () => {
  const text = renderEnvelope(
    buildEnvelope({
      answers: [
        { label: "a", answer: { type: "bool", p: 0.98 } },
        { label: "b", answer: { type: "bool", p: 0.02 } },
        {
          label: "c",
          answer: {
            type: "choice",
            choice: "cannot_tell",
            confidence: 0,
            probabilities: { yes: 0.7, cannot_tell: 0.3 },
          },
          missing: "add provider.ts to paths",
        },
      ],
      controls: [
        { fact: "integrity failed", next: "add correct file to paths" },
      ],
      unchecked: ["d"],
      yield: yieldData,
    }),
  );
  assert.match(text, /unsure {2}a = yes \(0.98\).*integrity failed/);
  assert.match(
    text,
    /unsure {2}b = no \(not shown\) \(0.02\).*integrity failed/,
  );
  assert.match(text, /abstain {2}c.*add provider.ts to paths/);
  assert.match(text, /\[integrity failed; add correct file to paths\]/);
  assert.match(text, /unchecked: d/);
  assert.match(text, /1 calls · 1 questions · \$0.00006 · cache 0\/1 · 0.9 s$/);
  assert.doesNotMatch(text, /session:/);
});
test("score and verify merged unknown use calibrated choice cut", () => {
  const score = buildEnvelope({
    answers: [
      {
        label: "level",
        answer: {
          type: "score",
          score: 1,
          confidence: 1,
          legend: null,
          probabilities: { low: 0.849999, high: 0.150001 },
        },
      },
    ],
    yield: yieldData,
  });
  assert.equal(
    score.lines[0]?.type === "answer" && score.lines[0].band,
    "unsure",
  );
  const merged = buildEnvelope({
    answers: [
      {
        label: "claim",
        verify: true,
        answer: {
          type: "choice",
          choice: "not_addressed",
          confidence: 0,
          probabilities: {
            holds: 0.1,
            contradicted: 0.05,
            not_addressed: 0.6,
            cannot_tell: 0.25,
          },
        },
      },
    ],
    yield: yieldData,
  });
  assert.equal(
    merged.lines[0]?.type === "answer" && merged.lines[0].band,
    "verdict",
  );
});
test("abstention cut has priority even over merged verify verdict", () => {
  for (const [p, band] of [
    [0.299999, "verdict"],
    [0.3, "abstain"],
  ] as const) {
    const model = buildEnvelope({
      answers: [
        {
          label: "claim",
          verify: true,
          missing: "add test.ts to paths",
          answer: {
            type: "choice",
            choice: "not_addressed",
            confidence: 1,
            probabilities: {
              holds: 0.1,
              not_addressed: 0.9 - p,
              cannot_tell: p,
            },
          },
        },
      ],
      yield: yieldData,
    });
    assert.equal(
      model.lines[0]?.type === "answer" && model.lines[0].band,
      band,
    );
  }
});
