import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectSearchExcerpts } from "../src/adapters/files.ts";
import { prefilter } from "../src/adapters/find.ts";
import {
  contentWords,
  createExcerptCollector,
  pathAllowed,
  retainFiles,
} from "../src/core/find.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { Answer, JevClient } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";
import { createFindFilesTool } from "../src/tools/find.ts";

test("an empty scope returns not judged without asking Jev", async () => {
  const client: JevClient = {
    clearCache() {},
    async judge() {
      throw new Error("No candidates must not reach Jev");
    },
  };
  const host = detectHost({});
  const tool = createFindFilesTool({
    client,
    host,
    runtime: { session: new Session({}), guide: new Guide(host) },
    exec: async (_command, args) => ({
      stdout: args.includes("-t") ? "H src/billing.ts\0" : "src/billing.ts\0",
      stderr: "",
      code: 0,
      killed: false,
    }),
  });
  const output = await tool.execute(
    "id",
    {
      goal: "compute monthly invoice proration before billing",
      scope: "absent",
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  assert.equal(output.details.result.execution, "not_judged");
  assert.equal(output.details.result.items[0]?.treatment, "not_judged");
  assert.equal(output.details.result.diagnostics[0]?.cause, "collection_empty");
});
test("keyword excerpts preserve Unicode and retain the dense passage", () => {
  const text =
    "header\n" +
    "irrelevant😀\n".repeat(500) +
    "proration invoice billing\n".repeat(20);
  const collector = createExcerptCollector(
    ["proration", "invoice", "billing"],
    1500,
  );
  collector.push(text);
  const excerpt = collector.finish();
  assert.ok(excerpt.length <= 1500);
  assert.match(excerpt, /proration invoice billing/u);
  assert.equal(excerpt.isWellFormed(), true);
});
test("names guard restores only high ranking names that were actually read", () => {
  assert.deepEqual(
    retainFiles(
      [
        { path: "watch.ts", p: 0.46 },
        { path: "other.ts", p: 0.7 },
      ],
      [{ path: "watch.ts", p: 0.93 }],
    ),
    [
      { path: "other.ts", p: 0.7 },
      { path: "watch.ts", p: 0.46 },
    ],
  );
  assert.deepEqual(retainFiles([], [{ path: "watch.ts", p: 0.93 }]), []);
});
test("goal content words ignore stop words and scopes respect directory boundaries", () => {
  assert.deepEqual(
    contentWords("where does the code compute invoice proration"),
    ["compute", "invoice", "proration"],
  );
  assert.equal(pathAllowed("src-other/file.ts", "src"), false);
  assert.equal(pathAllowed("test/file.ts", undefined, ["test/**"]), false);
  assert.equal(
    pathAllowed("src/file.test.ts", undefined, ["**/*.test.ts"]),
    false,
  );
});
for (const scenario of [
  {
    name: "high probability verdict",
    goal: "compute monthly invoice proration before billing",
    first: { "a.ts": 0.9, "b.ts": 0.08, none: 0.02 },
    second: undefined,
    mark: "entry: a.ts",
    calls: 3,
  },
  {
    name: "short goal cannot yield a verdict despite keywords",
    goal: "invoice proration",
    first: { "a.ts": 0.9, "b.ts": 0.08, none: 0.02 },
    second: undefined,
    calls: 3,
  },
  {
    name: "agreement at confirmation boundary",
    goal: "compute monthly invoice proration before billing",
    first: { "a.ts": 0.79, "b.ts": 0.2, none: 0.01 },
    second: { "a.ts": 0.81, "b.ts": 0.18, none: 0.01 },
    mark: "entry: a.ts (0.80)",
    calls: 4,
  },
  {
    name: "two orders disagree",
    goal: "compute monthly invoice proration before billing",
    first: { "a.ts": 0.7, "b.ts": 0.29, none: 0.01 },
    second: { "a.ts": 0.2, "b.ts": 0.79, none: 0.01 },
    calls: 4,
  },
  {
    name: "none remains a real pointer option",
    goal: "compute monthly invoice proration before billing",
    first: { "a.ts": 0.05, "b.ts": 0.05, none: 0.9 },
    second: undefined,
    mark: "entry: none",
    calls: 3,
  },
  {
    name: "quick never requests the second order",
    goal: "compute monthly invoice proration before billing",
    first: { "a.ts": 0.79, "b.ts": 0.2, none: 0.01 },
    second: undefined,
    effort: "quick" as const,
    calls: 3,
  },
  {
    name: "thorough confirms even a high first probability",
    goal: "compute monthly invoice proration before billing",
    first: { "a.ts": 0.9, "b.ts": 0.09, none: 0.01 },
    second: { "a.ts": 0.92, "b.ts": 0.07, none: 0.01 },
    effort: "thorough" as const,
    mark: "entry: a.ts",
    calls: 4,
  },
])
  test(scenario.name, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jev-find-"));
    try {
      await Promise.all(
        ["a.ts", "b.ts"].map((path) =>
          writeFile(join(cwd, path), "invoice proration billing"),
        ),
      );
      let calls = 0;
      const client: JevClient = {
        clearCache() {},
        async judge(state, questions, options) {
          const admission = options?.beforeRequest?.(
            Object.keys(questions).length,
          );
          if (admission && !admission.ok)
            return {
              ok: true,
              answers: Object.fromEntries(
                Object.keys(questions).map((id) => [
                  id,
                  { type: "unjudged", reason: admission.error },
                ]),
              ),
            };
          calls++;
          if (state.candidates) {
            const candidates = state.candidates as {
              id: string;
              path: string;
              excerpt: string;
            }[];
            assert.equal(
              candidates.every((item) => item.excerpt.includes("invoice")),
              true,
            );
            const paths = candidates.map((item) => item.path);
            assert.deepEqual(
              paths,
              calls === 3 ? ["a.ts", "b.ts"] : ["b.ts", "a.ts"],
            );
            // Options are joined to state.candidates by id alone, so each one
            // must name its own path or the judge sees two anonymous options.
            // The reverse order reorders options but keeps each id on its path.
            const entry = questions.entry as {
              type: string;
              criteria: Record<string, string>;
            };
            assert.equal(entry.type, "choice");
            const pathById = new Map(
              candidates.map((item) => [item.id, item.path]),
            );
            const named = Object.entries(entry.criteria).filter(
              ([id]) => id !== "none",
            );
            assert.equal(named.length, paths.length);
            for (const [id, label] of named)
              assert.ok(
                label.endsWith(String(pathById.get(id))),
                `option ${id} does not name ${pathById.get(id)}`,
              );
            const probabilities =
              calls === 3 ? scenario.first : scenario.second;
            assert.ok(probabilities);
            return {
              ok: true,
              calls: 1,
              questions: 1,
              answers: {
                entry: {
                  type: "choice",
                  source: "fresh",
                  choice: "c1",
                  confidence: 0.99,
                  probabilities: Object.fromEntries(
                    Object.entries(probabilities).map(([path, p]) => [
                      path === "a.ts" ? "c1" : path === "b.ts" ? "c2" : "none",
                      p,
                    ]),
                  ),
                },
              },
            };
          }
          const answers: Record<string, Answer> = Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "bool", source: "fresh", p: id === "a.ts" ? 0.95 : 0.6 },
            ]),
          );
          return {
            ok: true,
            calls: 1,
            questions: Object.keys(questions).length,
            answers,
          };
        },
      };
      const host = detectHost({});
      const tool = createFindFilesTool({
        client,
        host,
        runtime: { session: new Session({}), guide: new Guide(host) },
        exec: async (command, args) => ({
          stdout:
            command === "git"
              ? args.includes("-t")
                ? "H a.ts\0H b.ts\0"
                : "a.ts\0b.ts\0"
              : "./a.ts\0./b.ts\0",
          stderr: "",
          code: 0,
          killed: false,
        }),
      });
      const result = await tool.execute(
        "id",
        {
          goal: scenario.goal,
          effort: "effort" in scenario ? scenario.effort : undefined,
          keywords: [
            "invoice",
            "proration",
            "monthly",
            "billing",
            "computation",
          ],
        },
        undefined,
        undefined,
        { cwd },
      );
      const text = result.content[0]?.text ?? "";
      const item = result.details.result.items[0];
      assert.ok(item);
      assert.equal(item.treatment, "judged");
      if (item.treatment === "judged") {
        assert.equal(
          item.judgment.result,
          scenario.mark?.includes("none")
            ? "none"
            : scenario.name === "two orders disagree"
              ? "b.ts"
              : "a.ts",
        );
        assert.equal(item.judgment.band, scenario.mark ? "verdict" : "unsure");
        if (scenario.name === "two orders disagree")
          assert.equal(item.judgment.controls[0]?.outcome, "order-dependent");
        if (item.judgment.result === "none") {
          const action = result.details.result.actions.find((action) =>
            item.actionIds.includes(action.id),
          );
          assert.ok(action);
          assert.equal(action.code, "inspect_native");
          assert.match(action.instruction, /search elsewhere/i);
          assert.equal(action.repeatUnchanged, false);
        }
      }
      assert.equal(calls, scenario.calls);
      assert.match(text, /auxiliary ranking/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
test("discovery reads a 200 KB file with relevant evidence in the middle and ignores binaries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-excerpt-"));
  try {
    await writeFile(
      join(cwd, "large.ts"),
      "unrelated😀\n".repeat(10000) +
        "invoice proration billing\n".repeat(15) +
        "unrelated😀\n".repeat(10000),
    );
    await writeFile(join(cwd, "binary.dat"), Buffer.from([1, 0, 2]));
    const result = await collectSearchExcerpts(
      cwd,
      ["large.ts", "binary.dat", "missing.ts"],
      ["invoice", "proration", "billing"],
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual([...result.ignored].sort(), ["binary.dat", "missing.ts"]);
    for (const excerpt of [
      result.files["large.ts"] ?? "",
      result.pointers["large.ts"] ?? "",
    ]) {
      assert.match(excerpt, /invoice proration billing/u);
      assert.equal(excerpt.isWellFormed(), true);
    }
    assert.ok((result.files["large.ts"]?.length ?? Infinity) <= 3000);
    assert.ok((result.pointers["large.ts"]?.length ?? Infinity) <= 1500);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("fallback lexical search ranks path matches above content and honors killed before exit code", async () => {
  const result = await prefilter(
    async (command) => ({
      stdout:
        command === "git"
          ? "src/invoice.ts\0src/other.ts\0test/invoice.ts\0src/.env\0src/.env.example\0"
          : "./src/other.ts\0",
      stderr: "",
      code: 0,
      killed: false,
    }),
    process.cwd(),
    ["invoice"],
    10,
    "src",
    undefined,
    undefined,
    false,
  );
  assert.deepEqual(result, {
    ok: true,
    paths: ["src/invoice.ts", "src/other.ts"],
    scopeFiles: 3,
    secret: ["src/.env"],
  });
  const killed = await prefilter(
    async () => ({ stdout: "", stderr: "", code: 0, killed: true }),
    process.cwd(),
    ["invoice"],
    10,
    undefined,
    undefined,
    undefined,
    false,
  );
  assert.equal(killed.ok, false);
});
test("max_calls stops the cascade and preserves names as unsure", async () => {
  const host = detectHost({});
  let requests = 0;
  const client: JevClient = {
    clearCache() {},
    async judge(_state, questions, options) {
      const admission = options?.beforeRequest?.(Object.keys(questions).length);
      if (admission && !admission.ok)
        return {
          ok: true,
          answers: Object.fromEntries(
            Object.keys(questions).map((path) => [
              path,
              {
                type: "unjudged",
                reason: admission.error,
                cause: "call_budget",
              },
            ]),
          ),
        };
      requests++;
      return {
        ok: true,
        calls: 1,
        questions: Object.keys(questions).length,
        answers: Object.fromEntries(
          Object.keys(questions).map((path) => [
            path,
            { type: "bool", source: "fresh", p: 0.95 },
          ]),
        ),
      };
    },
  };
  const cwd = await mkdtemp(join(tmpdir(), "jev-budget-"));
  try {
    await writeFile(join(cwd, "a.ts"), "billing computation");
    const tool = createFindFilesTool({
      client,
      host,
      runtime: { session: new Session({}), guide: new Guide(host) },
      exec: async (_command, args) => ({
        stdout: args.includes("-t") ? "H a.ts\0" : "a.ts\0",
        stderr: "",
        code: 0,
        killed: false,
      }),
    });
    const result = await tool.execute(
      "id",
      {
        goal: "compute monthly invoice proration before billing",
        max_calls: 1,
      },
      undefined,
      undefined,
      { cwd },
    );
    const report = result.details.result;
    assert.equal(report.execution, "not_judged");
    assert.equal(report.items[0]?.treatment, "not_judged");
    assert.equal(report.accounting.httpAttempts, 1);
    const budget = report.diagnostics.find(
      (diagnostic) => diagnostic.cause === "call_budget",
    );
    assert.ok(budget);
    assert.deepEqual(budget.omittedMembers, ["a.ts"]);
    assert.deepEqual(budget.memberCount, { status: "known", value: 1 });
    assert.ok(report.actions.every((action) => !action.repeatUnchanged));
    assert.equal(requests, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("missing rg is refused rather than mistaken for no content matches", async () => {
  const result = await prefilter(
    async (command) =>
      command === "git"
        ? { stdout: "a.ts\0", stderr: "", code: 0, killed: false }
        : {
            stdout: "",
            stderr: "",
            code: 1,
            killed: false,
          },
    process.cwd(),
    ["billing"],
    10,
    undefined,
    undefined,
    undefined,
    false,
  );
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.equal(result.error, "rg is required when fff is unavailable");
});
test("names guard adds only one candidate and keeps the pointer bounded", () => {
  const content = Array.from({ length: 10 }, (_, index) => ({
    path: `f${index}`,
    p: index < 8 ? 0.8 : 0.2,
  }));
  const retained = retainFiles(content, [
    { path: "f8", p: 0.95 },
    { path: "f9", p: 0.94 },
  ]);
  assert.equal(retained.length, 8);
  assert.equal(
    retained.some((file) => file.path === "f8"),
    true,
  );
  assert.equal(
    retained.some((file) => file.path === "f9"),
    false,
  );
});
test("zero lexical overlap returns no candidates rather than arbitrary files", async () => {
  const result = await prefilter(
    async (_command, args) => ({
      stdout: args[0] === "ls-files" ? "src/a.ts\0" : "",
      stderr: "",
      code: args[0] === "--version" || args[0] === "ls-files" ? 0 : 1,
      killed: false,
    }),
    process.cwd(),
    ["billing"],
    10,
    undefined,
    undefined,
    undefined,
    false,
  );
  assert.deepEqual(result, { ok: true, paths: [], scopeFiles: 1, secret: [] });
});
test("dense window excludes the header instead of repeating it", () => {
  const collector = createExcerptCollector(["billing"], 1500);
  collector.push(`billing HEADER\n${"x".repeat(1000)}TAIL${"y".repeat(4000)}`);
  const excerpt = collector.finish();
  assert.equal(excerpt.split("HEADER").length, 2);
  assert.match(excerpt, /TAIL/u);
});
test("symbolic links never expose external file contents", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-links-"));
  const outside = await mkdtemp(join(tmpdir(), "jev-secret-"));
  try {
    await writeFile(join(outside, "secret"), "SECRET_TOKEN_NEVER_SENT");
    await symlink(join(outside, "secret"), join(cwd, "link"));
    await symlink(outside, join(cwd, "dir"));
    const result = await collectSearchExcerpts(
      cwd,
      ["link", "dir/secret"],
      ["SECRET"],
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.ignored, ["dir/secret"]);
    assert.equal(result.files.link, join(outside, "secret"));
    assert.equal(
      JSON.stringify(result.files).includes("SECRET_TOKEN_NEVER_SENT"),
      false,
    );
  } finally {
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
test("a singleton pointer never requests another order even in thorough mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-single-"));
  try {
    await writeFile(join(cwd, "billing.ts"), "billing computation");
    let pointers = 0;
    const client: JevClient = {
      clearCache() {},
      async judge(state, questions) {
        if (state.candidates) {
          pointers++;
          return {
            ok: true,
            answers: {
              entry: {
                type: "choice",
                source: "fresh",
                choice: "c1",
                confidence: 0.6,
                probabilities: { c1: 0.6, none: 0.4 },
              },
            },
          };
        }
        return {
          ok: true,
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "bool", source: "fresh", p: 0.95 },
            ]),
          ),
        };
      },
    };
    const host = detectHost({});
    const tool = createFindFilesTool({
      client,
      host,
      runtime: { session: new Session({}), guide: new Guide(host) },
      exec: async (_command, args) => ({
        stdout: args.includes("-t") ? "H billing.ts\0" : "billing.ts\0",
        stderr: "",
        code: 0,
        killed: false,
      }),
    });
    const result = await tool.execute(
      "id",
      {
        goal: "compute monthly invoice proration before billing",
        effort: "thorough",
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(pointers, 1);
    const item = result.details.result.items[0];
    assert.ok(item);
    assert.equal(item.treatment, "judged");
    if (item.treatment === "judged") assert.equal(item.judgment.band, "unsure");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
