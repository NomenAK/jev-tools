import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { prepareCoverageWitnesses } from "../src/core/test-coverage.ts";
import {
  buildCoverageWitnessUnits,
  evaluateBatchWitnessHealth,
} from "../src/presets/witnesses.ts";

test("coverage evidence matches the measured frozen-v2 payload", () => {
  const prepared = prepareCoverageWitnesses(
    { testFile: { path: "test/cli.test.js", text: "real tests\n" } },
    {},
    buildCoverageWitnessUnits([]),
  );
  const expected = [
    [
      "w001",
      "normalize",
      "function",
      "src/normalize.js",
      "export function normalize(s) { return s.trim().toLowerCase(); }",
      "export function normalize(s) { const v = s.trim(); return v.toLowerCase(); }",
    ],
    [
      "w002",
      "formatLine",
      "function",
      "src/format.js",
      "export function formatLine(s) { return s + '\\n'; }",
      "export function formatLine(s) { return s + '\\n'; }",
    ],
    [
      "w003",
      "MAX_ITEMS",
      "declaration",
      "src/count.js",
      "export const MAX_ITEMS = 1000;",
      "export const MAX_ITEMS = 1_000;",
    ],
    [
      "w004",
      "increment",
      "function",
      "src/increment.js",
      "export function increment(n) { return n - 1; }",
      "export function increment(n) { return n + 1; }",
    ],
    [
      "w005",
      "formatPrice",
      "function",
      "src/price.js",
      "export function formatPrice(n) { return n.toFixed(2); }",
      "export function formatMoney(n) { return n.toFixed(2); }",
    ],
    [
      "w006",
      "LIMIT",
      "declaration",
      "src/limit.js",
      "export const LIMIT = 3;",
      "export const LIMIT = 4;",
    ],
    [
      "w007",
      "withinLimit",
      "function",
      "src/limit.js",
      "export function withinLimit(n) { return n <= LIMIT; }",
      "export function withinLimit(n) { return n <= LIMIT; }",
    ],
  ].map(([id, name, kind, file, before, after]) => ({
    id,
    name,
    kind,
    file,
    before,
    after,
    exported: true,
    usedBy: [],
  }));
  assert.deepEqual(prepared.state.changedUnits, expected);
  assert.deepEqual(prepared.state.testFile, {
    path: "test/cli.test.js",
    text: "real tests\n\nimport {increment} from '../src/increment.js';\nimport {formatMoney} from '../src/price.js';\nimport {withinLimit} from '../src/limit.js';\ntest('direct call', () => increment(2));\ntest('renamed call', () => formatMoney(2));\ntest('indirect read', () => withinLimit(2));",
  });
  assert.deepEqual(
    prepared.witnesses.map((w) => w.id),
    [
      "coverage_w001",
      "coverage_w002",
      "coverage_w003",
      "coverage_w004",
      "coverage_w005",
      "coverage_w006",
    ],
  );
  assert.match(
    prepared.questions.coverage_w005?.instructions ?? "",
    /\(formatMoney\)/,
  );
});

