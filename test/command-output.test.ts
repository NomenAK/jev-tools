import assert from "node:assert/strict";
import { test } from "node:test";
import { OUTPUT_REPEAT_MIN } from "../src/constants.ts";
import {
  cleanOutput,
  createRarityCompressor,
  failureTargets,
  lineShape,
  outputChunks,
  selectOutput,
} from "../src/core/command-output.ts";

for (const [runner, noise, failure] of [
  [
    "Go",
    "--- PASS: TestHappy123 (0.01s)",
    "    billing_test.go:42: expected 10, got 20",
  ],
  [
    "pytest",
    "tests/test_ok.py::test_ok[123] PASSED",
    "FAILED tests/test_bill.py::TestBill::test_total[with space] - AssertionError",
  ],
  [
    "Vitest",
    " ✓ src/ok.test.ts (1 test)",
    " FAIL src/bill.test.ts > rounds correctly",
  ],
  [
    "CI",
    "Downloading artifact 123 completed",
    "error TS2322: Type string is not assignable to number",
  ],
] as const)
  test(`${runner} failures survive rarity compression between noisy runs`, () => {
    const lines = [
      ...Array.from({ length: 40 }, () => noise),
      failure,
      ...Array.from({ length: 40 }, () => noise),
    ];
    const frequencies = new Map<string, number>();
    for (const line of lines)
      frequencies.set(
        lineShape(line),
        (frequencies.get(lineShape(line)) ?? 0) + 1,
      );
    const compressed: string[] = [];
    const compressor = createRarityCompressor(frequencies, (line) =>
      compressed.push(line),
    );
    for (const line of lines) compressor.line(line);
    compressor.finish();
    assert.deepEqual(compressed, [
      noise,
      "[… 38 repetitive lines …]",
      noise,
      failure,
      noise,
      "[… 38 repetitive lines …]",
      noise,
    ]);
  });
