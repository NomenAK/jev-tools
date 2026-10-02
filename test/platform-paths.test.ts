import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalPath } from "../src/adapters/canonical-path.ts";
import { resolveShell, windowsBashCandidates } from "../src/adapters/shell.ts";
import { nodeTestPath } from "../src/core/command-output.ts";

test("node:test file URLs become plain decoded paths on both platforms", () => {
  assert.equal(nodeTestPath("file:///repo/a b/x.mjs"), "/repo/a b/x.mjs");
  assert.equal(
    nodeTestPath("file:///C:/Users/A%20B/repo/bill.mjs"),
    "C:/Users/A B/repo/bill.mjs",
  );
  assert.equal(nodeTestPath("test/bill.mjs"), "test/bill.mjs");
  assert.equal(nodeTestPath("file:///bad%zzpath"), "/bad%zzpath");
});

test("POSIX shell invocation is unchanged", () => {
  assert.deepEqual(
    resolveShell("linux", {}, () => false),
    {
      executable: "env",
      prefix: ["CI=1", "bash"],
      scriptPrefix: "",
    },
  );
});

test("Windows never selects the WSL bash launchers", () => {
  const env = {
    PATH: [
      "C:\\Windows\\System32",
      "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps",
      "C:\\Program Files\\Git\\cmd",
    ].join(";"),
    ProgramFiles: "C:\\Program Files",
  };
  const candidates = windowsBashCandidates(env);
  assert.ok(!candidates.some((path) => /system32|windowsapps/i.test(path)));
  const gitBash = join("C:\\Program Files\\Git", "bin", "bash.exe");
  const shell = resolveShell("win32", env, (path) => path === gitBash);
  assert.equal(shell.executable, gitBash);
  assert.deepEqual(shell.prefix, []);
  assert.equal(shell.scriptPrefix, "export CI=1; ");
});

test("JEV_TOOLS_BASH overrides discovery on Windows", () => {
  const shell = resolveShell(
    "win32",
    { JEV_TOOLS_BASH: "D:\\tools\\bash.exe", PATH: "" },
    () => true,
  );
  assert.equal(shell.executable, "D:\\tools\\bash.exe");
});

test("canonicalPath expands 8.3 short names and tolerates missing paths", async (t) => {
  const temp = tmpdir();
  const native = realpathSync.native(temp);
  if (native === temp)
    t.diagnostic("temporary directory is already canonical on this host");
  assert.equal(await canonicalPath(temp), native);
  const missing = join(temp, "jev-definitely-missing-path");
  assert.equal(await canonicalPath(missing), missing);
});
