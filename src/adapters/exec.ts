import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  PROCESS_KILL_GRACE_MS,
  PROCESS_PIPE_GRACE_MS,
  PROCESS_TREE_TIMEOUT_MS,
} from "../constants.ts";
import type { GitExec } from "../core/git.ts";

/** Signal the managed process group, or await Windows process-tree termination. */
export async function killTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === "win32") {
    const taskkill = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "taskkill.exe",
    );
    const pids = [pid];
    // MSYS fork/exec can leave Windows parent IDs pointing at vanished helper
    // processes. Use the same Bash installation's POSIX table before killing
    // the root; taskkill /T alone cannot find those ordinary descendants.
    if (basename(child.spawnfile).toLowerCase() === "bash.exe") {
      const directory = dirname(child.spawnfile);
      const ps = [
        join(directory, "ps.exe"),
        join(directory, "..", "usr", "bin", "ps.exe"),
      ].find(existsSync);
      if (ps) {
        const snapshot = Promise.withResolvers<string>();
        execFile(
          ps,
          ["-e"],
          { windowsHide: true, timeout: PROCESS_TREE_TIMEOUT_MS },
          (error, stdout) => snapshot.resolve(error ? "" : stdout),
        );
        const rows = [];
        for (const line of (await snapshot.promise).split("\n")) {
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(line);
          if (!match) continue;
          rows.push({
            pid: Number(match[1]),
            parent: Number(match[2]),
            windows: Number(match[4]),
          });
        }
        const root = rows.find((row) => row.windows === pid);
        if (root) {
          const managed = new Set([root.pid]);
          let added = true;
          while (added) {
            added = false;
            for (const row of rows) {
              if (!managed.has(row.pid) && managed.has(row.parent)) {
                managed.add(row.pid);
                if (row.windows > 0) pids.push(row.windows);
                added = true;
              }
            }
          }
        }
      }
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    execFile(
      taskkill,
      [...new Set(pids)]
        .flatMap((target) => ["/PID", String(target)])
        .concat("/T", "/F"),
      { windowsHide: true, timeout: PROCESS_TREE_TIMEOUT_MS },
      (error) => {
        if (error) child.kill();
        resolve();
      },
    );
    await promise;
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
  return;
}

function groupExists(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

/**
 * Capture a process without a shell. Timeout and abort finish tree termination
 * before resolving, even when the direct child exits before its descendants.
 * Deliberately detached descendants are not sandboxed or tracked.
 */
export const spawnExec: GitExec = (command, args, options) => {
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>();
  const posix = process.platform !== "win32";
  // Git's bin/bash.exe forwards to usr/bin/bash.exe. Spawn the MSYS process
  // directly so its Windows PID can be matched in the POSIX process table.
  if (!posix && basename(command).toLowerCase() === "bash.exe") {
    const direct = join(dirname(command), "..", "usr", "bin", "bash.exe");
    if (existsSync(direct)) command = direct;
  }
  const child = spawn(command, args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: posix,
  });
  let stdout = "";
  let stderr = "";
  let killed = false;
  let spawned = false;
  let settled = false;
  let finishing = false;
  let force: NodeJS.Timeout | undefined;
  let pipes: NodeJS.Timeout | undefined;
  let termination: Promise<void> | undefined;
  let terminated: (() => void) | undefined;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const kill = () => {
    if (killed || settled) return;
    killed = true;
    if (posix) {
      void killTree(child, "SIGTERM");
      const completion = Promise.withResolvers<void>();
      termination = completion.promise;
      terminated = completion.resolve;
      // Keep this timer referenced: a closing transport must not exit
      // before a surviving member of the managed group receives SIGKILL.
      force = setTimeout(() => {
        void killTree(child, "SIGKILL");
        completion.resolve();
      }, PROCESS_KILL_GRACE_MS);
    } else termination = killTree(child);
  };
  const timer =
    options.timeout > 0 ? setTimeout(kill, options.timeout) : undefined;
  if (options.signal?.aborted) kill();
  else options.signal?.addEventListener("abort", kill, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(force);
    clearTimeout(pipes);
    options.signal?.removeEventListener("abort", kill);
  };
  const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled || finishing) return;
    finishing = true;
    clearTimeout(pipes);
    if (posix && terminated && !groupExists(child)) {
      clearTimeout(force);
      terminated();
    }
    if (termination) await termination;
    settled = true;
    cleanup();
    resolve({
      stdout,
      stderr,
      code: code ?? (signal ? 128 + signalNumber(signal) : 1),
      killed,
    });
  };
  child.on("spawn", () => {
    spawned = true;
  });
  child.on("error", (error) => {
    if (spawned) return;
    settled = true;
    cleanup();
    reject(error);
  });
  child.on("exit", (code, signal) => {
    // An escaped descendant may hold inherited pipes open indefinitely.
    pipes = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      void finish(code, signal);
    }, PROCESS_PIPE_GRACE_MS);
  });
  child.on("close", (code, signal) => {
    void finish(code, signal);
  });
  return promise;
};

function signalNumber(signal: NodeJS.Signals): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return numbers[signal] ?? 0;
}
