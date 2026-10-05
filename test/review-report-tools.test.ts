import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { GitExec } from "../src/core/git.ts";
import {
  type ResultReportV1,
  validateResultReport,
} from "../src/core/result-report.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { Answer, JevClient } from "../src/jev/types.ts";
import { isResultReport } from "../src/report-schema.ts";
import { Session } from "../src/session.ts";
import { createCheckDiffTool } from "../src/tools/check-diff.ts";
import { createSelectTestsTool } from "../src/tools/select-tests.ts";

const run = promisify(execFile);
const exec: GitExec = async (command, args, options) => {
  try {
    return { ...(await run(command, args, options)), code: 0, killed: false };
  } catch (error) {
    const value = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
    };
    return {
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? "",
      code: value.code ?? 1,
      killed: value.killed ?? false,
    };
  }
};
const client: JevClient = {
  clearCache() {},
  async judge(_state, questions, options) {
    const admitted = options?.beforeRequest?.(Object.keys(questions).length);
    if (admitted && !admitted.ok)
      return {
        ok: true,
        calls: 0,
        questions: 0,
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            { type: "unjudged", cause: "call_budget", reason: admitted.error },
          ]),
        ),
      };
    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(questions)) {
      if (question.type === "bool")
        answers[id] = { type: "bool", source: "fresh", p: 0.01 };
      else if (question.type === "choice") {
        const choice = Object.hasOwn(question.criteria, "still_true")
          ? "still_true"
          : Object.hasOwn(question.criteria, "conforms")
            ? "conforms"
            : Object.hasOwn(question.criteria, "none")
              ? "none"
              : Object.keys(question.criteria)[0];
        assert.ok(choice);
        answers[id] = {
          type: "choice",
          source: "fresh",
          choice,
          confidence: 0.99,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((key) => [
              key,
              key === choice
                ? 0.99
                : 0.01 / Math.max(1, Object.keys(question.criteria).length - 1),
            ]),
          ),
        };
      } else
        answers[id] = {
          type: "score",
          source: "fresh",
          score: 1,
          confidence: 1,
          probabilities: { "1": 1 },
          legend: {},
        };
    }
    return {
      ok: true,
      answers,
      calls: 1,
      questions: Object.keys(questions).length,
      usage: { inputTokens: 10, costUsd: 0.001 },
    };
  },
};
function deps(configured = true) {
  const host = detectHost({});
  return {
    client: configured ? client : undefined,
    host,
    exec,
    runtime: { session: new Session({}), guide: new Guide(host) },
  };
}
function report(value: { details: unknown }): ResultReportV1 {
  const details = value.details;
  assert.ok(details && typeof details === "object" && "result" in details);
  const result = details.result;
  assert.ok(isResultReport(result));
  assert.deepEqual(validateResultReport(result), []);
  return result;
}
test("review/select producer modes retain negative results, budgets, static decisions, fallback and empty scopes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-report-tools-"));
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    await writeFile(
      join(cwd, "source.js"),
      "export function value() { return 1; }\n",
    );
    await writeFile(
      join(cwd, "value.test.js"),
      "import { test } from 'node:test'; import { value } from './source.js'; test('value result', () => value());\n",
    );
    await writeFile(
      join(cwd, "README.md"),
      "# value\n\n`value` returns one.\n",
    );
    await writeFile(
      join(cwd, "SPEC.md"),
      "### REQ-001 Value\nThe value function returns a number.\n",
    );
    await exec("git", ["add", "."], { cwd, timeout: 10000 });
    await exec(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "base",
      ],
      { cwd, timeout: 10000 },
    );
    const empty = report(
      await createCheckDiffTool(deps()).execute(
        "empty",
        { check: "risk", witnesses: "off" },
        undefined,
        undefined,
        { cwd },
      ),
    );
    assert.equal(empty.execution, "not_judged");
    assert.ok(empty.diagnostics.some((d) => d.cause === "no_changed_units"));
    await writeFile(
      join(cwd, "source.js"),
      "export function value() { return 2; }\n",
    );
    for (const check of ["risk", "docs", "spec"] as const) {
      const result = report(
        await createCheckDiffTool(deps()).execute(
          check,
          { check, witnesses: "off", spec_path: "SPEC.md" },
          undefined,
          undefined,
          { cwd },
        ),
      );
      assert.ok(
        result.items.some((item) => item.treatment === "judged"),
        check,
      );
      assert.ok(result.accounting.requestedResults.fresh > 0, check);
      assert.equal(result.context.resolvedBase.status, "known");
    }
    const budget = report(
      await createCheckDiffTool(deps()).execute(
        "budget",
        { check: "risk", witnesses: "off", max_calls: 0 },
        undefined,
        undefined,
        { cwd },
      ),
    );
    assert.equal(budget.execution, "not_judged");
    assert.ok(budget.items.every((item) => item.treatment === "not_judged"));
    const fallback = report(
      await createSelectTestsTool(deps(false)).execute(
        "fallback",
        { witnesses: "off" },
        undefined,
        undefined,
        { cwd },
      ),
    );
    assert.equal(fallback.execution, "partial");
    assert.ok(
      fallback.items.some(
        (item) => item.treatment === "not_judged" && item.selection?.selected,
      ),
    );
    const noMatch = report(
      await createSelectTestsTool(deps()).execute(
        "scope",
        { paths: ["missing/**"], witnesses: "off" },
        undefined,
        undefined,
        { cwd },
      ),
    );
    assert.equal(noMatch.execution, "not_judged");
    assert.ok(noMatch.diagnostics.some((d) => d.cause === "criteria_no_match"));
    await writeFile(
      join(cwd, "value.test.js"),
      "import { test } from 'node:test'; import { value } from './source.js'; test('value result', () => value() === 2);\n",
    );
    const touched = report(
      await createSelectTestsTool(deps()).execute(
        "touched",
        { witnesses: "off" },
        undefined,
        undefined,
        { cwd },
      ),
    );
    assert.ok(
      touched.items.some(
        (item) =>
          item.treatment === "static" && item.selection?.reason === "touched",
      ),
    );
    const refused = report(
      await createSelectTestsTool(deps()).execute(
        "forbidden",
        { paths: ["../outside"] },
        undefined,
        undefined,
        { cwd },
      ),
    );
    assert.equal(refused.execution, "refused");
    assert.equal(refused.diagnostics[0]?.cause, "forbidden_path");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("spec drift is one requested pointer across multiple changed units and collection omissions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-spec-pointer-"));
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    for (const name of ["first", "second"])
      await writeFile(
        join(cwd, `${name}.js`),
        `export function ${name}() { return 1; }\n`,
      );
    await writeFile(
      join(cwd, "SPEC.md"),
      "### REQ-001 Values\nValues are numbers.\n",
    );
    await exec("git", ["add", "."], { cwd, timeout: 10000 });
    await exec(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "base",
      ],
      { cwd, timeout: 10000 },
    );
    for (const name of ["first", "second"])
      await writeFile(
        join(cwd, `${name}.js`),
        `export function ${name}() { return 2; }\n`,
      );
    let selectedId = "";
    let otherId = "";
    let chooseNone = false;
    let fail = false;
    const pointerClient: JevClient = {
      clearCache() {},
      async judge(_state, questions, options) {
        const admitted = options?.beforeRequest?.(
          Object.keys(questions).length,
        );
        if (admitted && !admitted.ok)
          return {
            ok: true,
            calls: 0,
            questions: 0,
            answers: Object.fromEntries(
              Object.keys(questions).map((id) => [
                id,
                {
                  type: "unjudged",
                  cause: "call_budget",
                  reason: admitted.error,
                },
              ]),
            ),
          };
        if (fail)
          return {
            ok: false,
            cause: "transport_failure",
            error: "Endpoint unavailable",
            calls: 1,
            questions: Object.keys(questions).length,
          };
        const drift = questions.drift;
        assert.equal(drift?.type, "choice");
        if (drift?.type !== "choice") throw new Error("Missing drift choice");
        const candidates = Object.entries(drift.criteria).filter(
          ([id]) => id !== "none",
        );
        assert.equal(candidates.length, 2);
        selectedId =
          candidates.find(([, label]) => label.includes("second.js"))?.[0] ??
          "";
        otherId = candidates.find(([id]) => id !== selectedId)?.[0] ?? "";
        assert.ok(selectedId && otherId);
        return {
          ok: true,
          calls: 1,
          questions: 1,
          cacheHits: 1,
          cacheRequests: 2,
          answers: {
            req1: {
              type: "choice",
              source: "fresh",
              choice: "conforms",
              confidence: 0.99,
              probabilities: {
                conforms: 0.9,
                violates: 0.05,
                not_touched: 0.05,
              },
            },
            drift: {
              type: "choice",
              source: "cache",
              choice: chooseNone ? "none" : selectedId,
              confidence: 0.99,
              probabilities: {
                [selectedId]: chooseNone ? 0.05 : 0.73,
                [otherId]: chooseNone ? 0.05 : 0.17,
                none: chooseNone ? 0.9 : 0.1,
              },
            },
          },
        };
      },
    };
    const check = async (maxCalls?: number) => {
      const dependencies = deps();
      dependencies.client = pointerClient;
      return report(
        await createCheckDiffTool(dependencies).execute(
          "spec-pointer",
          {
            check: "spec",
            spec_path: "SPEC.md",
            ...(maxCalls === undefined ? {} : { max_calls: maxCalls }),
          },
          undefined,
          undefined,
          { cwd },
        ),
      );
    };
    const selected = await check();
    assert.equal(selected.execution, "complete");
    assert.equal(selected.items.length, 2);
    assert.deepEqual(selected.accounting.requestedResults, {
      total: { status: "known", value: 2 },
      fresh: 1,
      cache: 1,
      notJudged: 0,
      static: 0,
    });
    const pointer = selected.items.find((item) => item.kind === "pointer");
    assert.equal(pointer?.id, "spec:drift");
    assert.equal(pointer?.label, "second.js second specification drift");
    assert.equal(pointer?.source, "cache");
    assert.equal(pointer?.treatment, "judged");
    if (pointer?.treatment !== "judged") throw new Error("Pointer not judged");
    assert.equal(pointer.judgment.result, selectedId);
    assert.deepEqual(pointer.judgment.measure.value, {
      status: "known",
      value: 0.73,
    });
    assert.deepEqual(
      pointer.judgment.rawValues.map((value) => [
        value.label,
        value.probability,
      ]),
      [
        [selectedId, { status: "known", value: 0.73 }],
        [otherId, { status: "known", value: 0.17 }],
        ["none", { status: "known", value: 0.1 }],
      ],
    );
    assert.equal(
      selected.items.some((item) => item.id.includes(otherId)),
      false,
    );
    assert.deepEqual(
      selected.context.inventories.map((inventory) => [
        inventory.id,
        inventory.discovered,
        inventory.considered,
      ]),
      [
        [
          "spec-requirements",
          { status: "known", value: 1 },
          { status: "known", value: 1 },
        ],
        [
          "changed-units",
          { status: "known", value: 2 },
          { status: "known", value: 2 },
        ],
      ],
    );
    chooseNone = true;
    const negative = await check();
    const none = negative.items.find((item) => item.kind === "pointer");
    assert.equal(none?.label, "Specification drift pointer");
    assert.equal(none?.treatment, "judged");
    if (none?.treatment !== "judged")
      throw new Error("None pointer not judged");
    assert.equal(none.judgment.result, "none");
    assert.deepEqual(none.judgment.measure.value, {
      status: "known",
      value: 0.9,
    });
    assert.equal(negative.execution, "complete");
    const budget = await check(0);
    assert.equal(budget.execution, "not_judged");
    assert.deepEqual(budget.accounting.requestedResults, {
      total: { status: "known", value: 2 },
      fresh: 0,
      cache: 0,
      notJudged: 2,
      static: 0,
    });
    assert.equal(
      budget.items.filter((item) => item.kind === "pointer").length,
      1,
    );
    assert.ok(
      budget.diagnostics.some(
        (diagnostic) => diagnostic.cause === "call_budget",
      ),
    );
    fail = true;
    const failed = await check();
    assert.equal(failed.execution, "not_judged");
    assert.deepEqual(
      failed.accounting.requestedResults,
      budget.accounting.requestedResults,
    );
    assert.equal(
      failed.items.filter((item) => item.kind === "pointer").length,
      1,
    );
    assert.ok(
      failed.items.every(
        (item) => item.treatment === "not_judged" && !("judgment" in item),
      ),
    );
    assert.ok(
      failed.diagnostics.some(
        (diagnostic) => diagnostic.cause === "transport_failure",
      ),
    );
    fail = false;
    await writeFile(
      join(cwd, "omitted.bin"),
      Buffer.from([0xff, 0x00, 0xfd, 0x0a]),
    );
    await exec("git", ["add", "omitted.bin"], { cwd, timeout: 10000 });
    const incomplete = await check();
    assert.equal(incomplete.execution, "partial");
    assert.deepEqual(
      incomplete.accounting.requestedResults,
      negative.accounting.requestedResults,
    );
    assert.equal(incomplete.items.length, 2);
    assert.ok(
      incomplete.items.every(
        (item) =>
          item.treatment === "judged" && item.judgment.band === "unsure",
      ),
    );
    const omission = incomplete.diagnostics.find(
      (diagnostic) => diagnostic.cause === "collection_omitted",
    );
    assert.ok(omission);
    assert.deepEqual(omission.scope, {
      kind: "item",
      itemIds: ["spec:req1", "spec:drift"],
    });
    assert.equal(omission.effect, "reservation");
    assert.equal(omission.memberCount.status, "known");
    assert.ok(
      omission.omittedMembers.some((member) => member.includes("omitted.bin")),
    );
    const changed = incomplete.context.inventories.find(
      (inventory) => inventory.id === "changed-units",
    );
    assert.deepEqual(changed?.discovered, { status: "known", value: 2 });
    assert.deepEqual(changed?.considered, { status: "known", value: 2 });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
