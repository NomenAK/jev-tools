import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { RUNNER_PACKAGE_MAX_BYTES } from "../constants.ts";
import {
  lockedRunnerVersion,
  runnerVersion,
  type VersionedRunner,
} from "../core/runner-version.ts";
import type { TestEntry } from "../core/test-discovery.ts";

/** Local-only ignored metadata exception: no contents enter Jev state. Closed runner names,
 * bounded reads and realpath confinement allow pnpm links only inside the repository. */
export async function installedRunnerVersion(
  root: string,
  cwd: string,
  runner: VersionedRunner,
): Promise<string | undefined> {
  if (runner !== "vitest" && runner !== "jest" && runner !== "mocha")
    return undefined;
  if (isAbsolute(cwd) || cwd.split(/[\\/]/).includes("..")) return undefined;
  let handle: FileHandle | undefined;
  try {
    const base = await realpath(root);
    const path = await realpath(
      resolve(base, cwd, "node_modules", runner, "package.json"),
    );
    const rel = relative(base, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
      return undefined;
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > RUNNER_PACKAGE_MAX_BYTES)
      return undefined;
    const bytes = Buffer.alloc(RUNNER_PACKAGE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > RUNNER_PACKAGE_MAX_BYTES) return undefined;
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as {
      version?: unknown;
    };
    return runnerVersion(value.version);
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export async function attachRunnerVersions(
  root: string,
  entries: readonly TestEntry[],
  read: (path: string) => Promise<{ text: string } | undefined>,
  known: ReadonlySet<string>,
): Promise<TestEntry[]> {
  const cache = new Map<string, Promise<string | undefined>>();
  return Promise.all(
    entries.map(async (entry) => {
      if (
        entry.framework !== "vitest" &&
        entry.framework !== "jest" &&
        entry.framework !== "mocha"
      )
        return entry;
      const runner = entry.framework;
      const key = `${entry.cwd}:${runner}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = (async () => {
          const installed = await installedRunnerVersion(
            root,
            entry.cwd,
            runner,
          );
          if (installed) return installed;
          const dirs = [entry.cwd];
          for (const dir of dirs)
            for (const name of [
              "package-lock.json",
              "pnpm-lock.yaml",
              "yarn.lock",
              "bun.lock",
            ]) {
              const path = dir === "." ? name : `${dir}/${name}`;
              if (!known.has(path)) continue;
              const source = await read(path);
              if (source) {
                const version = lockedRunnerVersion(runner, path, source.text);
                if (version) return version;
              }
            }
          return undefined;
        })();
        cache.set(key, pending);
      }
      const version = await pending;
      return { ...entry, ...(version ? { runnerVersion: version } : {}) };
    }),
  );
}
