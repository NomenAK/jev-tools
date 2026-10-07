import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { shareGitTree } from "../src/adapters/git-inventory.ts";
import type { GitExec } from "../src/core/git.ts";

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
    };
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? result.message),
      code: typeof result.code === "number" ? result.code : 2,
      killed: false,
    };
  }
};
// The settings collectDiff prefixes its commands with. The caller search runs
// the same two lookups bare.
const config = [
  "-c",
  "color.ui=false",
  "-c",
  "core.quotePath=true",
  "-c",
  "diff.suppressBlankEmpty=false",
  "-c",
  "diff.relative=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.algorithm=myers",
  "-c",
  "diff.indentHeuristic=false",
];
const treeForm = (ref: string) => [
  "ls-tree",
  "-r",
  "--long",
  "-z",
  "--full-tree",
  "--end-of-options",
  ref,
];

async function repo(t: test.TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "git-tree-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec("git", ["init", "-q"], { cwd, timeout: 10_000 });
  // Paths that expose quoting and Unicode differences between forms.
  await mkdir(join(cwd, "dir with space"), { recursive: true });
  await writeFile(
    join(cwd, "dir with space", "café ünïcode.ts"),
    "export const one = 1;\n",
  );
  await writeFile(join(cwd, "plain.ts"), "export const two = 2;\n");
  await exec("git", ["add", "."], { cwd, timeout: 10_000 });
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
    { cwd, timeout: 10_000 },
  );
  await writeFile(join(cwd, "plain.ts"), "export const two = 22;\n");
  await exec("git", ["add", "."], { cwd, timeout: 10_000 });
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "second",
    ],
    { cwd, timeout: 10_000 },
  );
  return cwd;
}

test("the repository root and one base tree are spawned once for both collectors", async (t) => {
  const cwd = await repo(t);
  const nested = join(cwd, "dir with space");
  const spawns: string[][] = [];
  const shared: GitExec = shareGitTree(async (command, args, options) => {
    spawns.push(args);
    return exec(command, args, options);
  });
  const at = (cwd: string) => ({ cwd, timeout: 10_000 });
  // collectDiff's prefixed root and base tree, then collectRiskCallers' bare form.
  const root = await shared(
    "git",
    [...config, "rev-parse", "--show-toplevel"],
    at(cwd),
  );
  const bareRoot = await shared(
    "git",
    ["rev-parse", "--show-toplevel"],
    at(cwd),
  );
  const tree = await shared("git", [...config, ...treeForm("HEAD")], at(cwd));
  const bareTree = await shared("git", treeForm("HEAD"), at(cwd));
  assert.equal(spawns.length, 2, "one root and one tree, not two of each");
  // The shared result is the real lookup, not a placeholder.
  assert.equal(root.code, 0);
  assert.equal(root.stdout, bareRoot.stdout);
  assert.equal(tree.code, 0);
  assert.equal(tree.stdout, bareTree.stdout);
  // A different ref is a different tree: it must be spawned, not reused.
  // The two commits differ in blob ids, not in paths, so compare the trees.
  const second = await shared("git", treeForm("HEAD~1"), at(cwd));
  assert.equal(spawns.length, 3);
  assert.notEqual(second.stdout, tree.stdout);
  assert.equal(second.code, 0);
  // A different cwd is a different repository root, and resolves to the top.
  const nestedRoot = await shared(
    "git",
    ["rev-parse", "--show-toplevel"],
    at(nested),
  );
  assert.equal(spawns.length, 4);
  assert.equal(nestedRoot.stdout, root.stdout);
});

test("a setting or form that can change the output is never shared", async (t) => {
  const cwd = await repo(t);
  const spawns: string[][] = [];
  const shared: GitExec = shareGitTree(async (command, args, options) => {
    spawns.push(args);
    return exec(command, args, options);
  });
  const at = { cwd, timeout: 10_000 };
  // Unlisted settings bypass sharing, so a setting that does change the output
  // is still answered by git rather than by a cached result.
  for (const setting of [
    "core.abbrev=8",
    "core.bare=true",
    "i18n.logOutputEncoding=ISO-8859-1",
  ]) {
    const args = ["-c", setting, ...treeForm("HEAD")];
    await shared("git", args, at);
    await shared("git", args, at);
  }
  assert.equal(spawns.length, 6, "each unknown setting spawns every time");
  // Forms other than the two verified ones bypass sharing: --abbrev=8 shortens
  // the ids, and the bare-repository probe answers a different question.
  const abbrev = [
    "ls-tree",
    "-r",
    "--long",
    "--abbrev=8",
    "-z",
    "--full-tree",
    "--end-of-options",
    "HEAD",
  ];
  const abbrevTree = await shared("git", abbrev, at);
  await shared("git", abbrev, at);
  assert.equal(abbrevTree.code, 0);
  const full = await exec("git", treeForm("HEAD"), at);
  // The abbreviated form really is different, so reusing the shared shape
  // would be observably wrong.
  assert.notEqual(abbrevTree.stdout, full.stdout);
  const isBare = await shared("git", ["rev-parse", "--is-bare-repository"], at);
  await shared("git", ["rev-parse", "--is-bare-repository"], at);
  assert.equal(isBare.stdout.trim(), "false");
  assert.equal(spawns.length, 10);
  // Neither shared result depends on the worktree: an edit cannot change them.
  const primed = await shared("git", treeForm("HEAD"), at);
  assert.equal(spawns.length, 11);
  await writeFile(join(cwd, "plain.ts"), "export const two = 333;\n");
  const afterEdit = await exec("git", treeForm("HEAD"), at);
  assert.equal(afterEdit.stdout, full.stdout);
  assert.equal(primed.stdout, afterEdit.stdout);
  const cached = await shared("git", treeForm("HEAD"), at);
  assert.equal(cached.stdout, afterEdit.stdout);
  assert.equal(spawns.length, 11, "the cached tree is not re-spawned");
});

test("a failing shared lookup is not cached as a success", async (t) => {
  const cwd = await repo(t);
  let attempts = 0;
  const failing: GitExec = shareGitTree(async () => {
    attempts++;
    return {
      stdout: "",
      stderr: "fatal: not a git repository",
      code: 128,
      killed: false,
    };
  });
  const first = await failing("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeout: 10_000,
  });
  const second = await failing("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeout: 10_000,
  });
  // The failure is reported once and the promise is not retried forever; the
  // point is that a non-zero exit is never turned into a silent success.
  assert.equal(first.code, 128);
  assert.equal(second.code, 128);
  assert.equal(first.stderr, second.stderr);
  assert.equal(attempts, 1, "a failed lookup is still shared within the call");
});
