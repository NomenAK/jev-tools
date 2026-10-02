import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export interface ShellInvocation {
  executable: string;
  /** Arguments placed before the `-c` script. */
  prefix: string[];
  /** Exports prepended to the script when the launcher cannot set them. */
  scriptPrefix: string;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows ships `bash.exe` launchers for WSL in System32 and WindowsApps.
 * They run in a Linux VM that cannot see Windows temporary paths, so they are
 * never used for command evidence.
 */
function isWslLauncher(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.includes("\\windows\\system32\\") ||
    lower.includes("\\microsoft\\windowsapps\\")
  );
}

/** Git for Windows bash candidates, most specific first. */
export function windowsBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (env.JEV_TOOLS_BASH?.trim()) candidates.push(env.JEV_TOOLS_BASH.trim());
  const pathEntries = (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(Boolean);
  for (const entry of pathEntries) {
    const bash = join(entry, "bash.exe");
    if (!isWslLauncher(bash)) candidates.push(bash);
    // Git\cmd\git.exe or Git\bin\git.exe on PATH implies Git\bin\bash.exe.
    if (/[\\/](cmd|bin)$/i.test(entry))
      candidates.push(join(dirname(entry), "bin", "bash.exe"));
  }
  for (const root of [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs"),
  ])
    if (root) candidates.push(join(root, "Git", "bin", "bash.exe"));
  return [...new Set(candidates)];
}

let cached: ShellInvocation | undefined;

/**
 * POSIX hosts keep `env CI=1 bash -c`. Windows has no `env` and its default
 * `bash` is the WSL launcher, so resolve Git for Windows bash (or
 * JEV_TOOLS_BASH) and export CI inside the script instead.
 */
export function resolveShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  isExecutable: (path: string) => boolean = executable,
): ShellInvocation {
  if (platform !== "win32")
    return { executable: "env", prefix: ["CI=1", "bash"], scriptPrefix: "" };
  const useCache = isExecutable === executable && env === process.env;
  if (useCache && cached) return cached;
  const found = windowsBashCandidates(env).find((path) => isExecutable(path));
  const resolved: ShellInvocation = {
    // An unresolved name fails at spawn and is reported as unavailable evidence.
    executable: found ?? "bash.exe",
    prefix: [],
    scriptPrefix: "export CI=1; ",
  };
  if (useCache && found) cached = resolved;
  return resolved;
}