test("embedded coverage witnesses execute renamed exports and read an indirect constant alongside real tests", () => {
  const prepared = prepareCoverageWitnesses(
    {
      testFile: { path: "test/real.js", text: "test('real', () => real());" },
      changedUnits: [],
    },
    { real: { type: "bool", instructions: "real usage" } },
    buildCoverageWitnessUnits([]),
  );
  const file = prepared.state.testFile as { text: string };
  assert.match(file.text, /test\('real'/);
  assert.match(file.text, /formatMoney\(2\)/);
  assert.match(file.text, /withinLimit\(2\)/);
  assert.doesNotMatch(file.text, /normalize\(/);
  assert.equal(prepared.state.witnessTestFile, undefined);
  assert.ok(
    Object.values(prepared.questions).every(
      (q) => !q.instructions.includes("witnessTestFile"),
    ),
  );
});

test("an imported decoy becomes an unhealthy control when the real test calls it", () => {
  for (const called of [false, true]) {
    const prepared = prepareCoverageWitnesses(
      {
        testFile: {
          path: "test/real.test.js",
          text: `import {normalize as clean} from '../src/normalize.js';\ntest('direct call', () => ${called ? "clean(' X ')" : "1"});\n`,
        },
      },
      { real: { type: "bool", instructions: "real coverage" } },
      buildCoverageWitnessUnits([]),
    );
    const units = prepared.state.changedUnits as {
      name: string;
      after: string;
    }[];
    const file = prepared.state.testFile as { text: string };
    let executions = 0;
    const declarations = units
      .map((unit) => unit.after.replace("export ", ""))
      .join("\n");
    const executable = file.text.replace(
      /import \{([^}]+)\} from '[^']+';/g,
      (_, names: string) =>
        names.includes(" as ")
          ? `const ${names.split(" as ")[1]} = ${names.split(" as ")[0]};`
          : "",
    );
    runInNewContext(
      `${declarations}\nconst original = normalize; normalize = (s) => { record(); return original(s); };\n${executable}`,
      {
        record: () => {
          executions++;
        },
        test: (_name: string, body: () => void) => body(),
      },
    );
    assert.equal(executions, called ? 1 : 0);
    const answers = Object.fromEntries(
      prepared.witnesses.map((w) => [
        w.id,
        {
          type: "bool" as const,
          p:
            w.expected === "yes"
              ? 0.95
              : w.label === "normalize" && executions > 0
                ? 0.99
                : 0.1,
        },
      ]),
    );
    const health = evaluateBatchWitnessHealth(["real"], prepared.witnesses, {
      ok: true,
      answers,
      calls: 1,
      questions: 7,
    });
    assert.equal(health.healthy, !called);
    assert.equal(health.unhealthyQuestionIds.has("real"), called);
  }
});

for (const [label, decoy, reference, missing, healthy] of [
  ["cap inclusive", 0.2, 0.7, false, true],
  ["decoy over cap", 0.201, 0.7, false, false],
  ["reference below floor", 0.2, 0.699, false, false],
  ["missing control", 0.2, 0.7, true, false],
] as const)
  test(`coverage health: ${label}`, () => {
    const prepared = prepareCoverageWitnesses(
      {},
      {},
      buildCoverageWitnessUnits([]),
    );
    const answers = Object.fromEntries(
      prepared.witnesses
        .filter((_, i) => !missing || i !== 0)
        .map((w) => [
          w.id,
          {
            type: "bool" as const,
            p: w.expected === "yes" ? reference : decoy,
          },
        ]),
    );
    const health = evaluateBatchWitnessHealth(["real"], prepared.witnesses, {
      ok: true,
      answers,
      calls: 1,
      questions: 7,
    });
    assert.equal(health.healthy, healthy);
    assert.equal(health.unhealthyQuestionIds.has("real"), !healthy);
  });

test("a healthy witness in another batch cannot rescue a failed or missing control", () => {
  const prepared = prepareCoverageWitnesses(
    {},
    {},
    buildCoverageWitnessUnits([]),
  );
  const decoy = prepared.witnesses[0];
  assert.ok(decoy);
  const healthy = Object.fromEntries(
    prepared.witnesses.map((w) => [
      w.id,
      { type: "bool" as const, p: w.expected === "yes" ? 0.95 : 0.1 },
    ]),
  );
  const failed = {
    ...healthy,
    [decoy.id]: { type: "bool" as const, p: 0.21 },
  };
  const missing = { ...healthy };
  delete missing[decoy.id];
  const health = evaluateBatchWitnessHealth(
    ["good", "bad", "missing"],
    prepared.witnesses,
    {
      ok: true,
      answers: healthy,
      calls: 3,
      questions: 21,
      batches: [
        { questionIds: ["good", ...Object.keys(healthy)], answers: healthy },
        { questionIds: ["bad", ...Object.keys(healthy)], answers: failed },
        { questionIds: ["missing", ...Object.keys(healthy)], answers: missing },
      ],
    },
  );
  assert.equal(health.unhealthyQuestionIds.has("good"), false);
  assert.match(health.unhealthyQuestionIds.get("bad") ?? "", /decoy/);
  assert.match(health.unhealthyQuestionIds.get("missing") ?? "", /unavailable/);
});
