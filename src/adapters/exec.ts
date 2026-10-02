import { type ChildProcess, execFile, spawn } from "node:child_process";
import { join } from "node:path";
import type { GitExec } from "../core/git.ts";

/** How long a terminated tree gets before it is killed outright. */
const KILL_GRACE_MS = 2_000;
/** How long to wait for inherited pipes to close after the process exits. */
const PIPE_GRACE_MS = 1_000;

/**
 * Stop a process and everything it started. Signalling only the spawned PID
 * leaves descendants running: captureCommand runs the caller's command in a
 * bash subshell, which keeps running after its parent bash is killed (see
 * https://nodejs.org/api/child_process.html#subprocesskillsignal).
 *
 * POSIX: the child leads its own process group (`detached`), so a negative
 * PID signals the whole group. Windows has no process groups or SIGTERM;
 * `taskkill /T /F` terminates the process tree.
 */
export function killTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  platform: NodeJS.Platform = process.platform,
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === "win32") {
    // A fixed system path, so a taskkill.exe earlier on PATH is never used.
    const taskkill = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "taskkill.exe",
    );
    execFile(
      taskkill,
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true },
      (error) => {
        // Already gone, or taskkill unavailable: still stop the direct child.
        if (error) child.kill();
      },
    );
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is gone already, or the child never became a group leader.
    child.kill(signal);
  }
}

/**
 * Host-independent process execution with the same contract the pi/omp
 * `exec` provides to the tools: no shell, captured UTF-8 streams, `killed`
 * set on timeout or abort. A missing executable rejects, which the tools
 * already report as unavailable evidence. Timeout and abort stop the whole
 * process tree, not only the spawned process.
 */
export const spawnExec: GitExec = (command, args, options) =>
  new Promise((resolve, reject) => {
    const posix = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // POSIX: make the child a process group leader so killTree reaches its
      // descendants. On Windows `detached` would open a new console instead.
      detached: posix,
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let spawned = false;
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    let force: NodeJS.Timeout | undefined;
    let pipes: NodeJS.Timeout | undefined;
    const kill = () => {
      if (killed || settled) return;
      killed = true;
      killTree(child, "SIGTERM");
      if (posix) {
        force = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
        force.unref();
      }
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
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        // Mirror shell conventions so a signal death is never a success.
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
    // A descendant that escaped the kill can hold the pipes open forever;
    // after the process itself exits, stop waiting for them.
    child.on("exit", (code, signal) => {
      pipes = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, PIPE_GRACE_MS);
      pipes.unref();
    });
    child.on("close", finish);
  });

function signalNumber(signal: NodeJS.Signals): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return numbers[signal] ?? 0;
}
