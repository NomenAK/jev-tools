import { accessSync, constants } from "node:fs";
// Candidates are Windows paths whatever the host OS, so the helpers use win32
// semantics explicitly; the host-native `node:path` splits PATH on ":" on POSIX.
import { win32 } from "node:path";

export interface ShellInvocation {
  executable: string;
  /** Arguments placed before the `-c` script. */
  prefix: string[];
  /** Exports prepended to the script when the launcher cannot set them. */
  scriptPrefix: string;
}

export type ShellResolution =
  | ({ ok: true } & ShellInvocation)
  | { ok: false; error: string };

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows ships `bash.exe` launchers for WSL in System32 (and SysWOW64,
 * Sysnative) and in WindowsApps. They run in a Linux VM that cannot see Windows
 * temporary paths, so they are never used for command evidence, including
 * when named explicitly in JEV_TOOLS_BASH.
 */
export function isWslLauncher(path: string): boolean {
  const lower = win32.normalize(path).toLowerCase();
  return (
    /\\windows\\(system32|syswow64|sysnative)\\/.test(lower) ||
    lower.includes("\\microsoft\\windowsapps\\")
  );
}

/** Permitted Git for Windows bash candidates, most specific first. */
export function windowsBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (env.JEV_TOOLS_BASH?.trim()) candidates.push(env.JEV_TOOLS_BASH.trim());
  const pathEntries = (env.PATH ?? env.Path ?? "")
    .split(win32.delimiter)
    .filter(Boolean);
  for (const entry of pathEntries) {
    candidates.push(win32.join(entry, "bash.exe"));
    // Git\cmd\git.exe or Git\bin\git.exe on PATH implies Git\bin\bash.exe.
    if (/[\\/](cmd|bin)$/i.test(entry))
      candidates.push(win32.join(win32.dirname(entry), "bin", "bash.exe"));
  }
  for (const root of [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs"),
  ])
    if (root) candidates.push(win32.join(root, "Git", "bin", "bash.exe"));
  // Filter every source, so no candidate can reintroduce a WSL launcher.
  return [...new Set(candidates)].filter(
    (candidate) => win32.isAbsolute(candidate) && !isWslLauncher(candidate),
  );
}

const UNAVAILABLE =
  "No permitted bash found: install Git for Windows or set JEV_TOOLS_BASH to the full path of a bash that is not the WSL launcher.";
/** Never handed to command children: the Jev API key stays with the extension. */
export const API_KEY_VARIABLE = "JEV_TOOLS_API_KEY";

/** Copy of `env` without the Jev API key (any case, for Windows). */
export function withoutApiKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of Object.keys(copy))
    if (key.toUpperCase() === API_KEY_VARIABLE) delete copy[key];
  return copy;
}
let cached: ShellResolution | undefined;

/**
 * POSIX hosts run `env -u JEV_TOOLS_API_KEY CI=1 bash -c`. Windows has no
 * `env` and its default `bash` is the WSL launcher, so resolve Git for Windows
 * bash (or JEV_TOOLS_BASH) to an absolute, permitted path, and unset the key
 * and export CI inside the script. When none is found this fails closed: no
 * bare name is returned, because spawning one would search PATH again without
 * the WSL exclusion.
 */
export function resolveShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  isExecutable: (path: string) => boolean = executable,
): ShellResolution {
  if (platform !== "win32")
    return {
      ok: true,
      executable: "env",
      prefix: ["-u", API_KEY_VARIABLE, "CI=1", "bash"],
      scriptPrefix: "",
    };
  const useCache = isExecutable === executable && env === process.env;
  if (useCache && cached) return cached;
  const found = windowsBashCandidates(env).find((path) => isExecutable(path));
  const resolved: ShellResolution = found
    ? {
        ok: true,
        executable: found,
        prefix: [],
        scriptPrefix: `unset ${API_KEY_VARIABLE}; export CI=1; `,
      }
    : { ok: false, error: UNAVAILABLE };
  if (useCache && found) cached = resolved;
  return resolved;
}
