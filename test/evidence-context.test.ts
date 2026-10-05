import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { resolveEvidenceContext } from "../src/adapters/evidence-context.ts";
import { spawnExec } from "../src/adapters/exec.ts";

test("root override admits only exact same-repository live worktree tops without links or traversal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-context-"));
  const primary = join(directory, "primary");
  const alternate = join(directory, 'alternate 日本 "quoted"');
  const unrelated = join(directory, "unrelated");
  const git = async (cwd: string, args: string[]) => {
    const result = await spawnExec("git", args, { cwd, timeout: 10000 });
    assert.equal(result.code, 0, result.stderr);
  };
  try {
    await mkdir(primary);
    await mkdir(unrelated);
    await git(primary, ["init"]);
    await git(primary, ["config", "user.email", "test@example.invalid"]);
    await git(primary, ["config", "user.name", "Test"]);
    await writeFile(join(primary, "same.txt"), "primary");
    await git(primary, ["add", "."]);
    await git(primary, ["commit", "-m", "fixture"]);
    await git(primary, ["worktree", "add", "-b", "alternate", alternate]);
    await writeFile(join(alternate, "same.txt"), "alternate");
    await mkdir(join(primary, "subdir"));
    await git(unrelated, ["init"]);
    await symlink(alternate, join(directory, "linked"));
    const initial = join(primary, "subdir");
    const noRoot = await resolveEvidenceContext(initial, undefined, {
      exec: spawnExec,
    });
    assert.equal(noRoot.ok, true);
    if (noRoot.ok) assert.equal(noRoot.cwd, initial);
    for (const root of [primary, alternate, relative(initial, alternate)]) {
      // A relative path with parent traversal is forbidden even if it reaches a registered worktree.
      const result = await resolveEvidenceContext(initial, root, {
        exec: spawnExec,
      });
      if (root.includes("..")) assert.equal(result.ok, false);
      else {
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.cwd, root);
      }
    }
    const relativeRoot = await resolveEvidenceContext(directory, "primary", {
      exec: spawnExec,
    });
    assert.equal(
      relativeRoot.ok,
      false,
      "initial authority must itself belong to Git",
    );
    await mkdir(join(primary, "nested"));
    for (const root of [
      "",
      "../primary",
      join(primary, "nested"),
      unrelated,
      join(directory, "linked"),
      join(directory, "absent"),
    ]) {
      const result = await resolveEvidenceContext(initial, root, {
        exec: spawnExec,
      });
      assert.equal(result.ok, false, root);
      assert.equal(result.context.effectiveRoot, undefined);
      assert.equal(result.context.requestedRoot, root);
    }
    const concurrent = await Promise.all(
      [primary, alternate].map((root) =>
        resolveEvidenceContext(primary, root, { exec: spawnExec }),
      ),
    );
    assert.ok(concurrent.every((result) => result.ok));
    const contents = await Promise.all(
      concurrent.map((result) =>
        result.ok ? readFile(join(result.cwd, "same.txt"), "utf8") : "",
      ),
    );
    assert.deepEqual(contents, ["primary", "alternate"]);
    await rm(alternate, { recursive: true, force: true });
    assert.equal(
      (await resolveEvidenceContext(primary, alternate, { exec: spawnExec }))
        .ok,
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("relative exact top and trusted server origin are admitted; inaccessible authority stays unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-context-origin-"));
  try {
    const initialized = await spawnExec("git", ["init"], {
      cwd: directory,
      timeout: 10000,
    });
    assert.equal(initialized.code, 0);
    const result = await resolveEvidenceContext(directory, ".", {
      exec: spawnExec,
      origin: "server",
    });
    assert.equal(result.ok, true);
    assert.equal(result.context.authority.origin, "server");
    assert.equal(result.context.effectiveRoot?.origin, "override");
    const invalid = await resolveEvidenceContext(
      join(directory, "absent"),
      ".",
      { exec: spawnExec },
    );
    assert.equal(invalid.ok, false);
    assert.ok(invalid.context.authorityReason);
    assert.equal(invalid.context.effectiveRoot, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
