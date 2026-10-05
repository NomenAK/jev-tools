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
import { Session } from "../src/session.ts";
import { runSpecCheck } from "../src/tools/spec-check.ts";

const execute = promisify(execFile);
const exec: GitExec = async (command, args, options) => ({
  ...(await execute(command, args, options)),
  code: 0,
  killed: false,
});
test("an exhausted specification budget names all unchecked work without claiming conformance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spec-budget-"));
  const client: JevClient = {
    clearCache() {},
    async judge(_state, questions, options) {
      const admitted = options?.beforeRequest?.(Object.keys(questions).length);
      assert.equal(admitted?.ok, false);
      if (!admitted || admitted.ok) throw new Error("unexpected admission");
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
    },
  };
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    await writeFile(
      join(cwd, "a.ts"),
      "export function value() { return 1; }\n",
    );
    await writeFile(join(cwd, "SPEC.md"), "### REQ-001 Value\nReturn one.");
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
    const result = await runSpecCheck(
      {
        client,
        exec,
        host,
        runtime: { session: new Session({}), guide: new Guide(host) },
      },
      { cwd, specPath: "SPEC.md", maxCalls: 0 },
    );
    const unchecked = result.envelope.lines.flatMap((line) =>
      line.type === "unchecked" ? line.items : [],
    );
    assert.ok(unchecked.some((item) => item.includes("REQ-001 Value")));
    assert.ok(unchecked.some((item) => item.startsWith("drift")));
    assert.equal(
      result.envelope.lines.some((line) => line.type === "list"),
      false,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("spec on an empty diff reports nothing judged instead of no violations", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spec-empty-"));
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    await writeFile(
      join(cwd, "a.ts"),
      "export function value() { return 1; }\n",
    );
    await writeFile(join(cwd, "SPEC.md"), "### REQ-001 Value\nReturn one.\n");
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
    const result = await runSpecCheck(
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
      { cwd, specPath: "SPEC.md" },
    );
    assert.equal(
      result.envelope.lines.some((line) => line.type === "list"),
      false,
    );
    assert.ok(
      result.envelope.lines.some(
        (line) =>
          line.type === "fact" &&
          line.fact === "no changed units against HEAD" &&
          line.next.includes("nothing judged"),
      ),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("spec with only a binary change keeps the limit and reports nothing judged", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spec-binary-"));
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    await writeFile(
      join(cwd, "a.ts"),
      "export function value() { return 1; }\n",
    );
    await writeFile(join(cwd, "SPEC.md"), "### REQ-001 Value\nReturn one.\n");
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
    const result = await runSpecCheck(
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
      { cwd, specPath: "SPEC.md" },
    );
    assert.equal(
      result.envelope.lines.some((line) => line.type === "list"),
      false,
    );
    const facts = result.envelope.lines.flatMap((line) =>
      line.type === "fact" ? [`${line.fact}; ${line.next}`] : [],
    );
    assert.ok(facts.some((fact) => fact.includes("img.bin : binary_ignored")));
    assert.ok(
      facts.some(
        (fact) =>
          fact.includes("no changed units against HEAD") &&
          fact.includes("nothing judged"),
      ),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("spec without requirements keeps its refusal on an empty diff", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spec-noreq-"));
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    await writeFile(
      join(cwd, "a.ts"),
      "export function value() { return 1; }\n",
    );
    await writeFile(join(cwd, "SPEC.md"), "# Notes\nNo requirements here.\n");
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
    const result = await runSpecCheck(
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
      { cwd, specPath: "SPEC.md" },
    );
    assert.equal(
      result.envelope.lines.some(
        (line) =>
          line.type === "refusal" && line.message.includes("No ### REQ-"),
      ),
      true,
    );
    assert.equal(
      result.envelope.lines.some(
        (line) =>
          line.type === "fact" && line.fact.includes("no changed units"),
      ),
      false,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("over-cap drift stays unjudged while requirements are still judged", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spec-drift-"));
  const asked: string[] = [];
  const client: JevClient = {
    clearCache() {},
    async judge(_state, questions, options) {
      options?.beforeRequest?.(Object.keys(questions).length);
      asked.push(...Object.keys(questions));
      return {
        ok: true,
        calls: 1,
        questions: Object.keys(questions).length,
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            {
              type: "choice",
              choice: "violates",
              confidence: 0.9,
              probabilities: {
                not_touched: 0.05,
                conforms: 0.05,
                violates: 0.9,
              },
            },
          ]),
        ),
      };
    },
  };
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    const lines = Array.from(
      { length: 255 },
      (_, i) => `export function fn${i}() { return ${i}; }`,
    );
    await writeFile(join(cwd, "a.ts"), `${lines.join("\n")}\n`);
    await writeFile(join(cwd, "SPEC.md"), "### REQ-001 Value\nReturn one.");
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
      `${lines.map((line) => `${line} // changed`).join("\n")}\n`,
    );
    const host = detectHost({});
    const result = await runSpecCheck(
      {
        client,
        exec,
        host,
        runtime: { session: new Session({}), guide: new Guide(host) },
      },
      { cwd, specPath: "SPEC.md" },
    );
    assert.equal(result.ok, true);
    assert.ok(!asked.includes("drift"), "drift never sent past the cap");
    assert.ok(asked.includes("req1"), "requirements still judged");
    assert.ok(
      result.findings.some((finding) => finding.kind === "requirement"),
    );
    const unchecked = result.envelope.lines.flatMap((line) =>
      line.type === "unchecked" ? line.items : [],
    );
    assert.ok(unchecked.some((item) => item.startsWith("drift")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
