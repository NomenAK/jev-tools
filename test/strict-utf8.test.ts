import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { collectAskRepository } from "../src/adapters/ask-proof.ts";
import { collectDocsInventory } from "../src/adapters/docs.ts";
import { collectSearchExcerpts } from "../src/adapters/files.ts";
import { collectDiff } from "../src/adapters/git.ts";
import { readLocateFile, scanRange } from "../src/adapters/locate-file.ts";
import { collectTestInventory } from "../src/adapters/test-inventory.ts";
import {
  FIND_READ_CHUNK_BYTES,
  LOCATE_READ_BUFFER_BYTES,
} from "../src/constants.ts";
import type { GitExec } from "../src/core/git.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import { Session } from "../src/session.ts";
import { createCheckDiffTool } from "../src/tools/check-diff.ts";

const execute = promisify(execFile);
const exec: GitExec = async (command, args, options) => {
  try {
    return {
      ...(await execute(command, args, options)),
      code: 0,
      killed: false,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "stdout" in error &&
      "stderr" in error &&
      "code" in error
    )
      return {
        stdout: String(error.stdout),
        stderr: String(error.stderr),
        code: Number(error.code),
        killed: "killed" in error && error.killed === true,
      };
    throw error;
  }
};
async function fixture(
  t: test.TestContext,
  bytes: string | Buffer,
  format = "sha1",
) {
  const cwd = await mkdtemp(join(tmpdir(), "strict-utf8-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await execute("git", ["init", "-q", `--object-format=${format}`], { cwd });
  await execute("git", ["config", "user.name", "Test"], { cwd });
  await execute("git", ["config", "user.email", "test@example.com"], { cwd });
  await writeFile(join(cwd, "source.ts"), bytes);
  await writeFile(join(cwd, "README.md"), bytes);
  await execute("git", ["add", "."], { cwd });
  await execute("git", ["commit", "-qm", "fixture"], { cwd });
  return cwd;
}
test("collectors refuse latin-1 rather than judging replacement text", async (t) => {
  const cwd = await fixture(t, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  const locate = await readLocateFile(cwd, "source.ts", undefined, exec);
  assert.equal(locate.ok, false);
  if (!locate.ok) assert.match(locate.error, /source.ts.*not UTF-8 text/);
  const docs = await collectDocsInventory(exec, cwd);
  assert.ok(docs.ok);
  assert.equal(docs.files.length, 0);
  assert.ok(
    docs.limits.some(
      (limit) =>
        limit.path === "README.md" && limit.reason.includes("not UTF-8 text"),
    ),
  );
  const inventory = await collectTestInventory(exec, cwd);
  assert.ok(inventory.ok);
  assert.equal(await inventory.read("source.ts"), undefined);
  assert.ok(
    inventory.limits.some(
      (limit) => limit.path === "source.ts" && limit.kind === "not UTF-8 text",
    ),
  );
  const find = await collectSearchExcerpts(
    cwd,
    ["source.ts"],
    [],
    undefined,
    exec,
  );
  assert.ok(find.ok);
  assert.equal(find.files["source.ts"], undefined);
  assert.ok(
    find.limits.some(
      (limit) =>
        limit.path === "source.ts" && limit.reason === "not UTF-8 text",
    ),
  );
});
for (const size of [FIND_READ_CHUNK_BYTES, LOCATE_READ_BUFFER_BYTES]) {
  test(`streaming collectors preserve multibyte characters across byte ${size}`, async (t) => {
    const text = `${"a".repeat(size - 1)}😀\nend\n`;
    const cwd = await fixture(t, text);
    const scan = await scanRange(
      cwd,
      "source.ts",
      { start: 1, end: 2 },
      undefined,
      exec,
    );
    assert.ok(scan.ok);
    assert.equal(scan.text, text);
    const find = await collectSearchExcerpts(
      cwd,
      ["source.ts"],
      ["😀"],
      undefined,
      exec,
    );
    assert.ok(find.ok);
    assert.equal(find.files["source.ts"]?.includes("\uFFFD"), false);
  });
}
test("collectors preserve BOM, CRLF, tabs and valid controls", async (t) => {
  const text = "\uFEFFexport const café = '😀';\r\n\t// \u0001\n";
  const cwd = await fixture(t, text);
  const locate = await readLocateFile(cwd, "source.ts", undefined, exec);
  assert.ok(locate.ok && locate.kind === "whole");
  assert.equal(locate.text, text);
  const docs = await collectDocsInventory(exec, cwd);
  assert.ok(docs.ok);
  assert.equal(docs.files[0]?.text, text);
  const inventory = await collectTestInventory(exec, cwd);
  assert.ok(inventory.ok);
  assert.equal((await inventory.read("source.ts"))?.text, text);
  const find = await collectSearchExcerpts(
    cwd,
    ["source.ts"],
    [],
    undefined,
    exec,
  );
  assert.ok(find.ok);
  assert.equal(find.files["source.ts"], text);
  await writeFile(join(cwd, "source.ts"), `${text}// changed\n`);
  const diff = await collectDiff(exec, { cwd, base: "HEAD" });
  assert.ok(diff.ok);
  assert.equal(
    diff.files.find((file) => file.path === "source.ts")?.before,
    text,
  );
});
for (const format of ["sha1", "sha256"]) {
  for (const bytes of [Buffer.from([0xe9]), Buffer.from([0xf0, 0x9f, 0x98])]) {
    test(`${format} base blob rejects lossy host decoding (${bytes.toString("hex")})`, async (t) => {
      const cwd = await fixture(t, bytes, format);
      await writeFile(join(cwd, "source.ts"), "export const valid = true;\n");
      const diff = await collectDiff(exec, { cwd, base: "HEAD" });
      assert.ok(diff.ok);
      assert.equal(
        diff.files.find((file) => file.path === "source.ts")?.limitation,
        "not UTF-8 text",
      );
    });
  }
  test(`${format} accepts legitimate replacement characters in verified git blobs`, async (t) => {
    const text = "export const text = '\uFFFD';\n";
    const cwd = await fixture(t, text, format);
    await writeFile(join(cwd, "source.ts"), "export const text = 'changed';\n");
    const diff = await collectDiff(exec, { cwd, base: "HEAD" });
    assert.ok(diff.ok);
    const source = diff.files.find((file) => file.path === "source.ts");
    assert.equal(source?.before, text);
    assert.equal(source?.limitation, undefined);
  });
}

test("streaming collectors refuse incomplete multibyte sequences at EOF", async (t) => {
  const cwd = await fixture(
    t,
    Buffer.concat([
      Buffer.from("export const value = 1;\n"),
      Buffer.from([0xf0, 0x9f, 0x98]),
    ]),
  );
  const scan = await scanRange(cwd, "source.ts", undefined, undefined, exec);
  assert.equal(scan.ok, false);
  if (!scan.ok) assert.match(scan.error, /source.ts.*not UTF-8 text/);
  const find = await collectSearchExcerpts(
    cwd,
    ["source.ts"],
    [],
    undefined,
    exec,
  );
  assert.ok(find.ok);
  assert.deepEqual(find.limits, [
    { path: "source.ts", reason: "not UTF-8 text" },
  ]);
  assert.equal(find.files["source.ts"], undefined);
});

test("invalid worktree diff sides remain unjudged", async (t) => {
  const cwd = await fixture(t, "export const value = 1;\n");
  await writeFile(join(cwd, "source.ts"), Buffer.from([0xe9]));
  const diff = await collectDiff(exec, { cwd, base: "HEAD" });
  assert.ok(diff.ok);
  assert.equal(
    diff.files.find((file) => file.path === "source.ts")?.limitation,
    "not UTF-8 text",
  );
});

for (const large of [false, true]) {
  test(`risk leaves ${large ? "oversized" : "small"} invalid source unchecked without sending replacement text`, async (t) => {
    const prefix = large ? "// padding\n".repeat(12000) : "";
    const cwd = await fixture(t, `${prefix}export const value = 'valid';\n`);
    await writeFile(
      join(cwd, "source.ts"),
      Buffer.concat([
        Buffer.from(`${prefix}export const value = 'caf`),
        Buffer.from([0xe9]),
        Buffer.from("';\n"),
      ]),
    );
    const host = detectHost({});
    const tool = createCheckDiffTool({
      client: {
        clearCache() {},
        async judge() {
          throw new Error("Unreadable source must not reach Jev");
        },
      },
      host,
      runtime: { session: new Session({}), guide: new Guide(host) },
      exec,
    });
    const result = await tool.execute(
      "utf8",
      { check: "risk", base: "HEAD", witnesses: "off" },
      undefined,
      undefined,
      { cwd },
    );
    assert.match(result.content[0]?.text ?? "", /source unavailable|unchecked/);
    assert.match(result.content[0]?.text ?? "", /not UTF-8 text/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /risk: no findings/);
  });
}

for (const readableChange of [false, true]) {
  test(`spec leaves invalid source unchecked${readableChange ? " alongside readable changes" : ""}`, async (t) => {
    const cwd = await fixture(t, "export const value = 1;\n");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "SPEC.md"), "### REQ-1 Value\nReturn one.\n");
    for (const [file, prefix] of [
      ["small.ts", ""],
      ["big.ts", "// padding\n".repeat(12000)],
    ] as const) {
      await writeFile(
        join(cwd, "src", file),
        `${prefix}export const name = 'valid';\n`,
      );
    }
    await execute("git", ["add", "."], { cwd });
    await execute("git", ["commit", "-qm", "spec fixture"], { cwd });
    for (const [file, prefix] of [
      ["small.ts", ""],
      ["big.ts", "// padding\n".repeat(12000)],
    ] as const) {
      await writeFile(
        join(cwd, "src", file),
        Buffer.concat([
          Buffer.from(`${prefix}export const name = 'caf`),
          Buffer.from([0xe9]),
          Buffer.from("';\n"),
        ]),
      );
    }
    if (readableChange)
      await writeFile(join(cwd, "source.ts"), "export const value = 2;\n");
    const host = detectHost({});
    const tool = createCheckDiffTool({
      client: {
        clearCache() {},
        async judge(state, questions) {
          assert.doesNotMatch(JSON.stringify(state), /src\/(small|big)\.ts/);
          return {
            ok: true,
            calls: 1,
            answers: Object.fromEntries(
              Object.keys(questions).map((id) => [
                id,
                {
                  type: "choice" as const,
                  source: "fresh" as const,
                  choice: id === "drift" ? "none" : "not_touched",
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    Object.entries(
                      questions[id]?.type === "choice"
                        ? questions[id].criteria
                        : {},
                    ).map(([choice]) => [
                      choice,
                      choice === (id === "drift" ? "none" : "not_touched")
                        ? 1
                        : 0,
                    ]),
                  ),
                },
              ]),
            ),
          };
        },
      },
      host,
      runtime: { session: new Session({}), guide: new Guide(host) },
      exec,
    });
    const result = await tool.execute(
      "utf8",
      { check: "spec", base: "HEAD", spec_path: "SPEC.md" },
      undefined,
      undefined,
      { cwd },
    );
    assert.ok(
      result.details.result.diagnostics.some(
        (diagnostic) => diagnostic.cause === "binary_or_non_utf8",
      ),
    );
    for (const path of ["src/small.ts", "src/big.ts"])
      assert.ok(
        result.details.result.diagnostics.some(
          (diagnostic) =>
            diagnostic.target.status === "known" &&
            diagnostic.target.value === path,
        ),
      );
    assert.equal(
      result.details.result.execution,
      readableChange ? "partial" : "not_judged",
    );
  });
}

