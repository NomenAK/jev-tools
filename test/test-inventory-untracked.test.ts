import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { collectTestInventory } from "../src/adapters/test-inventory.ts";
import { TEST_SOURCE_MAX_BYTES } from "../src/constants.ts";
import type { GitExec } from "../src/core/git.ts";
import { buildImportGraph, importClosure } from "../src/core/imports.ts";

const execute = promisify(execFile);
const exec: GitExec = async (command, args, options) => {
  try {
    return {
      ...(await execute(command, args, options)),
      code: 0,
      killed: false,
    };
  } catch (error) {
    const result = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
    };
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.message,
      code: typeof result.code === "number" ? result.code : 2,
      killed: result.killed ?? false,
    };
  }
};

async function fixture(t: test.TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "test-inventory-untracked-"));
  const outside = await mkdtemp(join(tmpdir(), "test-inventory-outside-"));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await execute("git", ["init", "-q"], { cwd });
  await execute("git", ["config", "core.excludesFile", "/dev/null"], { cwd });
  await writeFile(join(cwd, ".gitignore"), "ignored*.test.ts\n");
  await writeFile(join(cwd, "tracked.ts"), "export const tracked = true;\n");
  await writeFile(
    join(cwd, "ignored-tracked.test.ts"),
    "secret tracked content",
  );
  await execute("git", ["add", ".gitignore", "tracked.ts"], { cwd });
  await execute("git", ["add", "-f", "ignored-tracked.test.ts"], { cwd });
  const text = "import test from 'node:test';\ntest('new', () => {});\n";
  await writeFile(join(cwd, "new.test.ts"), text);
  await writeFile(join(cwd, "ignored-new.test.ts"), "secret untracked content");
  await writeFile(
    join(outside, "external.test.ts"),
    "outside repository content",
  );
  await symlink(
    join(outside, "external.test.ts"),
    join(cwd, "outside.test.ts"),
  );
  return { cwd, text };
}

test("inventory admits untracked nonignored sources alongside tracked sources", async (t) => {
  const { cwd, text } = await fixture(t);
  const result = await collectTestInventory(exec, cwd);
  assert.ok(result.ok);
  assert.deepEqual(await result.read("new.test.ts"), {
    path: "new.test.ts",
    text,
  });
  assert.deepEqual(await result.read("tracked.ts"), {
    path: "tracked.ts",
    text: "export const tracked = true;\n",
  });
});

test("inventory excludes both ignored untracked and ignored tracked sources", async (t) => {
  const { cwd } = await fixture(t);
  const result = await collectTestInventory(exec, cwd);
  assert.ok(result.ok);
  for (const path of ["ignored-new.test.ts", "ignored-tracked.test.ts"]) {
    assert.equal(result.paths.includes(path), false);
    assert.equal(
      result.limits.some((limit) => limit.path === path),
      false,
    );
  }
});

test("tracked ignored workspace configuration resolves imports without admitting untracked ignored manifests", async (t) => {
  const { cwd } = await fixture(t);
  await mkdir(join(cwd, "packages/lib/src"), { recursive: true });
  await writeFile(
    join(cwd, ".gitignore"),
    "**/package.json\ntsconfig*.json\nignored*.test.ts\n",
  );
  const files = {
    "packages/lib/package.json":
      '{"name":"@acme/lib","exports":{".":"./src/value.ts"}}',
    "packages/lib/src/value.ts": "export const value = 1;",
    "tsconfig.paths.json":
      '{"compilerOptions":{"paths":{"@value":["packages/lib/src/value.ts"]}}}',
    "workspace.test.ts": "import { value } from '@acme/lib'; import '@value';",
    "package.json": '{"name":"excluded-untracked"}',
  };
  for (const [path, text] of Object.entries(files))
    await writeFile(join(cwd, path), text);
  await execute(
    "git",
    [
      "add",
      "-f",
      "packages/lib/package.json",
      "packages/lib/src/value.ts",
      "tsconfig.paths.json",
      "workspace.test.ts",
    ],
    { cwd },
  );
  const result = await collectTestInventory(exec, cwd);
  assert.ok(result.ok);
  assert.equal(result.paths.includes("package.json"), false);
  assert.equal(await result.read("package.json"), undefined);
  const sources = await Promise.all(
    result.paths.map((path) => result.read(path)),
  );
  const graph = buildImportGraph(
    sources.filter((source) => source !== undefined),
  );
  assert.ok(
    importClosure(graph, "workspace.test.ts").paths.includes(
      "packages/lib/src/value.ts",
    ),
  );
  assert.deepEqual(
    graph.limits.filter((limit) => limit.path === "workspace.test.ts"),
    [],
  );
});

test("inventory applies repository admission to untracked outside symlinks", async (t) => {
  const { cwd } = await fixture(t);
  const result = await collectTestInventory(exec, cwd);
  assert.ok(result.ok);
  assert.equal(await result.read("outside.test.ts"), undefined);
  assert.deepEqual(result.limits, [
    { path: "outside.test.ts", kind: "unreadable" },
  ]);
});

test("the inventory reports unreadable entries before any lazy read", async (t) => {
  const { cwd } = await fixture(t);
  await writeFile(join(cwd, "noncandidate.txt"), "tracked content");
  await execute("git", ["add", "noncandidate.txt"], { cwd });
  await rm(join(cwd, "noncandidate.txt"));
  await mkdir(join(cwd, "noncandidate.txt"));
  await symlink(".git/config", join(cwd, "metadata.txt"));
  await symlink("ignored-new.test.ts", join(cwd, "ignored-link.txt"));
  const result = await collectTestInventory(exec, cwd);
  assert.ok(result.ok);
  assert.deepEqual(
    [...result.limits].sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "ignored-link.txt", kind: "unreadable" },
      { path: "metadata.txt", kind: "unreadable" },
      { path: "noncandidate.txt", kind: "unreadable" },
      { path: "outside.test.ts", kind: "unreadable" },
    ],
  );
  assert.equal(await result.read("noncandidate.txt"), undefined);
  assert.equal(await result.read("outside.test.ts"), undefined);
  assert.equal(result.limits.length, 4);
});

test("oversized sources are limited before any lazy read", async (t) => {
  const { cwd } = await fixture(t);
  await writeFile(
    join(cwd, "large.txt"),
    "x".repeat(TEST_SOURCE_MAX_BYTES + 1),
  );
  const result = await collectTestInventory(exec, cwd);
  assert.ok(result.ok);
  assert.ok(
    result.limits.some(
      (limit) => limit.path === "large.txt" && limit.kind === "too_large",
    ),
  );
  assert.equal(await result.read("large.txt"), undefined);
  assert.equal(
    result.limits.filter((limit) => limit.path === "large.txt").length,
    1,
  );
});
