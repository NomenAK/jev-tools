import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { collectDiff, collectUnits } from "../src/adapters/git.ts";
import type { GitExec } from "../src/core/git.ts";

const execute = promisify(execFile);
const exec: GitExec = async (command, args, options) => {
  try {
    const result = await execute(command, args, options);
    return { ...result, code: 0, killed: false };
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
        killed: false,
      };
    throw error;
  }
};
test("constructed Git repository preserves pure rename, binary, whitespace and untracked proof", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "git-proof-"));
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    await Promise.all([
      writeFile(join(cwd, "old name.ts"), "export const value = 1;\n"),
      writeFile(join(cwd, "space.ts"), "export function f() { return 1; }\n"),
      writeFile(join(cwd, "image.bin"), Buffer.from([0, 1, 2])),
    ]);
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
    await rename(join(cwd, "old name.ts"), join(cwd, "new name.ts"));
    await exec("git", ["add", "--", "old name.ts", "new name.ts"], {
      cwd,
      timeout: 10000,
    });
    await Promise.all([
      writeFile(join(cwd, "space.ts"), "export function f() {  return 1; }\n"),
      writeFile(join(cwd, "image.bin"), Buffer.from([0, 3, 4])),
      writeFile(join(cwd, "new.py"), "def fresh():\n    return 1\n"),
    ]);
    const result = await collectUnits(exec, { cwd, base: "HEAD" });
    assert.ok(result.ok);
    const renameFile = result.files.find((file) => file.path === "new name.ts");
    assert.equal(renameFile?.oldPath, "old name.ts");
    assert.match(renameFile?.status ?? "", /^R/);
    assert.equal(
      result.files.find((file) => file.path === "image.bin")?.binary,
      true,
    );
    assert.ok(result.limits.some((limit) => limit.kind === "binary_ignored"));
    assert.equal(
      result.units.find((unit) => unit.file === "new.py")?.before,
      null,
    );
    assert.equal(
      result.units.find((unit) => unit.file === "space.ts")?.after,
      "export function f() {  return 1; }",
    );
    assert.ok(result.units.some((unit) => unit.file === "new name.ts"));
    const refusal = await collectDiff(exec, { cwd, base: "--output=bad" });
    assert.equal(refusal.ok, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("killed precedes zero exit code and omp missing binary throws become values", async () => {
  const killed = await collectDiff(
    async () => ({ stdout: "", stderr: "", code: 0, killed: true }),
    { cwd: ".", base: "HEAD" },
  );
  assert.equal(killed.ok, false);
  const missing = await collectDiff(
    async () => {
      throw new Error("ENOENT");
    },
    { cwd: ".", base: "HEAD" },
  );
  assert.equal(missing.ok, false);
});
test("root collection handles type changes, hostile config, symlinks and bounded files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "git-limits-"));
  const run = (args: string[]) => exec("git", args, { cwd, timeout: 10000 });
  try {
    await run(["init", "-q"]);
    await mkdir(join(cwd, "sub"));
    await writeFile(
      join(cwd, "sub", "a.ts"),
      "export function f() {\n\n return 1;\n}\n",
    );
    await writeFile(join(cwd, "type.txt"), "old target\n");
    await writeFile(join(cwd, "z.txt"), "before\n");
    await writeFile(join(cwd, "large.txt"), "x\n".repeat(40000));
    await symlink("missing-before", join(cwd, "link.txt"));
    await writeFile(join(cwd, "pipe"), "tracked\n");
    await run(["add", "."]);
    const tree = await run(["write-tree"]);
    const commit = await run([
      "-c",
      "user.name=Proof",
      "-c",
      "user.email=proof@example.invalid",
      "commit-tree",
      tree.stdout.trim(),
      "-m",
      "module",
    ]);
    await run([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${commit.stdout.trim()},module`,
    ]);
    await run([
      "-c",
      "user.name=Proof",
      "-c",
      "user.email=proof@example.invalid",
      "commit",
      "-qm",
      "base",
    ]);
    await unlink(join(cwd, "type.txt"));
    await symlink("missing-target", join(cwd, "type.txt"));
    await unlink(join(cwd, "link.txt"));
    await symlink("missing-after", join(cwd, "link.txt"));
    await writeFile(join(cwd, "z.txt"), "after\n");
    await writeFile(join(cwd, "large.txt"), `changed\n${"x\n".repeat(39999)}`);
    await writeFile(
      join(cwd, "sub", "a.ts"),
      "export function f() {\n\n return 2;\n}\n",
    );
    await writeFile(join(cwd, "sub", "new.txt"), "untracked\n");
    await mkdir(join(cwd, "nested"));
    await exec("git", ["init", "-q"], {
      cwd: join(cwd, "nested"),
      timeout: 10000,
    });
    const changedCommit = await run([
      "-c",
      "user.name=Proof",
      "-c",
      "user.email=proof@example.invalid",
      "commit-tree",
      tree.stdout.trim(),
      "-m",
      "changed module",
    ]);
    await run([
      "update-index",
      "--cacheinfo",
      `160000,${changedCommit.stdout.trim()},module`,
    ]);
    await unlink(join(cwd, "pipe"));
    await exec("mkfifo", [join(cwd, "pipe")], { cwd, timeout: 10000 });
    for (const [key, value] of [
      ["color.ui", "always"],
      ["diff.suppressBlankEmpty", "true"],
      ["diff.relative", "true"],
      ["diff.noprefix", "true"],
      ["diff.mnemonicPrefix", "true"],
      ["diff.external", "false"],
      ["core.quotePath", "false"],
    ] as const)
      await run(["config", key, value]);
    const result = await collectUnits(exec, {
      cwd: join(cwd, "sub"),
      base: "HEAD",
    });
    assert.ok(result.ok, result.ok ? undefined : result.error);
    assert.equal(result.files.find((f) => f.path === "type.txt")?.status, "T");
    assert.equal(
      result.files.find((f) => f.path === "type.txt")?.after,
      "missing-target",
    );
    assert.equal(
      result.files.find((f) => f.path === "type.txt")?.hunks.length,
      2,
    );
    assert.equal(
      result.files.find((f) => f.path === "type.txt")?.hunks[1]?.afterText,
      "missing-target",
    );
    assert.equal(
      result.files.find((f) => f.path === "link.txt")?.after,
      "missing-after",
    );
    assert.equal(
      result.files.find((f) => f.path === "link.txt")?.before,
      "missing-before",
    );
    assert.equal(
      result.files.find((f) => f.path === "z.txt")?.hunks[0]?.changes[0]
        ?.afterStart,
      1,
    );
    assert.equal(
      result.files.find((f) => f.path === "sub/a.ts")?.hunks[0]?.changes[0]
        ?.afterStart,
      3,
    );
    assert.equal(
      result.files.find((f) => f.path === "sub/new.txt")?.after,
      "untracked\n",
    );
    assert.ok(
      result.limits.some(
        (l) => l.kind === "too_large" && l.file === "large.txt",
      ),
    );
    assert.ok(
      result.units.some(
        (u) => u.file === "large.txt" && u.after?.includes("changed"),
      ),
    );
    assert.ok(
      result.limits.some(
        (l) => l.kind === "unreadable" && l.file.startsWith("nested"),
      ),
    );
    assert.ok(
      result.limits.some((l) => l.kind === "unreadable" && l.file === "module"),
    );
    assert.ok(
      result.limits.some((l) => l.kind === "unreadable" && l.file === "pipe"),
    );
    const scoped = await collectDiff(exec, {
      cwd: join(cwd, "sub"),
      base: "HEAD",
      paths: ["a.ts"],
    });
    assert.ok(scoped.ok);
    assert.deepEqual(
      scoped.files.map((f) => f.path),
      ["sub/a.ts"],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("unchanged submodules disappear; nested untracked status and symlink cwd are preserved", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "git-candidates-"));
  const run = (args: string[]) => exec("git", args, { cwd, timeout: 10000 });
  try {
    await run(["init", "-q"]);
    await mkdir(join(cwd, "sub"));
    await writeFile(join(cwd, "sub", "a.txt"), "before\n");
    await run(["add", "."]);
    const tree = await run(["write-tree"]);
    const commit = await run([
      "-c",
      "user.name=Proof",
      "-c",
      "user.email=proof@example.invalid",
      "commit-tree",
      tree.stdout.trim(),
      "-m",
      "module",
    ]);
    await run([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${commit.stdout.trim()},module`,
    ]);
    await run([
      "-c",
      "user.name=Proof",
      "-c",
      "user.email=proof@example.invalid",
      "commit",
      "-qm",
      "base",
    ]);
    await mkdir(join(cwd, "module"));
    const unchanged = await collectDiff(exec, { cwd, base: "HEAD" });
    assert.ok(unchanged.ok);
    assert.deepEqual(unchanged.files, []);
    await mkdir(join(cwd, "nested"));
    await exec("git", ["init", "-q"], {
      cwd: join(cwd, "nested"),
      timeout: 10000,
    });
    const nested = await collectDiff(exec, { cwd, base: "HEAD" });
    assert.ok(nested.ok);
    assert.equal(
      nested.files.find((f) => f.path.startsWith("nested"))?.status,
      "?",
    );
    assert.ok(!nested.files.some((f) => f.path === "module"));
    await writeFile(join(cwd, "sub", "a.txt"), "after\n");
    await symlink(join(cwd, "sub"), join(cwd, "alias"));
    const linked = await collectDiff(exec, {
      cwd: join(cwd, "alias"),
      base: "HEAD",
      paths: ["a.txt"],
    });
    assert.ok(linked.ok);
    assert.deepEqual(
      linked.files.map((f) => f.path),
      ["sub/a.txt"],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("inconsistent git snapshots are retryable values", async () => {
  const fake: GitExec = async (_command, args) => {
    const stdout = args.includes("--show-toplevel")
      ? process.cwd()
      : args.includes("--numstat")
        ? "1\t1\tmissing.ts\0"
        : args.includes("--raw")
          ? ":100644 100644 aaaa bbbb M\0actual.ts\0"
          : "";
    return { stdout, stderr: "", code: 0, killed: false };
  };
  const result = await collectDiff(fake, { cwd: process.cwd(), base: "HEAD" });
  assert.ok(!result.ok);
  assert.equal("kind" in result && result.kind, "inconsistent_diff");
});

test("a tracked file replaced by a directory remains unreadable without collecting descendants", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "git-replacement-"));
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    await writeFile(join(cwd, "a"), "before\n");
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
    await rm(join(cwd, "a"));
    await mkdir(join(cwd, "a"));
    await writeFile(
      join(cwd, "a/x.ts"),
      "not collectable through unreadable replacement\n",
    );
    const result = await collectDiff(exec, { cwd, base: "HEAD" });
    assert.ok(result.ok);
    assert.deepEqual(
      result.files.map(({ path, status, limitation }) => ({
        path,
        status,
        limitation,
      })),
      [{ path: "a", status: "D", limitation: "unreadable" }],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("host-decoded historical blobs preserve UTF-8 boundaries and isolate invalid bytes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "git-host-blobs-"));
  try {
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    const originals = {
      "a.ts": "export const first = 'é😀';\n",
      "b.ts": "export const second = '終';\n",
    };
    for (const [path, text] of Object.entries(originals))
      await writeFile(join(cwd, path), text);
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
    for (const path of Object.keys(originals))
      await writeFile(join(cwd, path), "export const changed = 2;\n");
    const calls: string[][] = [];
    const host: GitExec = async (command, args, options) => {
      calls.push(args);
      return exec(command, args, options);
    };
    const valid = await collectDiff(host, { cwd, base: "HEAD" });
    assert.ok(valid.ok);
    assert.deepEqual(
      Object.fromEntries(valid.files.map((file) => [file.path, file.before])),
      originals,
    );
    assert.equal(calls.filter((args) => args.includes("show")).length, 1);
    await writeFile(join(cwd, "a.ts"), Buffer.from([0x65, 0x78, 0xe9, 10]));
    await exec("git", ["add", "a.ts"], { cwd, timeout: 10000 });
    await exec(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "non utf8",
      ],
      { cwd, timeout: 10000 },
    );
    await writeFile(join(cwd, "a.ts"), "export const changed = 3;\n");
    calls.length = 0;
    const invalid = await collectDiff(host, { cwd, base: "HEAD" });
    assert.ok(invalid.ok);
    assert.equal(
      invalid.files.find((file) => file.path === "a.ts")?.limitation,
      "not UTF-8 text",
    );
    assert.equal(
      invalid.files.find((file) => file.path === "b.ts")?.before,
      originals["b.ts"],
    );
    assert.equal(calls.filter((args) => args.includes("show")).length, 3);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