test("ask historical proof rejects malformed UTF-8 and preserves verified replacement characters", async (t) => {
  for (const bytes of [
    Buffer.from([0xe9]),
    Buffer.from([0xf0, 0x9f, 0x98]),
    Buffer.from("valid \uFFFD"),
  ]) {
    const cwd = await fixture(t, bytes);
    const repository = await collectAskRepository(exec, cwd, "HEAD");
    assert.ok(repository.ok);
    const before = await repository.readBefore("source.ts");
    if (bytes.toString().startsWith("valid")) {
      assert.ok(before.ok);
      assert.equal(before.text, "valid \uFFFD");
    } else {
      assert.equal(before.ok, false);
      if (!before.ok) assert.match(before.error, /source.ts.*not UTF-8 text/);
    }
  }
  const cwd = await fixture(t, "valid historical text");
  const repository = await collectAskRepository(
    async (command, args, options) => {
      if (args[0] === "check-ignore")
        throw new Error("historical admission execution failed");
      return exec(command, args, options);
    },
    cwd,
    "HEAD",
  );
  assert.ok(repository.ok);
  const before = await repository.readBefore("source.ts");
  assert.deepEqual(before, {
    ok: false,
    error: "Error: historical admission execution failed",
  });
  assert.strictEqual(await repository.readBefore("source.ts"), before);
});

test("NUL-containing binary inventory sources retain their existing empty-text contract", async (t) => {
  const cwd = await fixture(t, Buffer.from([0, 0xe9]));
  const inventory = await collectTestInventory(exec, cwd);
  assert.ok(inventory.ok);
  assert.deepEqual(await inventory.read("source.ts"), {
    path: "source.ts",
    text: "",
  });
  assert.equal(inventory.limits.length, 0);
});
