import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { killTree } from "../src/adapters/exec.ts";
import { resolveShell } from "../src/adapters/shell.ts";

const dir = await mkdtemp(join(tmpdir(), "jev-native-tree-"));
const started = join(dir, "started").replaceAll("\\", "/");
const survived = join(dir, "survived");
const shell = resolveShell();
if (!shell.ok) throw new Error(shell.error);
const child = spawn(
  shell.executable,
  [
    ...shell.prefix,
    "-c",
    `bash -c 'trap "" TERM; echo "$BASHPID $PPID" > "${started}"; sleep 30; echo survived > "${survived.replaceAll("\\", "/")}"' & wait`,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
try {
  const until = Date.now() + 10_000;
  while (!existsSync(started)) {
    if (Date.now() > until) throw new Error("start missing");
    await delay(25);
  }
  console.log(
    "[DEBUG-native-tree] root=" +
      child.pid +
      " bash=" +
      (await readFile(started, "utf8")),
  );
  console.log(
    "[DEBUG-native-tree] msys " +
      execFileSync(shell.executable, ["-c", "ps -e; ps -W"], {
        encoding: "utf8",
      }),
  );
  const system = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = join(
    system,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const snapshot =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'bash|sleep|node' } | Select-Object Name,ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
  console.log(
    "[DEBUG-native-tree] before " +
      execFileSync(powershell, ["-NoProfile", "-Command", snapshot], {
        encoding: "utf8",
      }),
  );
  await killTree(child);
  console.log("[DEBUG-native-tree] managed tree termination completed");
  console.log(
    "[DEBUG-native-tree] after " +
      execFileSync(powershell, ["-NoProfile", "-Command", snapshot], {
        encoding: "utf8",
      }),
  );
  await delay(30_500);
  console.log(`[DEBUG-native-tree] survived=${existsSync(survived)}`);
  assert.equal(
    existsSync(survived),
    false,
    "managed descendant survived cleanup",
  );
} finally {
  child.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
}
