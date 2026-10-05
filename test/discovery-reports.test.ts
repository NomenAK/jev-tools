import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateResultReport } from "../src/core/result-report.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { Answer, JevClient } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";
import { createFindFilesTool } from "../src/tools/find.ts";
import { createLocateTool } from "../src/tools/locate.ts";

function dependencies(client: JevClient | undefined, paths: string[]) {
  const host = detectHost({});
  return {
    client,
    host,
    runtime: { session: new Session({}), guide: new Guide(host) },
    exec: async (_command: string, args: string[]) => ({
      stdout: paths
        .map((path) => `${args.includes("-t") ? "H " : ""}${path}\0`)
        .join(""),
      stderr: "",
      code: 0,
      killed: false,
    }),
  };
}
const source = Array.from(
  { length: 6 },
  (_, i) =>
    `# Section ${i + 1}\n${(`evidence ${i} ${"x".repeat(350)}\n`).repeat(10)}`,
).join("\n");
const choice = (
  source: "fresh" | "cache",
  probabilities: Record<string, number>,
): Answer => {
  const winner = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  assert.ok(winner);
  return {
    type: "choice",
    source,
    probabilities,
    choice: winner[0],
    confidence: 0.01,
  };
};

test("empty discovery inventory is not a synthetic none judgment", async () => {
  const client: JevClient = {
    clearCache() {},
    async judge() {
      throw Error("unexpected judgment");
    },
  };
  const output = await createFindFilesTool(dependencies(client, [])).execute(
    "empty",
    { goal: "compute monthly invoice proration before billing" },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  const report = output.details.result;
  assert.deepEqual(validateResultReport(report), []);
  assert.equal(report.execution, "not_judged");
  assert.equal(report.items[0]?.treatment, "not_judged");
  assert.ok(report.items[0]);
  assert.equal("judgment" in report.items[0], false);
  assert.deepEqual(report.context.inventories[0]?.discovered, {
    status: "known",
    value: 0,
  });
  assert.equal(report.accounting.httpAttempts, 0);
  assert.equal(report.diagnostics[0]?.cause, "collection_empty");
});

for (const primarySource of ["fresh", "cache"] as const) {
  test(`locate preserves ${primarySource} primary independently of reversed control`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jev-report-locate-"));
    let calls = 0;
    const client: JevClient = {
      clearCache() {},
      async judge() {
        const origin =
          calls++ === 0
            ? primarySource
            : primarySource === "fresh"
              ? "cache"
              : "fresh";
        return {
          ok: true,
          calls: origin === "fresh" ? 1 : 0,
          questions: origin === "fresh" ? 1 : 0,
          cacheHits: origin === "cache" ? 1 : 0,
          cacheRequests: 1,
          answers: {
            pointer: choice(origin, { S1: 0.55, S5: 0.4, none: 0.05 }),
          },
        };
      },
    };
    try {
      await writeFile(join(cwd, "large.md"), source);
      const output = await createLocateTool(
        dependencies(client, ["large.md"]),
      ).execute(
        "mixed",
        { path: "large.md", goal: "where is evidence three" },
        undefined,
        undefined,
        { cwd },
      );
      const report = output.details.result;
      assert.deepEqual(validateResultReport(report), []);
      assert.equal(report.execution, "complete");
      const item = report.items[0];
      assert.ok(item);
      assert.equal(item.treatment, "judged");
      if (item.treatment !== "judged") throw Error("expected judgment");
      assert.equal(item.source, primarySource);
      assert.equal(
        item.judgment.controls[0]?.source,
        primarySource === "fresh" ? "cache" : "fresh",
      );
      assert.equal(item.judgment.band, "unsure");
      assert.equal(calls, 2);
      assert.equal(report.accounting.requestedResults[primarySource], 1);
      assert.equal(
        report.accounting.auxiliary.controls[
          primarySource === "fresh" ? "cache" : "fresh"
        ],
        1,
      );
      assert.equal(
        report.accounting.requestedResults.fresh +
          report.accounting.requestedResults.cache,
        1,
      );
      assert.equal(
        report.accounting.auxiliary.passages.fresh +
          report.accounting.auxiliary.passages.cache,
        0,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("a missing required locate control invalidates the whole pointer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-report-control-"));
  let calls = 0;
  const client: JevClient = {
    clearCache() {},
    async judge() {
      return calls++ === 0
        ? {
            ok: true,
            calls: 1,
            questions: 1,
            answers: {
              pointer: choice("fresh", { S1: 0.55, S5: 0.4, none: 0.05 }),
            },
          }
        : {
            ok: true,
            calls: 0,
            answers: {
              pointer: {
                type: "unjudged",
                reason: "session budget reached",
                cause: "session_budget",
              },
            },
          };
    },
  };
  try {
    await writeFile(join(cwd, "large.md"), source);
    const output = await createLocateTool(
      dependencies(client, ["large.md"]),
    ).execute(
      "missing",
      { path: "large.md", goal: "where is evidence three" },
      undefined,
      undefined,
      { cwd },
    );
    const report = output.details.result;
    assert.deepEqual(validateResultReport(report), []);
    assert.equal(report.execution, "not_judged");
    assert.equal(report.items[0]?.treatment, "not_judged");
    assert.ok(report.items[0]);
    assert.equal("judgment" in report.items[0], false);
    assert.equal(report.accounting.requestedResults.fresh, 0);
    assert.equal(report.accounting.auxiliary.controls.notJudged, 1);
    assert.equal(report.diagnostics[0]?.cause, "session_budget");
    assert.ok(report.actions.every((action) => !action.repeatUnchanged));
    assert.equal(calls, 2);
    assert.equal(report.accounting.auxiliary.passages.fresh, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("invalid discovery root refuses before collection or judgment", async () => {
  let collections = 0;
  const deps = dependencies(undefined, []);
  deps.exec = async () => {
    collections++;
    throw Error("unexpected collection");
  };
  const output = await createFindFilesTool(deps).execute(
    "root",
    {
      root: "../outside",
      goal: "compute monthly invoice proration before billing",
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  assert.equal(collections, 0);
  const report = output.details.result;
  assert.deepEqual(validateResultReport(report), []);
  assert.equal(report.execution, "refused");
  assert.equal(report.context.effectiveRoot.status, "unknown");
  assert.deepEqual(report.context.inventories, []);
  assert.equal(report.diagnostics[0]?.cause, "invalid_root");
});

test("find counts only the entry as requested while cache rankings remain auxiliary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-report-find-"));
  const client: JevClient = {
    clearCache() {},
    async judge(state, questions) {
      if (state.candidates)
        return {
          ok: true,
          calls: 0,
          questions: 0,
          cacheHits: 1,
          cacheRequests: 1,
          answers: { entry: choice("cache", { c1: 0.95, none: 0.05 }) },
        };
      return {
        ok: true,
        calls: 0,
        questions: 0,
        cacheHits: Object.keys(questions).length,
        cacheRequests: Object.keys(questions).length,
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            { type: "bool", source: "cache", p: 0.95 },
          ]),
        ),
      };
    },
  };
  try {
    await writeFile(
      join(cwd, "billing.ts"),
      "compute monthly invoice proration before billing",
    );
    const output = await createFindFilesTool(
      dependencies(client, ["billing.ts"]),
    ).execute(
      "cache",
      { goal: "compute monthly invoice proration before billing" },
      undefined,
      undefined,
      { cwd },
    );
    const report = output.details.result;
    assert.deepEqual(validateResultReport(report), []);
    assert.equal(report.execution, "complete");
    assert.equal(report.accounting.requestedResults.cache, 1);
    assert.equal(report.accounting.auxiliary.passages.cache, 2);
    assert.equal(report.accounting.httpAttempts, 0);
    assert.deepEqual(
      report.context.effectiveRoot.status === "known"
        ? report.context.effectiveRoot.value.path
        : null,
      cwd,
    );
    const item = report.items[0];
    assert.ok(item);
    assert.equal(item.treatment, "judged");
    if (item.treatment !== "judged") throw Error("expected judgment");
    assert.equal(item.source, "cache");
    assert.equal(item.judgment.result, "billing.ts");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("locate distinguishes binary evidence from forbidden paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-report-binary-"));
  try {
    await writeFile(join(cwd, "large.bin"), Buffer.alloc(20_000));
    const output = await createLocateTool(
      dependencies(undefined, ["large.bin"]),
    ).execute(
      "binary",
      { path: "large.bin", goal: "where is evidence three" },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(
      output.details.result.diagnostics[0]?.cause,
      "binary_or_non_utf8",
    );
    assert.equal(output.details.result.items[0]?.treatment, "not_judged");
    assert.equal(output.details.result.accounting.httpAttempts, 0);
    assert.deepEqual(validateResultReport(output.details.result), []);
    const forbidden = await createLocateTool(
      dependencies(undefined, ["large.bin"]),
    ).execute(
      "forbidden",
      { path: "../outside", goal: "where is evidence three" },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(forbidden.details.result.execution, "refused");
    assert.equal(
      forbidden.details.result.diagnostics[0]?.cause,
      "forbidden_path",
    );
    assert.equal(forbidden.details.result.accounting.httpAttempts, 0);
    assert.deepEqual(validateResultReport(forbidden.details.result), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("forbidden find scope refuses before inventory collection", async () => {
  let collected = false;
  const deps = dependencies(
    {
      clearCache() {},
      async judge() {
        throw Error("unexpected judgment");
      },
    },
    [],
  );
  deps.exec = async () => {
    collected = true;
    throw Error("unexpected collection");
  };
  const output = await createFindFilesTool(deps).execute(
    "scope",
    {
      scope: "../outside",
      goal: "compute monthly invoice proration before billing",
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  assert.equal(collected, false);
  assert.equal(output.details.result.execution, "refused");
  assert.equal(output.details.result.diagnostics[0]?.cause, "forbidden_path");
});
