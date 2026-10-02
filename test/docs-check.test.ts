import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { GitExec } from "../src/core/git.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { JevClient } from "../src/jev/types.ts";
import { renderEnvelope } from "../src/render.ts";
import { Session } from "../src/session.ts";
import { runDocsCheck } from "../src/tools/docs-check.ts";

const execute = promisify(execFile);
const exec: GitExec = async (command, args, options) => {
  try {
    return {
      ...(await execute(command, args, options)),
      code: 0,
      killed: false,
    };
  } catch (error) {
    const failed = error as {
      code: number;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failed.code,
      killed: failed.killed ?? false,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
};
test("docs preserves obtained findings and names unjudged sections when the request budget ends", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "docs-budget-"));
  let requests = 0;
  const client: JevClient = {
    clearCache() {},
    async judge(_state, questions, options) {
      const admitted = options?.beforeRequest?.(Object.keys(questions).length);
      if (admitted && !admitted.ok)
        return {
          ok: true,
          calls: 0,
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "unjudged", reason: admitted.error },
            ]),
          ),
        };
      requests++;
      return {
        ok: true,
        calls: 1,
        questions: 2,
        answers: {
          status: {
            type: "choice",
            choice: "now_false",
            confidence: 1,
            probabilities: { unrelated: 0, still_true: 0, now_false: 1 },
          },
          sentence: {
            type: "choice",
            choice: "s1",
            confidence: 1,
            probabilities: { s1: 1, none: 0 },
          },
        },
      };
    },
  };
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    await writeFile(
      join(cwd, "a.ts"),
      "export function value() { return 1; }\n",
    );
    await writeFile(
      join(cwd, "README.md"),
      "# First\n`value` returns one.\n# Second\n`value` also returns one.",
    );
    await exec("git", ["add", "."], { cwd, timeout: 10000 });
    await exec(
      "git",
      [
        "-c",
        "user.name=Proof",
        "-c",
        "user.email=proof@example.invalid",
        "commit",
        "-qm",
        "base",
      ],
      { cwd, timeout: 10000 },
    );
    await writeFile(
      join(cwd, "a.ts"),
      "export function value() { return 2; }\n",
    );
    const host = detectHost({});
    const dependencies = {
      client,
      exec,
      host,
      runtime: { session: new Session({}), guide: new Guide(host) },
    };
    const result = await runDocsCheck(dependencies, { cwd, maxCalls: 1 });
    const unchecked = result.envelope.lines.flatMap((line) =>
      line.type === "unchecked" ? line.items : [],
    );
    assert.ok(
      unchecked.some(
        (item) => item.includes("README.md") && item.includes("Second"),
      ),
    );
    assert.equal(requests, 1);
    assert.deepEqual(
      result.findings.map((finding) => finding.section.heading),
      ["First"],
    );
    assert.equal(
      result.findings[0]?.sentence?.text,
      "# First\n`value` returns one.",
    );
    assert.equal(
      result.envelope.lines.some((line) => line.type === "list"),
      false,
    );
    await writeFile(
      join(cwd, "README.md"),
      "# First\n`value` returns one.\n# Second\n`value` also returns one.\n# Third\n`value` returns one too.",
    );
    dependencies.runtime.session = new Session({ maxCalls: 1 });
    const capped = await runDocsCheck(dependencies, { cwd });
    assert.equal(requests, 2);
    assert.equal(dependencies.runtime.session.snapshot().refusals, 1);
    assert.ok(capped.envelope.lines.some((line) => line.type === "unchecked"));
    let commands = 0;
    const exhausted = await runDocsCheck(
      {
        ...dependencies,
        exec: async (...args) => {
          commands++;
          return exec(...args);
        },
      },
      { cwd },
    );
    assert.equal(exhausted.status, "refused");
    assert.equal(commands, 0);
    assert.equal(requests, 2);
    dependencies.runtime.session = new Session({});
    const blocked = await runDocsCheck(dependencies, { cwd, maxCalls: 0 });
    assert.equal(requests, 2);
    assert.equal(
      blocked.envelope.lines.some((line) => line.type === "list"),
      false,
    );
    await writeFile(
      join(cwd, "README.md"),
      `${Array.from({ length: 45 }, (_, index) => `# Matched ${index}\nSee a.ts.`).join("\n")}\n# Other\nNo code reference.`,
    );
    const many = await runDocsCheck(dependencies, { cwd, maxCalls: 0 });
    assert.equal(many.unjudged?.count, 45);
    assert.equal(many.unjudged?.sections.length, 40);
    assert.equal(many.unjudged?.truncated, true);
    const visible = renderEnvelope(many.envelope);
    assert.match(visible, /README\.md.*Matched 0/);
    assert.match(visible, /45 sections/);
    assert.match(visible, /\+40 more/);
    assert.doesNotMatch(visible, /details\.collection/);
    assert.equal(
      many.envelope.lines.some((line) => line.type === "unchecked"),
      false,
    );
    assert.equal(
      many.unjudged?.sections.some((section) => section.includes("Other")),
      false,
    );
    await writeFile(
      join(cwd, "README.md"),
      Array.from(
        { length: 10 },
        (_, index) => `# Section ${index}\nSee a.ts.`,
      ).join("\n"),
    );
    let completed = 0;
    let started = 0;
    const releaseSlow = Promise.withResolvers<void>();
    const othersDone = Promise.withResolvers<void>();
    const slowClient: JevClient = {
      clearCache() {},
      async judge(state, questions, options) {
        const first = started++ === 0;
        if (first) await releaseSlow.promise;
        const judged = await client.judge(state, questions, options);
        if (!first && ++completed === 9) othersDone.resolve();
        return judged;
      },
    };
    const pending = runDocsCheck(
      { ...dependencies, client: slowClient },
      { cwd },
    );
    try {
      await othersDone.promise;
      assert.equal(completed, 9);
    } finally {
      releaseSlow.resolve();
      await pending;
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("docs leaves sections backed by textless changed source unchecked", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "docs-utf8-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await execute("git", ["init", "-q"], { cwd });
  await writeFile(join(cwd, "source.ts"), "export const value = 'valid';\n");
  await writeFile(
    join(cwd, "README.md"),
    "# Source\n`source.ts` exports a valid value.\n",
  );
  await execute("git", ["add", "."], { cwd });
  await execute(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "base",
    ],
    { cwd },
  );
  await writeFile(
    join(cwd, "source.ts"),
    Buffer.from([0x63, 0x61, 0x66, 0xe9]),
  );
  const host = detectHost({});
  const result = await runDocsCheck(
    {
      client: {
        clearCache() {},
        async judge() {
          throw new Error("Textless source must not be judged");
        },
      },
      exec,
      host,
      runtime: { session: new Session({}), guide: new Guide(host) },
    },
    { cwd },
  );
  assert.equal(result.findings.length, 0);
  assert.ok(
    result.envelope.lines.some(
      (line) =>
        line.type === "unchecked" &&
        line.items.some(
          (item) =>
            item.includes("README.md") &&
            item.includes("changed source unavailable"),
        ),
    ),
  );
});

