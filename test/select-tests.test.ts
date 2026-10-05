import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { collectTestInventory } from "../src/adapters/test-inventory.ts";
import type { ResultReportV1 } from "../src/core/result-report.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import { createJevClient } from "../src/jev/client.ts";
import type { JevClient, Question, State } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";
import { createSelectTestsTool } from "../src/tools/select-tests.ts";

const run = promisify(execFile);
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "jev-select-"));
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, "test"));
  const files: Record<string, string> = {
    "src/money.js":
      "export function money() { return 1; }\nexport function unused() { return 0; }\n",
    "src/invoice.js":
      "import {money} from './money.js'; import {format} from './format.js'; export function invoice(){ return format(money()); }\n",
    "src/format.js": "export function format(value){ return String(value); }\n",
    "test/money.test.js":
      "import {test} from 'node:test'; import {invoice} from '../src/invoice.js'; test('invoice total',()=>invoice());\n",
    "test/other.test.js":
      "import {test} from 'node:test'; test('unrelated',()=>1);\n",
  };
  for (const [path, text] of Object.entries(files))
    await writeFile(join(cwd, path), text);
  await run("git", ["init", "-q"], { cwd });
  await run("git", ["add", "."], { cwd });
  await run(
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
    { cwd },
  );
  await writeFile(
    join(cwd, "src/money.js"),
    "export function money() { return 2; }\nexport function unused() { return 3; }\n",
  );
  return cwd;
}
function dependencies(client: JevClient) {
  const host = detectHost({});
  return {
    client,
    host,
    runtime: { session: new Session({}), guide: new Guide(host) },
    exec: async (
      command: string,
      args: string[],
      options: { cwd: string; timeout: number; signal?: AbortSignal },
    ) => {
      try {
        const out = await run(command, args, {
          cwd: options.cwd,
          timeout: options.timeout,
          signal: options.signal,
        });
        return { ...out, code: 0, killed: false };
      } catch (error) {
        const e = error as {
          stdout?: string;
          stderr?: string;
          code?: number;
          killed?: boolean;
        };
        return {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
          code: e.code ?? 1,
          killed: e.killed ?? false,
        };
      }
    },
  };
}
function assertUncertainAbsence(result: ResultReportV1): void {
  assert.ok(
    result.diagnostics.some(
      (diagnostic) => diagnostic.cause === "control_failure",
    ),
  );
  assert.ok(
    result.items.some(
      (item) =>
        item.id.startsWith("coverage:") &&
        (item.treatment === "not_judged" ||
          (item.treatment === "judged" && item.judgment.band === "unsure")),
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.cause === "collection_omitted" &&
        diagnostic.scope.kind === "item",
    ),
  );
}
test("unit pointer past the option cap stays selected and names the cap", async () => {
  for (const count of [254, 255]) {
    const cwd = await mkdtemp(join(tmpdir(), "jev-select-cap-"));
    try {
      await mkdir(join(cwd, "src"));
      await mkdir(join(cwd, "test"));
      const lines = Array.from(
        { length: count },
        (_, i) => `export function f${i}() { return ${i}; }`,
      );
      await writeFile(join(cwd, "src/big.js"), `${lines.join("\n")}\n`);
      // Dynamic import on purpose: static reachability cannot name all
      // changed units, so the candidate keeps every diff unit and the
      // pointer faces the full option count.
      await writeFile(
        join(cwd, "test/big.test.js"),
        "import {test} from 'node:test';\ntest('big', async () => { const big = await import('../src/big.js'); return Object.keys(big).length; });\n",
      );
      await run("git", ["init", "-q"], { cwd });
      await run("git", ["add", "."], { cwd });
      await run(
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
        { cwd },
      );
      await writeFile(
        join(cwd, "src/big.js"),
        `${lines.map((line) => `${line} // changed`).join("\n")}\n`,
      );
      const asked: Question[] = [];
      const client: JevClient = {
        clearCache() {},
        async judge(_state, questions, options) {
          asked.push(...Object.values(questions));
          options?.beforeRequest?.(Object.keys(questions).length);
          return {
            ok: true,
            calls: 1,
            questions: Object.keys(questions).length,
            answers: Object.fromEntries(
              Object.entries(questions).map(([id, q]) => [
                id,
                q.type === "choice"
                  ? {
                      type: "choice",
                      choice: "none",
                      confidence: 0.9,
                      probabilities: { none: 0.9 },
                    }
                  : { type: "bool", p: 0.01 },
              ]),
            ),
          };
        },
      };
      const result = await createSelectTestsTool(dependencies(client)).execute(
        "cap",
        { base: "HEAD", witnesses: "off" },
        undefined,
        undefined,
        { cwd },
      );
      const text = result.content[0]?.text ?? "";
      assert.ok(
        asked.every(
          (q) => q.type !== "choice" || Object.keys(q.criteria).length <= 255,
        ),
        "no choice exceeds the cap including none",
      );
      if (count === 254) {
        assert.ok(
          asked.some(
            (q) =>
              q.type === "choice" && Object.keys(q.criteria).length === 255,
          ),
          "boundary pointer still judged",
        );
        assert.doesNotMatch(text, /choice option cap/);
      } else {
        assert.match(text, /choice option cap/);
        assert.match(text, /run:.*big\.test\.js/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
test("tracked ignored invalid workspace manifests cannot silently skip local bare imports", async () => {
  const cwd = await fixture();
  try {
    await mkdir(join(cwd, "packages/broken"), { recursive: true });
    await writeFile(join(cwd, ".gitignore"), "**/package.json\n");
    await writeFile(join(cwd, "packages/broken/package.json"), "invalid json");
    await writeFile(
      join(cwd, "test/money.test.js"),
      "import {test} from 'node:test'; import {money} from 'broken'; test('local package',()=>money());\n",
    );
    await run(
      "git",
      [
        "add",
        "-f",
        ".gitignore",
        "packages/broken/package.json",
        "test/money.test.js",
      ],
      { cwd },
    );
    await run(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "workspace configuration",
      ],
      { cwd },
    );
    await writeFile(
      join(cwd, "src/money.js"),
      "export function money() { return 4; }\nexport function unused() { return 0; }\n",
    );
    const states: State[] = [];
    const client: JevClient = {
      clearCache() {},
      async judge(state) {
        states.push(state);
        return {
          ok: false,
          error: "Offline recording client",
          calls: 0,
          questions: 0,
        };
      },
    };
    const result = await createSelectTestsTool(dependencies(client)).execute(
      "local-package",
      { base: "HEAD", paths: ["test/money.test.js"], witnesses: "off" },
      undefined,
      undefined,
      { cwd },
    );
    assert.ok(
      states.some((state) => {
        const file = state.testFile;
        return (
          file !== null &&
          typeof file === "object" &&
          !Array.isArray(file) &&
          file.path === "test/money.test.js"
        );
      }),
    );
    assert.ok(
      result.details.result.diagnostics.some(
        (diagnostic) =>
          diagnostic.cause === "dynamic_dependency" &&
          diagnostic.target.status === "known" &&
          diagnostic.target.value === "test/money.test.js",
      ),
    );
    assert.match(
      result.content[0]?.text ?? "",
      /node --test test\/money\.test\.js/,
    );
    assert.ok(
      states.every((state) => !JSON.stringify(state).includes("invalid json")),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("missing Vitest lockfiles do not turn a residual verdict into unsure", async () => {
  const cwd = await fixture();
  try {
    await writeFile(
      join(cwd, "test/money.test.js"),
      "import {test} from 'vitest'; import {invoice} from '../src/invoice.js'; test('invoice total',()=>invoice());\n",
    );
    await writeFile(
      join(cwd, "test/other.test.js"),
      "import {test} from 'vitest'; test('unrelated',()=>1);\n",
    );
    const client: JevClient = {
      clearCache() {},
      async judge(_state, questions) {
        return {
          ok: true,
          answers: Object.fromEntries(
            Object.entries(questions).map(([id, question]) => {
              if (question.type !== "choice")
                return [
                  id,
                  { type: "bool", source: "fresh" as const, p: 0.01 },
                ];
              const choice = Object.keys(question.criteria)[0];
              assert.ok(choice);
              return [
                id,
                {
                  type: "choice",
                  source: "fresh" as const,
                  choice,
                  confidence: 0.99,
                  probabilities: { [choice]: 0.99, none: 0.01 },
                },
              ];
            }),
          ),
          calls: 1,
          questions: Object.keys(questions).length,
        };
      },
    };
    const result = await createSelectTestsTool(dependencies(client)).execute(
      "no-lock",
      { base: "HEAD", witnesses: "off" },
      undefined,
      undefined,
      { cwd },
    );
    assert.ok(
      result.details.result.diagnostics.some(
        (diagnostic) =>
          diagnostic.target.status === "known" &&
          diagnostic.target.value === "src/money.js" &&
          diagnostic.effect === "reservation",
      ),
    );
    assert.ok(
      result.details.result.items
        .filter((item) => item.id.startsWith("coverage:"))
        .every(
          (item) =>
            item.treatment === "judged" && item.judgment.band === "verdict",
        ),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("selection sees unchanged intermediates, skips unreachable tests and checks residual exported units", async () => {
  const cwd = await fixture();
  const states: State[] = [];
  const asks: Record<string, Question>[] = [];
  const client: JevClient = {
    clearCache() {},
    async judge(state, questions, options) {
      states.push(state);
      asks.push(questions);
      options?.beforeRequest?.(Object.keys(questions).length);
      return {
        ok: true,
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, q]) => {
            if (q.type !== "choice")
              return [id, { type: "bool", source: "fresh" as const, p: 0.01 }];
            const choice = Object.keys(q.criteria)[0];
            assert.ok(choice);
            return [
              id,
              {
                type: "choice",
                source: "fresh" as const,
                choice,
                confidence: 0.99,
                probabilities: { [choice]: 0.99, none: 0.01 },
              },
            ];
          }),
        ),
        calls: 1,
        questions: Object.keys(questions).length,
      };
    },
  };
  try {
    const result = await createSelectTestsTool(dependencies(client)).execute(
      "1",
      { base: "HEAD", witnesses: "off" },
      undefined,
      undefined,
      { cwd },
    );
    assert.ok(
      result.details.result.items.some(
        (item) =>
          item.label === "test/money.test.js: invoice total" &&
          item.treatment === "judged" &&
          item.selection?.selected,
      ),
    );
    assert.ok(
      result.details.result.items.some(
        (item) =>
          item.label === "test/other.test.js: unrelated" &&
          item.treatment === "static" &&
          !item.selection?.selected,
      ),
    );
    assert.ok(
      result.details.result.diagnostics.some(
        (diagnostic) =>
          diagnostic.target.status === "known" &&
          diagnostic.target.value === "src/money.js" &&
          diagnostic.effect === "reservation",
      ),
    );
    assert.ok(
      states.some((state) =>
        JSON.stringify(state).includes("function invoice"),
      ),
    );
    assert.ok(
      states.every(
        (state) => !JSON.stringify(state).includes("function format"),
      ),
    );
    assert.ok(
      asks.some((group) => Object.values(group).some((q) => q.type === "bool")),
    );
    const filtered = await createSelectTestsTool(dependencies(client)).execute(
      "glob",
      { base: "HEAD", witnesses: "off", paths: ["test/**/money.test.js"] },
      undefined,
      undefined,
      { cwd },
    );
    assert.ok(
      filtered.details.result.items.some(
        (item) =>
          item.label === "test/money.test.js: invoice total" &&
          item.selection?.selected,
      ),
    );
    const filteredText = filtered.content[0]?.text ?? "";
    assert.match(filteredText, /command: node --test test\/money\.test\.js\n/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("pointer judges shown reachability: changed symbol absent from the test body", async () => {
  const cwd = await fixture();
  const states: State[] = [];
  const client: JevClient = {
    clearCache() {},
    async judge(state, questions, options) {
      states.push(state);
      options?.beforeRequest?.(Object.keys(questions).length);
      return {
        ok: true,
        calls: 1,
        questions: Object.keys(questions).length,
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, q]) => [
            id,
            q.type === "choice"
              ? {
                  type: "choice",
                  choice: "none",
                  confidence: 0.9,
                  probabilities: { none: 0.9 },
                }
              : { type: "bool", p: 0.01 },
          ]),
        ),
      };
    },
  };
  try {
    await createSelectTestsTool(dependencies(client)).execute(
      "1",
      { base: "HEAD", witnesses: "off" },
      undefined,
      undefined,
      { cwd },
    );
    const pointer = states.find((state) =>
      JSON.stringify(state.testFile ?? {}).includes("invoice total"),
    );
    assert.ok(pointer, "pointer batch carries the invoice scenario");
    const file = pointer.testFile;
    assert.ok(
      file && typeof file === "object" && !Array.isArray(file),
      "pointer batch carries a test file",
    );
    const body = file.text;
    assert.equal(typeof body, "string");
    if (typeof body !== "string") return;
    // The changed symbol never appears in the test body: only the
    // intermediate helper is named there.
    assert.match(body, /invoice/);
    assert.doesNotMatch(body, /money/);
    // Reachability computed in code puts the intermediate and the changed
    // unit into the same judged state, so the pointer reads shown code.
    const shown = JSON.stringify({
      imports: pointer.imports,
      changedUnits: pointer.changedUnits,
    });
    assert.match(shown, /function invoice/);
    assert.match(shown, /function money/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("selection reads the custom configuration referenced by the script", async () => {
  const cwd = await fixture();
  const client: JevClient = {
    clearCache() {},
    async judge() {
      return { ok: false, error: "offline" };
    },
  };
  try {
    await mkdir(join(cwd, "checks"));
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run --config checks/custom.ts" },
      }),
    );
    await writeFile(
      join(cwd, "checks/custom.ts"),
      "export default { test: { include: ['*.check.js'] } };\n",
    );
    await writeFile(
      join(cwd, "checks/money.check.js"),
      "import {test} from 'vitest'; import {money} from '../src/money.js'; test('custom money',()=>money());\n",
    );
    const result = await createSelectTestsTool(dependencies(client)).execute(
      "custom-config",
      { base: "HEAD", witnesses: "off" },
      undefined,
      undefined,
      { cwd },
    );
    const text = result.content[0]?.text;
    assert.ok(text);
    assert.match(text, /checks\/money\.check\.js/);
    assert.match(
      text,
      /command: .*vitest.*--config.*custom\.ts.*money\.check\.js/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("unavailable Jev selects all candidates, while max_calls zero reports unjudged and does not claim a gap", async () => {
  const cwd = await fixture();
  const client: JevClient = {
    clearCache() {},
    async judge() {
      return { ok: false, error: "offline" };
    },
  };
  try {
    const result = await createSelectTestsTool(dependencies(client)).execute(
      "1",
      { base: "HEAD", witnesses: "off" },
      undefined,
      undefined,
      { cwd },
    );
    assert.ok(
      result.details.result.items.some(
        (item) =>
          item.selection?.reason === "conservative_fallback" &&
          item.selection.selected,
      ),
    );
    assert.equal(result.details.result.accounting.requestedResults.fresh, 0);
    const capped = await createSelectTestsTool(dependencies(client)).execute(
      "2",
      { base: "HEAD", max_calls: 0, witnesses: "off" },
      undefined,
      undefined,
      { cwd },
    );
    assert.ok(
      capped.details.result.items.some(
        (item) => item.treatment === "not_judged" && item.selection?.selected,
      ),
    );
    assert.equal(capped.details.result.accounting.requestedResults.fresh, 0);
    assert.match(capped.content[0]?.text ?? "", /run:.*money\.test\.js/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tracked test file beyond state budget is judged in complete scenario slices", async () => {
  const cwd = await fixture();
  const states: State[] = [];
  const body = "x".repeat(41000);
  const text = `import {test} from 'node:test';\nimport {invoice} from '../src/invoice.js';\nconst seed=7;\ntest('first',()=>{const data='${body}'; invoice();});\ntest('second',()=>{const data='${body}'; invoice();});\n`;
  const client: JevClient = {
    clearCache() {},
    async judge(state, questions, options) {
      states.push(state);
      options?.beforeRequest?.(Object.keys(questions).length);
      return {
        ok: true,
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, q]) => [
            id,
            q.type === "choice"
              ? {
                  type: "choice",
                  source: "fresh" as const,
                  choice: "u001",
                  confidence: 1,
                  probabilities: { u001: 1, none: 0 },
                }
              : { type: "bool", source: "fresh" as const, p: 1 },
          ]),
        ),
        calls: 1,
        questions: Object.keys(questions).length,
      };
    },
  };
  try {
    await writeFile(join(cwd, "test/money.test.js"), text);
    await run("git", ["add", "test/money.test.js"], { cwd });
    await run(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "large test base",
      ],
      { cwd },
    );
    const result = await createSelectTestsTool(dependencies(client)).execute(
      "large",
      { base: "HEAD", witnesses: "off" },
      undefined,
      undefined,
      { cwd },
    );
    for (const name of ["first", "second"])
      assert.ok(
        result.details.result.items.some(
          (item) =>
            item.label === `test/money.test.js: ${name}` &&
            item.treatment === "judged" &&
            item.selection?.selected,
        ),
      );
    assert.ok(states.every((state) => JSON.stringify(state).length <= 80000));
    for (const state of states) {
      assert.match(JSON.stringify(state), /seed=7/);
      assert.ok(JSON.stringify(state).includes(body));
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("inventory excludes ignored tracked files and symlink ancestors", async () => {
  const cwd = await fixture();
  const external = await mkdtemp(join(tmpdir(), "jev-outside-"));
  try {
    await writeFile(join(cwd, ".gitignore"), "src/money.js\n");
    await writeFile(join(external, "invoice.js"), "SECRET_OUTSIDE_REPOSITORY");
    await rm(join(cwd, "src"), { recursive: true });
    await symlink(external, join(cwd, "src"));
    const inventory = await collectTestInventory(
      dependencies({
        clearCache() {},
        async judge() {
          return { ok: false, error: "unused" };
        },
      }).exec,
      cwd,
    );
    assert.ok(inventory.ok);
    assert.equal(await inventory.read("src/money.js"), undefined);
    assert.equal(await inventory.read("src/invoice.js"), undefined);
    assert.ok(
      inventory.limits.some(
        (limit) =>
          limit.path === "src/invoice.js" && limit.kind === "unreadable",
      ),
    );
    const reached = await Promise.all(inventory.paths.map(inventory.read));
    assert.ok(
      reached.every(
        (file) => !file?.text.includes("SECRET_OUTSIDE_REPOSITORY"),
      ),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("failed coverage witnesses mark absence unsure and never become test selections", async () => {
  const cwd = await fixture();
  let witnessCalls = 0;
  const client: JevClient = {
    clearCache() {},
    async judge(_state, questions, options) {
      options?.beforeRequest?.(Object.keys(questions).length);
      if (Object.keys(questions).some((id) => id.startsWith("coverage_")))
        witnessCalls++;
      return {
        ok: true,
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, q]) => [
            id,
            q.type === "choice"
              ? {
                  type: "choice",
                  source: "fresh" as const,
                  choice: "none",
                  confidence: 1,
                  probabilities: { none: 1 },
                }
              : { type: "bool", source: "fresh" as const, p: 0 },
          ]),
        ),
        calls: 1,
        questions: Object.keys(questions).length,
      };
    },
  };
  try {
    const result = await createSelectTestsTool(dependencies(client)).execute(
      "witness",
      { base: "HEAD", witnesses: "on" },
      undefined,
      undefined,
      { cwd },
    );
    assert.ok(witnessCalls > 0);
    assertUncertainAbsence(result.details.result);
    assert.doesNotMatch(result.content[0]?.text ?? "", /command:/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("uncertain questions cite present units and witnesses use distinct ids", async () => {
  const cwd = await fixture();
  let checked = 0;
  const client: JevClient = {
    clearCache() {},
    async judge(state, questions, options) {
      const units = state.changedUnits as { id: string }[];
      const ids = units.map((unit) => unit.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(
        ids.some((id) => id.startsWith("w")) || !options?.witnesses?.length,
      );
      for (const question of Object.values(questions)) {
        if (question.type === "bool") {
          const id = question.instructions.match(/unit ([uw]\d+)/)?.[1];
          if (id) {
            assert.ok(ids.includes(id), `absent ${id}`);
            checked++;
          }
        }
      }
      options?.beforeRequest?.(Object.keys(questions).length);
      return {
        ok: true,
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, q]) => [
            id,
            q.type === "choice"
              ? {
                  type: "choice",
                  source: "fresh" as const,
                  choice: "none",
                  confidence: 1,
                  probabilities: { none: 1 },
                }
              : { type: "bool", source: "fresh" as const, p: 0 },
          ]),
        ),
        calls: 1,
        questions: Object.keys(questions).length,
      };
    },
  };
  try {
    await writeFile(
      join(cwd, "src/invoice.js"),
      "import {money} from './money.js'; export function invoice(){ import(process.env.PATH); return money(); }\n",
    );
    const result = await createSelectTestsTool(dependencies(client)).execute(
      "state",
      { base: "HEAD", witnesses: "on" },
      undefined,
      undefined,
      { cwd },
    );
    const limits = (result.content[0]?.text ?? "")
      .split("\n")
      .filter((line) => line.startsWith("["));
    assert.equal(new Set(limits).size, limits.length);
    assert.ok(checked > 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("healthy residual coverage selects tests and unhealthy coverage never hides absence", async () => {
  for (const healthy of [true, false]) {
    const cwd = await fixture();
    const client: JevClient = {
      clearCache() {},
      async judge(_state, questions, options) {
        options?.beforeRequest?.(Object.keys(questions).length);
        return {
          ok: true,
          answers: Object.fromEntries(
            Object.entries(questions).map(([id, q]) => [
              id,
              q.type === "choice"
                ? {
                    type: "choice",
                    source: "fresh" as const,
                    choice: "none",
                    confidence: 1,
                    probabilities: { none: 1 },
                  }
                : {
                    type: "bool",
                    source: "fresh" as const,
                    p: id.startsWith("coverage_")
                      ? healthy
                        ? q.instructions.includes("decoy")
                          ? 0
                          : 1
                        : 0
                      : 0.99,
                  },
            ]),
          ),
          calls: 1,
          questions: Object.keys(questions).length,
        };
      },
    };
    try {
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "node --test" } }),
      );
      const result = await createSelectTestsTool(dependencies(client)).execute(
        "residual",
        { base: "HEAD", witnesses: healthy ? "off" : "on" },
        undefined,
        undefined,
        { cwd },
      );
      const text = result.content[0]?.text;
      assert.ok(text);
      if (healthy) assert.match(text, /command:.*money\.test\.js/);
      else {
        assertUncertainAbsence(result.details.result);
        assert.doesNotMatch(result.content[0]?.text ?? "", /command:/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("selection compares with the shared ancestor, not changes only on main", async () => {
  const cwd = await fixture();
  try {
    await run("git", ["checkout", "-qb", "feature"], { cwd });
    await run(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qam",
        "feature",
      ],
      { cwd },
    );
    await run("git", ["checkout", "-qb", "advanced", "HEAD~1"], { cwd });
    await writeFile(
      join(cwd, "test/other.test.js"),
      "import {test} from 'node:test'; test('main only',()=>2);\n",
    );
    await run(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qam",
        "main",
      ],
      { cwd },
    );
    await run("git", ["checkout", "feature"], { cwd });
    const client: JevClient = {
      clearCache() {},
      async judge(_state, questions, options) {
        options?.beforeRequest?.(Object.keys(questions).length);
        return {
          ok: true,
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "bool" as const, p: 0.01 },
            ]),
          ),
          calls: 1,
          questions: Object.keys(questions).length,
        };
      },
    };
    const result = await createSelectTestsTool(dependencies(client)).execute(
      "behind",
      { base: "advanced", witnesses: "off" },
      undefined,
      undefined,
      { cwd },
    );
    assert.ok(
      !result.content[0]?.text
        .split("\n")
        .some(
          (line) => line.startsWith("run:") && line.includes("other.test.js"),
        ),
    );
    assert.ok(
      result.content[0]?.text
        .split("\n")
        .some(
          (line) => line.startsWith("run:") && line.includes("money.test.js"),
        ),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shallow selection refuses with history recovery actions before judgment", async () => {
  const origin = await fixture();
  const parent = await mkdtemp(join(tmpdir(), "jev-shallow-"));
  const cwd = join(parent, "clone");
  try {
    await run("git", ["checkout", "-qb", "feature"], { cwd: origin });
    await run(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qam",
        "feature",
      ],
      { cwd: origin },
    );
    await run("git", ["branch", "advanced", "HEAD~1"], { cwd: origin });
    await run("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      "feature",
      `file://${origin}`,
      cwd,
    ]);
    await run(
      "git",
      [
        "fetch",
        "--depth",
        "1",
        "origin",
        "advanced:refs/remotes/origin/advanced",
      ],
      { cwd },
    );
    let judgments = 0;
    const client: JevClient = {
      clearCache() {},
      async judge() {
        judgments++;
        return { ok: false, error: "unexpected judgment" };
      },
    };
    const result = await createSelectTestsTool(dependencies(client)).execute(
      "shallow",
      { base: "origin/advanced", witnesses: "off" },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(judgments, 0);
    assert.match(result.content[0]?.text ?? "", /history.*truncated/);
    assert.match(result.content[0]?.text ?? "", /git fetch --unshallow/);
    assert.match(result.content[0]?.text ?? "", /--deepen/);
    assert.match(result.content[0]?.text ?? "", /ancestor of HEAD/);
  } finally {
    await rm(origin, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("one tool instance refreshes new files and changed ignore rules between calls", async () => {
  const cwd = await fixture();
  try {
    const client: JevClient = {
      clearCache() {},
      async judge() {
        return { ok: false, error: "offline" };
      },
    };
    const tool = createSelectTestsTool(dependencies(client));
    const call = () =>
      tool.execute(
        "refresh",
        { witnesses: "off", max_calls: 0 },
        undefined,
        undefined,
        { cwd },
      );
    await call();
    await writeFile(
      join(cwd, "test/fresh.test.js"),
      "import {test} from 'node:test'; import {money} from '../src/money.js'; test('fresh',()=>money());\n",
    );
    const fresh = await call();
    assert.ok(
      fresh.content[0]?.text
        .split("\n")
        .some(
          (line) => line.startsWith("run:") && line.includes("fresh.test.js"),
        ),
    );
    await writeFile(join(cwd, ".gitignore"), "test/fresh.test.js\n");
    const ignored = await call();
    assert.ok(!ignored.content[0]?.text.includes("fresh.test.js"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("invalid UTF-8 changed source keeps dependent tests selected without judgment", async () => {
  const cwd = await fixture();
  try {
    await writeFile(
      join(cwd, "src/money.js"),
      Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    );
    const client: JevClient = {
      clearCache() {},
      async judge() {
        throw new Error("Unreadable source must not be judged");
      },
    };
    const result = await createSelectTestsTool(dependencies(client)).execute(
      "utf8",
      { base: "HEAD", witnesses: "off" },
      undefined,
      undefined,
      { cwd },
    );
    const text = result.content[0]?.text ?? "";
    assert.match(
      text,
      /unjudged.*test\/money\.test\.js|test\/money\.test\.js.*unjudged/,
    );
    assert.match(text, /run:.*command: node --test[^\n]*test\/money\.test\.js/);
    assert.match(text, /not UTF-8 text/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("real client batches reject residual coverage when a decoy fails", async () => {
  const cwd = await fixture();
  const client = createJevClient(
    { url: "http://simulated", apiKey: "test", model: "openjev" },
    {
      fetch: async (_url, options) => {
        const request = JSON.parse(String(options?.body));
        const answers = Object.fromEntries(
          Object.entries(request.questions).map(([id, raw]) => {
            const question = raw as { type: string };
            return [
              id,
              question.type === "noul"
                ? {
                    type: "noul",
                    noul: id.startsWith("coverage_") ? 0.95 : 0.6,
                  }
                : {
                    type: "choice",
                    source: "fresh" as const,
                    choice: "none",
                    probabilities: { none: 1 },
                    confidence: 1,
                  },
            ];
          }),
        );
        return new Response(JSON.stringify({ answers }), { status: 200 });
      },
    },
  );
  try {
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    const result = await createSelectTestsTool(dependencies(client)).execute(
      "real-controls",
      { base: "HEAD", witnesses: "on" },
      undefined,
      undefined,
      { cwd },
    );
    assertUncertainAbsence(result.details.result);
    assert.doesNotMatch(result.content[0]?.text ?? "", /command:/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("production residual batches enforce the coverage cap and reference floor", async () => {
  for (const mode of ["cap", "over", "reference", "missing"] as const) {
    const cwd = await fixture();
    const client = createJevClient(
      { url: "http://simulated", apiKey: "test", model: "openjev" },
      {
        fetch: async (_url, options) => {
          const request = JSON.parse(String(options?.body));
          const units = request.state.changedUnits as {
            id: string;
            name: string;
            file: string;
            after: string;
          }[];
          const controls = units.filter((u) =>
            [
              "normalize",
              "formatLine",
              "MAX_ITEMS",
              "formatPrice",
              "increment",
              "LIMIT",
            ].includes(u.name),
          );
          if (controls.length) {
            const file = request.state.testFile as {
              text: string;
              path: string;
            };
            assert.doesNotMatch(file.text, /Synthetic coverage controls/);
            assert.match(file.text, /formatMoney\(2\)/);
            assert.equal(request.state.witnessTestFile, undefined);
            const decoy = controls.find((u) => u.name === "normalize");
            assert.ok(decoy);
            assert.notEqual(decoy.file, file.path);
            assert.doesNotMatch(file.text, /normalize|src\/normalize\.js/);
          }
          const answers = Object.fromEntries(
            Object.entries(request.questions).flatMap<
              [string, Record<string, unknown>]
            >(([id, raw]) => {
              const q = raw as { type: string };
              if (q.type !== "noul")
                return [
                  [
                    id,
                    {
                      type: "choice",
                      source: "fresh" as const,
                      choice: "none",
                      confidence: 1,
                      probabilities: { none: 1 },
                    },
                  ],
                ];
              const unit = controls.find((u) => id === `coverage_${u.id}`);
              if (unit?.name === "normalize" && mode === "missing") return [];
              const reference =
                unit &&
                ["increment", "formatPrice", "LIMIT"].includes(unit.name);
              const p = unit
                ? reference
                  ? mode === "reference"
                    ? 0.699
                    : 0.7
                  : mode === "over"
                    ? 0.201
                    : 0.2
                : 0.99;
              return [[id, { type: "noul", noul: p }]];
            }),
          );
          return new Response(JSON.stringify({ answers }), { status: 200 });
        },
      },
    );
    try {
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "node --test" } }),
      );
      const result = await createSelectTestsTool(dependencies(client)).execute(
        "cap",
        { base: "HEAD", witnesses: "on" },
        undefined,
        undefined,
        { cwd },
      );
      const text = result.content[0]?.text ?? "";
      if (mode === "cap") {
        assert.match(text, /command:.*money\.test\.js/);
        assert.doesNotMatch(
          text,
          /set-up check failed|witness control unavailable/,
        );
      } else {
        assertUncertainAbsence(result.details.result);
        assert.doesNotMatch(result.content[0]?.text ?? "", /command:/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
