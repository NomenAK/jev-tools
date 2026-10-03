import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalPath } from "../src/adapters/canonical-path.ts";
import {
  isWslLauncher,
  resolveShell,
  windowsBashCandidates,
} from "../src/adapters/shell.ts";
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
      ok: true,
      executable: "env",
      prefix: ["CI=1", "bash"],
      scriptPrefix: "",
    },
  );
});

// The Windows scenarios below run on every host: they must not depend on the
// host's path delimiter or separator (public CI is Linux).
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
  assert.ok(candidates.length > 0);
  assert.ok(!candidates.some((path) => /system32|windowsapps/i.test(path)));
  assert.ok(
    candidates.every((path) => /^[A-Z]:\\/.test(path)),
    candidates.join(),
  );
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  assert.ok(candidates.includes(gitBash));
  const shell = resolveShell("win32", env, (path) => path === gitBash);
  assert.deepEqual(shell, {
    ok: true,
    executable: gitBash,
    prefix: [],
    scriptPrefix: "export CI=1; ",
  });
});

test("JEV_TOOLS_BASH overrides discovery on Windows", () => {
  const shell = resolveShell(
    "win32",
    { JEV_TOOLS_BASH: "D:\\tools\\bash.exe", PATH: "" },
    () => true,
  );
  assert.ok(shell.ok);
  assert.equal(shell.executable, "D:\\tools\\bash.exe");
});

test("Windows fails closed instead of returning a bare bash name", () => {
  // Only WSL launchers exist: the old fallback returned "bash.exe", which the
  // process runner would resolve through PATH to System32 again.
  const env = {
    PATH: "C:\\Windows\\System32;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps",
  };
  const shell = resolveShell("win32", env, (path) => isWslLauncher(path));
  assert.equal(shell.ok, false);
  assert.match(shell.ok ? "" : shell.error, /No permitted bash/);
  assert.equal(resolveShell("win32", { PATH: "" }, () => false).ok, false);
});

test("an explicit or relative JEV_TOOLS_BASH cannot select a WSL launcher", () => {
  for (const JEV_TOOLS_BASH of [
    "C:\\Windows\\System32\\bash.exe",
    "c:\\windows\\SYSTEM32\\..\\System32\\bash.exe",
    "C:\\Windows\\SysWOW64\\bash.exe",
    "C:\\Windows\\Sysnative\\bash.exe",
    "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe",
    "bash.exe",
  ]) {
    const shell = resolveShell(
      "win32",
      { JEV_TOOLS_BASH, PATH: "" },
      () => true,
    );
    assert.equal(shell.ok, false, JEV_TOOLS_BASH);
  }
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