test("docs on an empty diff reports nothing judged instead of no stale sentences", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "docs-empty-"));
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    await writeFile(
      join(cwd, "a.ts"),
      "export function value() { return 1; }\n",
    );
    await writeFile(join(cwd, "README.md"), "# Value\n`value` returns one.\n");
    await exec("git", ["add", "."], { cwd, timeout: 10000 });
    await exec(
      "git",
      [
        "-c",
        "user.name=Proof",
        "-c",
        "user.email=proof@example.invalid",
        "commit",
        "-qm",
        "base",
      ],
      { cwd, timeout: 10000 },
    );
    const host = detectHost({});
    const result = await runDocsCheck(
      {
        client: {
          clearCache() {},
          async judge() {
            throw new Error("Empty diff must not reach Jev");
          },
        },
        exec,
        host,
        runtime: { session: new Session({}), guide: new Guide(host) },
      },
      { cwd },
    );
    const text = renderEnvelope(result.envelope);
    assert.doesNotMatch(text, /no stale sentences/);
    assert.match(
      text,
      /\[no changed units against HEAD; nothing judged; pass base= or check the working directory\]/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("docs with only a binary change keeps the limit and reports nothing judged", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "docs-binary-"));
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    await writeFile(
      join(cwd, "a.ts"),
      "export function value() { return 1; }\n",
    );
    await writeFile(join(cwd, "README.md"), "# Value\n`value` returns one.\n");
    await exec("git", ["add", "."], { cwd, timeout: 10000 });
    await exec(
      "git",
      [
        "-c",
        "user.name=Proof",
        "-c",
        "user.email=proof@example.invalid",
        "commit",
        "-qm",
        "base",
      ],
      { cwd, timeout: 10000 },
    );
    await writeFile(
      join(cwd, "img.bin"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    );
    await exec("git", ["add", "."], { cwd, timeout: 10000 });
    const host = detectHost({});
    const result = await runDocsCheck(
      {
        client: {
          clearCache() {},
          async judge() {
            throw new Error("Binary-only diff must not reach Jev");
          },
        },
        exec,
        host,
        runtime: { session: new Session({}), guide: new Guide(host) },
      },
      { cwd },
    );
    const text = renderEnvelope(result.envelope);
    assert.doesNotMatch(text, /no stale sentences/);
    assert.doesNotMatch(text, /no findings/);
    assert.match(text, /img\.bin : binary_ignored/);
    assert.match(
      text,
      /\[no changed units against HEAD; nothing judged; pass base= or check the working directory\]/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
