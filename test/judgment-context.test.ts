import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withEvidenceContext } from "../src/adapters/evidence-context.ts";
import { spawnExec } from "../src/adapters/exec.ts";
import { STATE_MAX_CHARS } from "../src/constants.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import { createJevClient } from "../src/jev/client.ts";
import type { State } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";
import { createAskFilesTool } from "../src/tools/ask-files.ts";
import { createCheckDiffTool } from "../src/tools/check-diff.ts";
import { createFindFilesTool } from "../src/tools/find.ts";
import { createLocateTool } from "../src/tools/locate.ts";
import { createSelectTestsTool } from "../src/tools/select-tests.ts";

const large = Array.from(
  { length: 7 },
  (_, i) =>
    `# Evidence ${i}\n\n${(`invoice proration section ${i} ${"x".repeat(300)}\n`).repeat(12)}`,
).join("\n");

test("all evidence producers isolate real session cache across registered roots and resolved bases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-judgment-context-"));
  const primary = join(directory, "primary");
  const alternate = join(directory, "alternate");
  const git = async (args: string[]) => {
    const result = await spawnExec("git", args, {
      cwd: primary,
      timeout: 10000,
    });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  const states: State[] = [];
  const client = createJevClient(
    { url: "http://simulated", apiKey: "fixture", model: "fixture" },
    {
      fetch: async (_url, options) => {
        const payload = JSON.parse(String(options?.body));
        states.push(payload.state);
        const answers = Object.fromEntries(
          Object.entries(payload.questions).map(([id, raw]) => {
            const question = raw as {
              type: string;
              criteria: Record<string, string>;
            };
            if (question.type === "noul") return [id, { noul: 0.01 }];
            const keys = Object.keys(question.criteria);
            const winner = keys.includes("none") ? "none" : keys[0];
            assert.ok(winner);
            return [
              id,
              {
                choice: winner,
                confidence: 0.99,
                probabilities: Object.fromEntries(
                  keys.map((key) => [
                    key,
                    key === winner ? 0.99 : 0.01 / Math.max(1, keys.length - 1),
                  ]),
                ),
              },
            ];
          }),
        );
        return Response.json({
          model: "fixture",
          answers,
          usage: { input_tokens: 10, output_tokens: 1, cost: 0 },
        });
      },
    },
  );
  const host = detectHost({});
  const dependencies = {
    client,
    host,
    exec: spawnExec,
    runtime: { session: new Session({}), guide: new Guide(host) },
  };
  const ask = createAskFilesTool(dependencies);
  const find = createFindFilesTool(dependencies);
  const locate = createLocateTool(dependencies);
  const review = createCheckDiffTool(dependencies);
  const select = createSelectTestsTool(dependencies);
  try {
    await mkdir(primary);
    await git(["init", "-q"]);
    await git(["config", "user.name", "Test"]);
    await git(["config", "user.email", "test@example.invalid"]);
    await writeFile(
      join(primary, "source.js"),
      "export function invoice() { return 1; }\n",
    );
    await writeFile(
      join(primary, "unrelated.test.js"),
      "import { test } from 'node:test'; import { invoice } from './source.js'; test('invoice result', () => invoice());\n",
    );
    await writeFile(
      join(primary, "README.md"),
      "# Invoice\n\n`invoice` returns one.\n",
    );
    await writeFile(
      join(primary, "SPEC.md"),
      "### REQ-001 Invoice\nThe invoice function returns a number.\n",
    );
    await writeFile(join(primary, "large.md"), large);
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
    const firstBase = await git(["rev-parse", "HEAD"]);
    await git(["commit", "--allow-empty", "-qm", "second same tree"]);
    const secondBase = await git(["rev-parse", "HEAD"]);
    await git(["worktree", "add", "-q", "-b", "alternate", alternate]);
    for (const root of [primary, alternate])
      await writeFile(
        join(root, "source.js"),
        "export function invoice() { return 2; }\n",
      );
    const invoke = async (kind: string, root: string, base: string) => {
      const ctx = { cwd: primary };
      switch (kind) {
        case "ask_files":
          return ask.execute(
            "fixture",
            {
              root,
              paths: ["source.js"],
              asks: [
                {
                  intent: "verify",
                  claims: { invoice: "content exports an invoice function" },
                },
              ],
            },
            undefined,
            undefined,
            ctx,
          );
        case "find":
          return find.execute(
            "fixture",
            { root, goal: "find where invoice proration is computed" },
            undefined,
            undefined,
            ctx,
          );
        case "locate":
          return locate.execute(
            "fixture",
            {
              root,
              path: "large.md",
              goal: "find where invoice proration is computed",
            },
            undefined,
            undefined,
            ctx,
          );
        case "select":
          return select.execute(
            "fixture",
            { root, base, witnesses: "off" },
            undefined,
            undefined,
            ctx,
          );
        case "risk":
          return review.execute(
            "fixture",
            { root, base, check: "risk", witnesses: "off" },
            undefined,
            undefined,
            ctx,
          );
        case "docs":
          return review.execute(
            "fixture",
            { root, base, check: "docs" },
            undefined,
            undefined,
            ctx,
          );
        case "spec":
          return review.execute(
            "fixture",
            { root, base, check: "spec", spec_path: "SPEC.md" },
            undefined,
            undefined,
            ctx,
          );
        default:
          throw Error(kind);
      }
    };
    for (const kind of [
      "ask_files",
      "find",
      "locate",
      "risk",
      "docs",
      "spec",
      "select",
    ]) {
      client.clearCache();
      const start = states.length;
      await invoke(kind, primary, firstBase);
      const firstEnd = states.length;
      assert.ok(firstEnd > start, `${kind} must exercise a judgment`);
      for (const state of states.slice(start)) {
        const evidence = state.evidence as {
          context: {
            authority: { path: string };
            effectiveRoot: { path: string };
            resolvedBase?: string;
          };
        };
        assert.equal(evidence.context.authority.path, primary, kind);
        assert.equal(evidence.context.effectiveRoot.path, primary, kind);
        if (["risk", "docs", "spec", "select"].includes(kind))
          assert.equal(evidence.context.resolvedBase, firstBase, kind);
      }
      await invoke(kind, primary, firstBase);
      assert.equal(
        states.length,
        firstEnd,
        `${kind}: identical context reuses cache`,
      );
      await invoke(kind, alternate, firstBase);
      assert.ok(
        states.length > firstEnd,
        `${kind}: identical content in different root cannot reuse cache`,
      );
      if (["risk", "docs", "spec", "select"].includes(kind)) {
        const beforeBase = states.length;
        await invoke(kind, primary, secondBase);
        assert.ok(
          states.length > beforeBase,
          `${kind}: same tree at distinct resolved revision cannot reuse cache`,
        );
        const afterBase = states.length;
        await invoke(kind, primary, secondBase);
        assert.equal(
          states.length,
          afterBase,
          `${kind}: repeated resolved revision reuses cache`,
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("provenance retains evidence content and participates in serialized admission", () => {
  const context = {
    authority: { path: "/repo", origin: "host" as const },
    effectiveRoot: { path: "/repo", origin: "host" as const },
    resolvedBase: "a".repeat(40),
  };
  const original = {
    evidence: {
      aliases: { short: "src/long.ts" },
      versions: ["current", "before"],
    },
    content: "",
  };
  original.content = "x".repeat(
    STATE_MAX_CHARS - JSON.stringify(original).length,
  );
  assert.ok(JSON.stringify(original).length <= STATE_MAX_CHARS);
  const wrapped = withEvidenceContext(original, context);
  assert.ok(JSON.stringify(wrapped).length > STATE_MAX_CHARS);
  assert.deepEqual(
    (wrapped.evidence as Record<string, unknown>).aliases,
    original.evidence.aliases,
  );
  assert.equal("context" in original.evidence, false);
  assert.equal(
    withEvidenceContext({ evidence: "literal evidence" }, context).evidence,
    "literal evidence",
  );
  context.resolvedBase = "b".repeat(40);
  assert.equal(
    ((wrapped.evidence as Record<string, unknown>).context as typeof context)
      .resolvedBase,
    "a".repeat(40),
  );
});

test("ask_files refuses provenance-expanded evidence before judgment", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-context-admission-"));
  const host = detectHost({});
  let judgments = 0;
  try {
    const initialized = await spawnExec("git", ["init", "-q"], {
      cwd,
      timeout: 10_000,
    });
    assert.equal(initialized.code, 0, initialized.stderr);
    const state = { path: "large.txt", content: "" };
    state.content = "x".repeat(STATE_MAX_CHARS - JSON.stringify(state).length);
    assert.equal(JSON.stringify(state).length, STATE_MAX_CHARS);
    assert.ok(
      JSON.stringify(
        withEvidenceContext(state, {
          authority: { path: cwd, origin: "host" },
          effectiveRoot: { path: cwd, origin: "host" },
        }),
      ).length > STATE_MAX_CHARS,
    );
    await writeFile(join(cwd, state.path), state.content);
    const output = await createAskFilesTool({
      host,
      runtime: { session: new Session({}), guide: new Guide(host) },
      exec: spawnExec,
      client: {
        clearCache() {},
        async judge() {
          judgments++;
          throw Error("oversized context must not reach judgment");
        },
      },
    }).execute(
      "oversized",
      {
        paths: ["large.txt"],
        asks: [
          { intent: "verify", claims: { content: "content contains text" } },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(judgments, 0);
    assert.equal(output.details.result.execution, "refused");
    assert.ok(
      output.details.result.diagnostics.some(
        (d) => d.cause === "evidence_too_large",
      ),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
