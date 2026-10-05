import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectAskFiles } from "../src/adapters/ask-files.ts";
import { collectFiles, resolveInsideRepo } from "../src/adapters/files.ts";
import { STATE_MAX_CHARS } from "../src/constants.ts";
import type { GitExec } from "../src/core/git.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { JevClient, State } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";
import { createAskFilesTool } from "../src/tools/ask-files.ts";

const noGit: GitExec = async () => ({
  stdout: "",
  stderr: "not a repository",
  code: 128,
  killed: false,
});

test("paths, recursive directories and overlapping globs yield sorted exact files with pruning", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-files-"));
  try {
    for (const dir of ["src", "src/nested", "src/dist", "node_modules"])
      await mkdir(join(cwd, dir), { recursive: true });
    for (const [path, text] of Object.entries({
      "src/a.ts": "export const a = 1;",
      "src/nested/b.ts": "export const b = '😀';",
      "src/dist/c.ts": "generated",
      "node_modules/d.ts": "dependency",
      "src/package-lock.json": "{}",
      "src/empty.ts": "",
      "src/binary.png": "\0PNG",
      "src/large.ts": "x".repeat(STATE_MAX_CHARS + 1),
    }))
      await writeFile(join(cwd, path), text);
    const result = await collectAskFiles(cwd, [
      "src",
      "src/**/*.ts",
      "node_modules",
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.files.map((file) => file.path),
      ["src/a.ts", "src/nested/b.ts"],
    );
    assert.equal(result.files[1]?.content, "export const b = '😀';");
    assert.ok(result.skipped.some((path) => path.includes("large.ts")));
    assert.ok(
      result.skipped.some((path) => path.includes("package-lock.json")),
    );
    assert.ok(result.skipped.some((path) => path.includes("src/dist/")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("internal URLs are refused before expansion", async () => {
  const result = await collectAskFiles(process.cwd(), ["artifact://secret"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /use read/);
});

test("all asks share each exact file state, parallel judgments obey max_calls and expose unchecked files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-files-"));
  try {
    await Promise.all(
      ["a.ts", "b.ts", "c.ts"].map((path) =>
        writeFile(join(cwd, path), `export const name = '${path}';`),
      ),
    );
    const states: State[] = [];
    let active = 0,
      peak = 0;
    const barrier = Promise.withResolvers<void>();
    const client: JevClient = {
      clearCache() {},
      async judge(state, questions, options) {
        const admission = options?.beforeRequest?.(
          Object.keys(questions).length,
        );
        if (admission && !admission.ok)
          return { ok: false, error: admission.error, calls: 0 };
        states.push(state);
        active++;
        peak = Math.max(peak, active);
        if (active === 2) barrier.resolve();
        await barrier.promise;
        active--;
        return {
          ok: true,
          calls: 1,
          questions: Object.keys(questions).length,
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "bool" as const, source: "fresh" as const, p: 0.04 },
            ]),
          ),
        };
      },
    };
    const host = detectHost({});
    const tool = createAskFilesTool({
      client,
      host,
      runtime: { session: new Session({}), guide: new Guide(host) },
      exec: noGit,
    });
    const result = await tool.execute(
      "1",
      {
        paths: ["."],
        asks: {
          intent: "verify",
          claims: {
            c1: "`content` validates tokens",
            c2: "`content` writes to storage",
          },
        },
        max_calls: 2,
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(peak, 2);
    assert.deepEqual(
      states.map(({ path, content }) => ({ path, content })),
      [
        { path: "a.ts", content: "export const name = 'a.ts';" },
        { path: "b.ts", content: "export const name = 'b.ts';" },
      ],
    );
    const text = result.content[0]?.text ?? "";
    assert.match(text, /c1.*validates tokens.*no \(not shown\)/);
    assert.match(text, /unchecked: c.ts/);
    assert.match(text, /2 calls · 12 questions/);
    assert.doesNotMatch(text, /export const/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("contradicted files verdicts judge the same-subject control in a second round", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-files-"));
  try {
    await writeFile(join(cwd, "a.ts"), "export const value=1;");
    const rounds: string[][] = [];
    const client: JevClient = {
      clearCache() {},
      async judge(_state, questions, options) {
        options?.beforeRequest?.(Object.keys(questions).length);
        rounds.push(Object.keys(questions));
        if (
          Object.values(questions).some((question) =>
            question.instructions.includes("same subject"),
          )
        )
          return {
            ok: true,
            calls: 1,
            questions: 1,
            answers: Object.fromEntries(
              Object.keys(questions).map((id) => [
                id,
                { type: "bool", source: "fresh" as const, p: 0.9 },
              ]),
            ),
          };
        const contradicted = (peak: number) => ({
          type: "choice" as const,
          source: "fresh" as const,
          choice: "contradicted",
          confidence: 0.95,
          probabilities: {
            holds: 0.02,
            contradicted: peak,
            not_addressed: 0.03,
            cannot_tell: 0.02,
          },
        });
        return {
          ok: true,
          calls: 1,
          questions: 3,
          answers: {
            q1: contradicted(0.93),
            q2: contradicted(0.93),
            q3: { type: "bool", source: "fresh" as const, p: 0.02 },
          },
        };
      },
    };
    const host = detectHost({});
    const result = await createAskFilesTool({
      client,
      host,
      runtime: { session: new Session({}), guide: new Guide(host) },
      exec: noGit,
    }).execute(
      "1",
      {
        paths: ["a.ts"],
        asks: {
          intent: "verify",
          claims: { c1: "`content` validates tokens" },
        },
      },
      undefined,
      undefined,
      { cwd },
    );
    // Three first-round questions, then the same-subject control alone.
    assert.deepEqual(rounds, [["q1", "q2", "q3"], ["q4"]]);
    const text = result.content[0]?.text ?? "";
    assert.match(text, /contradicted \(0\.93\)/);
    assert.doesNotMatch(text, /unsure/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("MAX_FILES refusal reports directories contributing the most after pruning", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-files-"));
  try {
    await mkdir(join(cwd, "many"));
    await Promise.all(
      Array.from({ length: 256 }, (_, i) =>
        writeFile(join(cwd, "many", `${i}.ts`), "export const value=1;"),
      ),
    );
    const result = await collectAskFiles(cwd, ["many"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /MAX_FILES=255.*many: 256/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("uncertain choices reverse substantive options and retain exact category text", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-files-"));
  try {
    await writeFile(join(cwd, "a.ts"), "export const value=1;");
    const orders: string[][] = [];
    const client: JevClient = {
      clearCache() {},
      async judge(_state, questions, options) {
        const admitted = options?.beforeRequest?.(1);
        if (admitted && !admitted.ok)
          return { ok: false, error: admitted.error };
        const q = Object.values(questions)[0];
        assert.equal(q?.type, "choice");
        if (q?.type !== "choice") throw Error("wrong question");
        orders.push(Object.keys(q.criteria));
        return {
          ok: true,
          calls: 1,
          questions: 1,
          answers: {
            q1: {
              type: "choice",
              source: "fresh",
              choice: "domain",
              confidence: 0.6,
              probabilities: { domain: 0.6, storage: 0.35, other: 0.05 },
            },
          },
        };
      },
    };
    const host = detectHost({});
    const result = await createAskFilesTool({
      client,
      host,
      runtime: { session: new Session({}), guide: new Guide(host) },
      exec: noGit,
    }).execute(
      "1",
      {
        paths: ["a.ts"],
        asks: {
          intent: "classify",
          categories: {
            domain: "Pure business rules",
            storage: "Persistent queries",
          },
        },
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.deepEqual(orders[1], [
      ...(orders[0] ?? []).filter((key) => key !== "other").reverse(),
      "other",
    ]);
    const answer = result.details.envelope.lines.find(
      (line) => line.type === "answer",
    );
    assert.equal(answer?.type, "answer");
    if (answer?.type === "answer") {
      assert.equal(answer.band, "unsure");
      assert.equal(answer.uncalibrated, true);
      assert.match(answer.label, /Pure business rules/);
    }
    assert.equal(result.details.files[0]?.reversed?.calls, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("exact size boundary and non-ASCII text remain intact while invalid bytes are skipped", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-files-"));
  try {
    const exact = "😀".repeat(STATE_MAX_CHARS / 2);
    await writeFile(join(cwd, "exact.ts"), exact);
    await writeFile(join(cwd, "invalid.bin"), Buffer.from([0xff, 0xfe, 0x41]));
    const result = await collectAskFiles(cwd, ["."]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.files.map((file) => file.path),
      ["exact.ts"],
    );
    assert.equal(result.files[0]?.content, exact);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("literal files and directory names containing glob syntax are not reinterpreted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-files-"));
  try {
    await mkdir(join(cwd, "[id]"));
    await writeFile(join(cwd, "[id]", "page.tsx"), "export const page=1;");
    const direct = await collectAskFiles(cwd, ["[id]/page.tsx"]);
    const directory = await collectAskFiles(cwd, ["[id]"]);
    assert.equal(direct.ok, true);
    assert.equal(directory.ok, true);
    if (direct.ok && directory.ok) {
      assert.deepEqual(
        direct.files.map((file) => file.path),
        ["[id]/page.tsx"],
      );
      assert.deepEqual(
        directory.files.map((file) => file.path),
        ["[id]/page.tsx"],
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit file and directory links, parent paths, absolute paths and escaping globs are refused", async () => {
  const base = await mkdtemp(join(tmpdir(), "jev-escape-"));
  const cwd = join(base, "repo");
  await mkdir(cwd);
  try {
    await writeFile(join(base, "secret"), "PRIVATE KEY MUST NOT LEAVE REPO");
    await mkdir(join(base, "outside"));
    await writeFile(
      join(base, "outside", "secret"),
      "PRIVATE KEY MUST NOT LEAVE REPO",
    );
    await symlink(join(base, "secret"), join(cwd, "file-link"));
    await symlink(join(base, "outside"), join(cwd, "directory-link"));
    for (const path of [
      "file-link",
      "directory-link",
      "directory-link/secret",
      "../secret",
      join(base, "secret"),
      "../*",
    ]) {
      const expanded = await collectAskFiles(cwd, [path]);
      assert.equal(expanded.ok, false, path);
      const collected = await collectFiles(cwd, [path]);
      assert.equal(collected.ok, false, path);
      const resolved = await resolveInsideRepo(cwd, path);
      assert.equal(resolved.ok, false, path);
    }
    const walked = await collectAskFiles(cwd, ["."]);
    assert.equal(walked.ok, true);
    if (walked.ok) {
      assert.deepEqual(walked.files, []);
      assert.match(walked.skipped.join("\n"), /file-link.*symbolic link/);
      assert.match(walked.skipped.join("\n"), /directory-link.*symbolic link/);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("git inventory includes tracked and untracked hidden files and reports ignored candidates", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-inventory-"));
  try {
    for (const path of [".tracked", ".hidden", "ignored.ts", "normal.ts"])
      await writeFile(join(cwd, path), "export const value=1;");
    const exec: GitExec = async (_command, args) => {
      return {
        stdout: args.includes("--others")
          ? ".tracked\0.hidden\0normal.ts\0"
          : ".tracked\0",
        stderr: "",
        code: 0,
        killed: false,
      };
    };
    const result = await collectAskFiles(cwd, ["."], undefined, exec);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.files.map((file) => file.path),
        [".hidden", ".tracked", "normal.ts"],
      );
      assert.ok(
        result.skipped.some((omission) => omission.includes("ignored.ts")),
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("literal ignored secrets and git metadata are refused by both collectors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-policy-"));
  try {
    await mkdir(join(cwd, ".git"));
    for (const path of [".env", "credentials.json", ".git/config", ".created"])
      await writeFile(join(cwd, path), "sensitive or newly created");
    const exec: GitExec = async (_command, args) => ({
      stdout:
        args.includes("--") && args.at(-1) === ".created"
          ? ".created\0"
          : args.includes("--")
            ? ""
            : ".created\0",
      stderr: "",
      code: 0,
      killed: false,
    });
    for (const path of [".env", "credentials.json", ".git/config"]) {
      const ask = await collectFiles(cwd, [path], undefined, { exec });
      const files = await collectAskFiles(cwd, [path], undefined, exec);
      assert.equal(ask.ok, false, path);
      assert.equal(files.ok, false, path);
      if (!ask.ok) assert.match(ask.error, /not sent to Jev/);
    }
    assert.equal(
      (await collectFiles(cwd, [".created"], undefined, { exec })).ok,
      true,
    );
    const explicit = await collectAskFiles(cwd, [".created"], undefined, exec);
    assert.equal(explicit.ok, true);
    if (explicit.ok)
      assert.deepEqual(
        explicit.files.map((file) => file.path),
        [".created"],
      );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("linked root, dot glob matching and excluded glob prefixes retain one policy", async () => {
  const base = await mkdtemp(join(tmpdir(), "jev-dot-glob-"));
  const cwd = join(base, "repo");
  const alias = join(base, "alias");
  try {
    await mkdir(join(cwd, ".github"), { recursive: true });
    await mkdir(join(cwd, "node_modules"));
    await writeFile(join(cwd, ".github", "ci.yml"), "name: CI");
    await writeFile(join(cwd, "node_modules", "secret.yml"), "secret: token");
    await symlink(cwd, alias);
    const exec: GitExec = async () => ({
      stdout: ".github/ci.yml\0node_modules/secret.yml\0",
      stderr: "",
      code: 0,
      killed: false,
    });
    const direct = await collectAskFiles(alias, ["."], undefined, exec);
    assert.equal(direct.ok, true);
    const glob = await collectAskFiles(alias, ["**/*.yml"], undefined, exec);
    assert.equal(glob.ok, true);
    const prefix = await collectAskFiles(
      alias,
      ["node_modules/**/*.yml"],
      undefined,
      exec,
    );
    assert.equal(prefix.ok, true);
    if (direct.ok)
      assert.deepEqual(
        direct.files.map((file) => file.path),
        [".github/ci.yml"],
      );
    if (glob.ok)
      assert.deepEqual(
        glob.files.map((file) => file.path),
        [".github/ci.yml"],
      );
    if (prefix.ok) {
      assert.deepEqual(prefix.files, []);
      assert.match(prefix.skipped.join("\n"), /node_modules.*dependencies/);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
test("ask_files refuses an entirely excluded UTF-8 batch without a judgment", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-ask-files-utf8-"));
  try {
    await writeFile(join(cwd, "latin.txt"), Buffer.from([0xe9]));
    let calls = 0;
    const client: JevClient = {
      clearCache() {},
      async judge() {
        calls++;
        return {
          ok: true,
          answers: { q1: { type: "bool", source: "fresh", p: 0.98 } },
        };
      },
    };
    const host = detectHost({});
    const result = await createAskFilesTool({
      client,
      host,
      exec: noGit,
      runtime: { guide: new Guide(host), session: new Session({}) },
    }).execute(
      "excluded",
      {
        paths: ["latin.txt"],
        asks: { intent: "verify", claims: { c1: "The file contains text" } },
      },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(calls, 0);
    const report = result.details.result;
    assert.equal(report.execution, "refused");
    assert.equal(report.items.length, 0);
    assert.equal(report.accounting.httpAttempts, 0);
    assert.ok(
      report.diagnostics.some(
        (diagnostic) =>
          diagnostic.cause === "collection_omitted" &&
          diagnostic.fact.includes("latin.txt") &&
          diagnostic.fact.includes("not UTF-8 text"),
      ),
    );
    assert.ok(
      report.actions.every((action) => action.repeatUnchanged === false),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
