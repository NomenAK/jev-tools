import { spawn } from "node:child_process";
import type { GitExec } from "../core/git.ts";

/**
 * Host-independent process execution with the same contract the pi/omp
 * `exec` provides to the tools: no shell, captured UTF-8 streams, `killed`
 * set on timeout or abort. A missing executable rejects, which the tools
 * already report as unavailable evidence.
 */
export const spawnExec: GitExec = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let spawned = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    let force: NodeJS.Timeout | undefined;
    const kill = () => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 5_000);
      force.unref();
    };
    const timer =
      options.timeout > 0 ? setTimeout(kill, options.timeout) : undefined;
    if (options.signal?.aborted) kill();
    else options.signal?.addEventListener("abort", kill, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(force);
      options.signal?.removeEventListener("abort", kill);
    };
    child.on("spawn", () => {
      spawned = true;
    });
    child.on("error", (error) => {
      if (spawned) return;
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      cleanup();
      resolve({
        stdout,
        stderr,
        // Mirror shell conventions so a signal death is never a success.
        code: code ?? (signal ? 128 + signalNumber(signal) : 1),
        killed,
      });
    });
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
