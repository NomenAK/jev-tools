import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OUTPUT_CHUNK_CHARS,
  OUTPUT_FIND_MAX_CALLS,
  STATE_MAX_CHARS,
} from "../src/constants.ts";
import {
  fitOutputToBudget,
  needsPassageFinding,
  planPassageFinding,
} from "../src/core/command-state.ts";

test("small output fits the state, large output needs passage finding", () => {
  assert.equal(needsPassageFinding({}, { stdout: "ok", stderr: "" }), false);
  assert.equal(
    needsPassageFinding(
      {},
      { stdout: "x".repeat(STATE_MAX_CHARS), stderr: "" },
    ),
    true,
  );
});

test("passage planning chunks both streams and refuses oversized evidence", () => {
  const planned = planPassageFinding({
    stdout: "a\nb\n",
    stderr: "c\n",
    compressedChars: 10,
    originalBytes: 20,
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.equal(
    planned.plan.stdoutChunks.map((chunk) => chunk.text).join("") +
      planned.plan.stderrChunks.map((chunk) => chunk.text).join(""),
    "a\nb\nc\n",
  );
  const refused = planPassageFinding({
    stdout: "x",
    stderr: "",
    compressedChars: OUTPUT_CHUNK_CHARS * OUTPUT_FIND_MAX_CALLS + 1,
    originalBytes: 1,
  });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.error, /more than \d+ find calls/);
  const manyChunks = planPassageFinding({
    stdout: "x".repeat(OUTPUT_CHUNK_CHARS * (OUTPUT_FIND_MAX_CALLS + 1)),
    stderr: "",
    compressedChars: 1,
    originalBytes: 1,
  });
  assert.equal(manyChunks.ok, false);
});

test("a nearly full state refuses passage selection", () => {
  const planned = planPassageFinding({
    stdout: "hello",
    stderr: "",
    compressedChars: 5,
    originalBytes: 5,
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const fitted = fitOutputToBudget(
    { pad: "x".repeat(STATE_MAX_CHARS) },
    { stdout: "hello", stderr: "" },
    planned.plan,
    [0],
  );
  assert.equal(fitted.ok, false);
  if (fitted.ok) return;
  assert.match(fitted.error, /No space for command output/);
});

test("small output passes through with no omission flags", () => {
  const planned = planPassageFinding({
    stdout: "all good\n",
    stderr: "warn\n",
    compressedChars: 14,
    originalBytes: 14,
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const fitted = fitOutputToBudget(
    {},
    { stdout: "all good\n", stderr: "warn\n" },
    planned.plan,
    [0, 0],
  );
  assert.equal(fitted.ok, true);
  if (!fitted.ok) return;
  assert.deepEqual(fitted.fitted.stdout, "all good\n");
  assert.deepEqual(fitted.fitted.stderr, "warn\n");
  assert.equal(fitted.fitted.omittedFailing, false);
  assert.equal(fitted.fitted.selectedPassages, false);
});

test("a failing chunk dropped by the budget is reported", () => {
  const stdout = "A".repeat(OUTPUT_CHUNK_CHARS * 2);
  const planned = planPassageFinding({
    stdout,
    stderr: "",
    compressedChars: stdout.length,
    originalBytes: stdout.length,
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.equal(planned.plan.stdoutChunks.length, 2);
  const fitted = fitOutputToBudget(
    { pad: "x".repeat(STATE_MAX_CHARS - 400) },
    { stdout, stderr: "" },
    planned.plan,
    [0.9, 0],
  );
  assert.equal(fitted.ok, true);
  if (!fitted.ok) return;
  assert.ok(fitted.fitted.stdout.length < stdout.length);
  assert.equal(fitted.fitted.omittedFailing, true);
  assert.equal(fitted.fitted.selectedPassages, true);
});
