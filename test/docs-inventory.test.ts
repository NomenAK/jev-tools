import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { collectDocsInventory } from "../src/adapters/docs.ts";
import { STATE_MAX_CHARS } from "../src/constants.ts";
import type { GitExec } from "../src/core/git.ts";

const execute = promisify(execFile);
const exec: GitExec = async (command, args, options) => ({
  ...(await execute(command, args, options)),
  code: 0,
  killed: false,
});
test("docs inventory excludes ignored files and refuses external links, binary and oversized evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-inventory-"));
  const cwd = join(root, "repo");
  try {
    await mkdir(cwd);
    await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
    await writeFile(join(cwd, ".gitignore"), "private.md\n");
    await writeFile(join(cwd, "private.md"), "SECRET_IGNORED");
    await writeFile(join(root, "outside.md"), "SECRET_EXTERNAL");
    await symlink(join(root, "outside.md"), join(cwd, "linked.md"));
    await writeFile(join(cwd, "README.md"), "# Public\nTracked documentation.");
    await writeFile(join(cwd, "binary.md"), "binary\0payload");
    await writeFile(join(cwd, "large.md"), "x".repeat(STATE_MAX_CHARS * 4 + 1));
    await exec("git", ["add", "."], { cwd, timeout: 10000 });
    const result = await collectDocsInventory(exec, cwd);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.files, [
      { path: "README.md", text: "# Public\nTracked documentation." },
    ]);
    assert.deepEqual(result.limits.map((limit) => limit.path).sort(), [
      "binary.md",
      "large.md",
      "linked.md",
    ]);
    assert.equal(result.tracked.has("private.md"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
