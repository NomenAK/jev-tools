import assert from "node:assert/strict";
import test from "node:test";
import type { TestScenario } from "../src/core/test-discovery.ts";
import { prepareTestStates } from "../src/core/test-state.ts";

test("large test files split complete bodies while preserving setup and required intermediates", () => {
  const body = "x".repeat(300);
  const text = `import {run} from './impl.js';\nconst seed=7;\ntest('one',()=>{${body}});\ntest('two',()=>{${body}});`;
  const scenarios: TestScenario[] = [
    {
      id: "one",
      name: "one",
      line: 3,
      reliable: true,
      range: { start: 3, end: 3 },
    },
    {
      id: "two",
      name: "two",
      line: 4,
      reliable: true,
      range: { start: 4, end: 4 },
    },
  ];
  const result = prepareTestStates(
    {
      testFile: { path: "test.js", text },
      imports: [{ path: "impl.js", text: "function run(){return 7;}" }],
      changedUnits: [],
    },
    scenarios,
    600,
  );
  assert.equal(result.batches.length, 2);
  assert.equal(result.unjudged.length, 0);
  for (const batch of result.batches) {
    const serialized = JSON.stringify(batch.state);
    assert.ok(serialized.length <= 600);
    assert.match(serialized, /seed=7/);
    assert.match(serialized, /function run/);
    assert.ok(serialized.includes(body));
  }
  assert.deepEqual(
    result.batches.flatMap((batch) => batch.scenarios.map((s) => s.id)),
    ["one", "two"],
  );
});
test("one oversized body is unjudged and never cut to fit", () => {
  const body = "x".repeat(1000);
  const scenario: TestScenario = {
    id: "one",
    name: "one",
    line: 2,
    reliable: true,
    range: { start: 2, end: 2 },
  };
  const result = prepareTestStates(
    {
      testFile: {
        path: "test.js",
        text: `const seed=7;\ntest('one',()=>{${body}});`,
      },
      changedUnits: [],
    },
    [scenario],
    300,
  );
  assert.equal(result.batches.length, 0);
  assert.equal(result.unjudged[0]?.scenario.id, "one");
  assert.match(result.unjudged[0]?.reason, /test body/);
});
