import assert from "node:assert/strict";
import test from "node:test";
import {
  needsReverse,
  pointerQuestion,
  readPointer,
} from "../src/core/pointer.ts";

test("reverse changes only candidates, retaining none at the end", () => {
  const candidates = [
    { id: "S1", label: "one" },
    { id: "S2", label: "two" },
  ];
  assert.deepEqual(
    Object.keys(
      pointerQuestion({
        instructions: "goal",
        noneLabel: "no match",
        candidates,
        reverse: true,
      }).criteria,
    ),
    ["S2", "S1", "none"],
  );
});
test("averaging ranks by probability and detects order disagreement", () => {
  const result = readPointer(
    { S1: 0.5, S2: 0.4, none: 0.1 },
    { S1: 0.2, S2: 0.7, none: 0.1 },
  );
  assert.equal(result.ranked[0]?.id, "S2");
  assert.equal(result.ranked[0]?.p, 0.55);
  assert.equal(result.orderDependent, true);
});
test("one candidate never triggers order reversal", () => {
  assert.equal(needsReverse({ S1: 0.5, none: 0.5 }, 1), false);
  assert.equal(needsReverse({ S1: 0.5, S2: 0.4, none: 0.1 }, 2), true);
});