test("short repetitive runs are emitted unfolded", () => {
  const frequencies = new Map([[lineShape("ok"), OUTPUT_REPEAT_MIN]]);
  const compressed: string[] = [];
  const compressor = createRarityCompressor(frequencies, (line) => {
    compressed.push(line);
  });
  for (const line of ["ok", "ok", "ok"]) compressor.line(line);
  compressor.finish();
  assert.deepEqual(compressed, ["ok", "ok", "ok"]);
});
test("long repetitive runs are still folded", () => {
  const first = "--- PASS: TestBilling001 (0.01s)";
  const middle = "--- PASS: TestBilling002 (0.01s)";
  const last = "--- PASS: TestBilling003 (0.01s)";
  const frequencies = new Map([[lineShape(first), OUTPUT_REPEAT_MIN]]);
  const compressed: string[] = [];
  const compressor = createRarityCompressor(frequencies, (line) => {
    compressed.push(line);
  });
  for (const line of [first, middle, last]) compressor.line(line);
  compressor.finish();
  assert.deepEqual(compressed, [first, "[… 1 repetitive lines …]", last]);
});
test("runs at exact fold equality are emitted unfolded", () => {
  // "[… 1 repetitive lines …]" is 24 chars, so three 24-char lines fold
  // to exactly their original length and must stay unfolded.
  const line = "a".repeat(24);
  const frequencies = new Map([[lineShape(line), OUTPUT_REPEAT_MIN]]);
  const compressed: string[] = [];
  const compressor = createRarityCompressor(frequencies, (line) => {
    compressed.push(line);
  });
  for (const repeated of [line, line, line]) compressor.line(repeated);
  compressor.finish();
  assert.deepEqual(compressed, [line, line, line]);
});
test("unfolded short runs keep their order before a rare line", () => {
  const frequencies = new Map([[lineShape("ok"), OUTPUT_REPEAT_MIN]]);
  const compressed: string[] = [];
  const compressor = createRarityCompressor(frequencies, (line) => {
    compressed.push(line);
  });
  for (const line of ["ok", "ok", "ok", "FAIL: boom"]) compressor.line(line);
  compressor.finish();
  assert.deepEqual(compressed, ["ok", "ok", "ok", "FAIL: boom"]);
});
test("ten ok lines stay unfolded at the fold boundary", () => {
  const run = Array.from({ length: 10 }, () => "ok");
  const frequencies = new Map([[lineShape("ok"), OUTPUT_REPEAT_MIN]]);
  const compressed: string[] = [];
  const compressor = createRarityCompressor(frequencies, (line) => {
    compressed.push(line);
  });
  for (const line of run) compressor.line(line);
  compressor.finish();
  assert.deepEqual(compressed, run);
});
test("eleven ok lines fold with the right count", () => {
  const run = Array.from({ length: 11 }, () => "ok");
  const frequencies = new Map([[lineShape("ok"), OUTPUT_REPEAT_MIN]]);
  const compressed: string[] = [];
  const compressor = createRarityCompressor(frequencies, (line) => {
    compressed.push(line);
  });
  for (const line of run) compressor.line(line);
  compressor.finish();
  assert.deepEqual(compressed, ["ok", "[… 9 repetitive lines …]", "ok"]);
});
test("pytest target preserves complete parameterized node ID", () => {
  assert.deepEqual(
    failureTargets(
      "FAILED test_bill.py::TestBill::test_total[with space] - AssertionError",
    ).targets,
    [
      {
        path: "test_bill.py",
        nodeId: "test_bill.py::TestBill::test_total[with space]",
        assertion: true,
      },
    ],
  );
  assert.equal(
    failureTargets("ERROR tests/test_collect.py - ModuleNotFoundError")
      .assertion,
    false,
  );
});
test("ordered selection retains failure chunk instead of an earlier less relevant chunk", () => {
  const text = `${"setup\n".repeat(700)}FAIL: critical assertion\n${"cleanup\n".repeat(700)}`;
  const chunks = outputChunks(text);
  const selected = selectOutput(
    text,
    chunks,
    chunks.map((chunk) => (chunk.text.includes("FAIL:") ? 0.99 : 0)),
    4000,
  );
  assert.match(selected, /FAIL: critical assertion/);
  assert.ok(selected.indexOf("setup") < selected.indexOf("FAIL:"));
  assert.ok(selected.indexOf("FAIL:") < selected.lastIndexOf("cleanup"));
  assert.ok(JSON.stringify(selected).length <= 4000);
});
test("ANSI and CRLF are removed before shape analysis", () => {
  assert.equal(cleanOutput("\x1b[31mFAIL\x1b[0m\r\n"), "FAIL\n");
});
test("first environment or compile failure does not require assertion evidence", () => {
  assert.equal(
    failureTargets(
      "error TS2322: expected number\nFAILED tests/test_bill.py::test_bill - AssertionError",
    ).assertion,
    false,
  );
  assert.equal(
    failureTargets("AssertionError: expected 1\nECONNREFUSED").assertion,
    true,
  );
});
test("Node and Jest failure locations need no test filename suffix", () => {
  for (const path of ["test/bill.mjs", "file:///repo/test/bill.mjs"])
    assert.deepEqual(
      failureTargets(
        `✖ billing\n  test at ${path}:4:1\n  AssertionError: expected 5`,
      ).targets,
      [{ path: path.replace(/^file:\/\//, ""), assertion: true }],
    );
  assert.deepEqual(
    failureTargets("FAIL test/billing.js\nAssertionError: expected 5").targets,
    [{ path: "test/billing.js", assertion: true }],
  );
});
test("Go locations belong to the first failed scenario, not passing runs", () => {
  const result = failureTargets(
    `=== RUN   TestHappy\n    bill_test.go:4: happy\n--- PASS: TestHappy\n=== RUN   TestBroken\n    bill_test.go:8: expected 5\n--- FAIL: TestBroken (0.00s)\n=== RUN   TestLater\n    later_test.go:9: happy\n--- PASS: TestLater\n${"noise\n".repeat(25)}FAILED later.py::test_later - AssertionError`,
  );
  assert.deepEqual(result.targets, [
    { path: "bill_test.go", testName: "TestBroken", assertion: true },
  ]);
});
test("source output with expected or want is not a runner assertion", () => {
  const result = failureTargets(
    '// RangeArgs returns an error if the number of args is not in the expected range.\nconst want = "expected";',
  );
  assert.deepEqual(result, { assertion: false, targets: [] });
  assert.equal(
    failureTargets("    args_test.go:12: expected 2, got 1").assertion,
    true,
  );
});
test("pytest -rN tracebacks retain the assertion safety signature without FAILED summary", () => {
  const log = `=================================== FAILURES ===================================\n___________________________________ test_eq ____________________________________\n\n    def test_eq():\n>       assert 1 == 2\nE       assert 1 == 2\n\ntest_a.py:2: AssertionError\n============================== 1 failed in 0.10s ===============================`;
  assert.equal(failureTargets(log).signature, "assertion");
  assert.equal(failureTargets("test_a.py:2: AssertionError").assertion, true);
  assert.equal(failureTargets("E       assert 1 == 2").assertion, true);
});
test("a late node:test target survives many summary lines after the first anchor", () => {
  const passes = Array.from(
    { length: 30 },
    (_, index) => `\u2714 passing test ${index + 1} (0.1ms)`,
  );
  const text = [
    "\u2716 collects exactly one file (7.071906ms)",
    ...passes,
    "\u2716 failing tests:",
    "",
    "test at zz-collect-a.test.mjs:15:1",
    "\u2716 collects exactly one file (7.071906ms)",
    "  AssertionError [ERR_ASSERTION]: boom",
  ].join("\n");
  const result = failureTargets(text);
  assert.deepEqual(result.targets, [
    { path: "zz-collect-a.test.mjs", assertion: true },
  ]);
});
