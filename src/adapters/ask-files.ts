import { readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { CONCURRENCY, MAX_FILES, TIMEOUT_MS } from "../constants.ts";
import type { GitExec } from "../core/git.ts";
import type { FileIdentity } from "../core/integrity.ts";
import type { Result } from "../result.ts";
import {
  checkFileAdmission,
  collectFiles,
  resolveInsideRepo,
} from "./files.ts";

const excludedDirectories = new Set(["node_modules", ".git", "dist", "build"]);
const lockfile =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|Pipfile\.lock|go\.sum)$/;
export interface AskFile {
  path: string;
  content: string;
  identity: FileIdentity;
}
export async function collectAskFiles(
  cwd: string,
  paths: readonly string[],
  signal?: AbortSignal,
  exec?: GitExec,
): Promise<Result<{ files: AskFile[]; skipped: string[]; secret: string[] }>> {
  if (!paths.length)
    return {
      ok: false,
      error: "Provide at least one path, directory or glob.",
    };
  for (const path of paths) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path))
      return {
        ok: false,
        error: `Internal URLs are not files; use read for ${path}.`,
      };
    if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
      return {
        ok: false,
        error: `Path must remain inside the repository: ${path}.`,
      };
  }
  const skipped = new Set<string>();
  const secret = new Set<string>();
  const candidates = new Set<string>();
  try {
    let inventory: Set<string> | undefined;
    if (exec) {
      const result = await exec(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd, timeout: TIMEOUT_MS, signal },
      );
      if (result.code === 0)
        inventory = new Set(result.stdout.split("\0").filter(Boolean));
    }
    const add = async (path: string) => {
      const admission = await checkFileAdmission(
        cwd,
        path,
        exec,
        signal,
        inventory,
      );
      if (!admission.ok) {
        const entry = `${path} (${admission.error})`;
        skipped.add(entry);
        if (admission.cause === "secret_pattern") secret.add(entry);
        return;
      }
      if (path.split("/").some((part) => excludedDirectories.has(part)))
        skipped.add(`${path} (build output or dependencies)`);
      else if (lockfile.test(path)) skipped.add(`${path} (lockfile)`);
      else candidates.add(path);
    };
    const walk = async (directory: string, pattern?: string): Promise<void> => {
      signal?.throwIfAborted();
      const safe = await resolveInsideRepo(cwd, directory);
      if (!safe.ok) {
        skipped.add(`${directory} (${safe.error})`);
        return;
      }
      const entries = await readdir(safe.abs, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          const path = relative(
            cwd,
            resolve(cwd, directory, entry.name),
          ).replaceAll("\\", "/");
          if (entry.isSymbolicLink()) {
            skipped.add(`${path} (symbolic link)`);
            return;
          }
          if (entry.isDirectory()) {
            if (excludedDirectories.has(entry.name)) {
              skipped.add(`${path}/ (build output or dependencies)`);
              return;
            }
            await walk(path, pattern);
            return;
          }
          if (
            entry.isFile() &&
            (!pattern ||
              matchesGlob(
                path
                  .split("/")
                  .map((part) =>
                    part.startsWith(".") ? `__dot__${part.slice(1)}` : part,
                  )
                  .join("/"),
                pattern
                  .split("/")
                  .map((part) =>
                    part.startsWith(".") ? `__dot__${part.slice(1)}` : part,
                  )
                  .join("/"),
              ))
          )
            await add(path);
        }),
      );
    };
    for (const input of paths) {
      signal?.throwIfAborted();
      const safe = await resolveInsideRepo(cwd, input);
      const info = safe.ok
        ? await stat(safe.abs).catch(() => undefined)
        : undefined;
      if (info && safe.ok) {
        if (info.isFile()) {
          const admission = await checkFileAdmission(
            cwd,
            safe.rel,
            exec,
            signal,
            inventory,
          );
          if (!admission.ok) return admission;
        }
        if (input.split("/").some((part) => excludedDirectories.has(part))) {
          skipped.add(`${input} (build output or dependencies)`);
          continue;
        }
        if (info.isDirectory()) await walk(safe.rel || ".");
        else if (info.isFile()) {
          const admission = await checkFileAdmission(
            cwd,
            safe.rel,
            exec,
            signal,
            inventory,
          );
          if (!admission.ok) return admission;
          await add(safe.rel);
        } else skipped.add(`${input} (not a regular file)`);
      } else {
        const parts = input.split("/");
        const wildcard = parts.findIndex((part) => /[?*[\]{}]/.test(part));
        if (wildcard < 0) {
          if (!safe.ok && !safe.error.includes("ENOENT")) return safe;
          skipped.add(`${input} (missing)`);
          continue;
        }
        const prefix = parts.slice(0, wildcard).join("/") || ".";
        const prefixLocation = await resolveInsideRepo(cwd, prefix);
        if (!prefixLocation.ok) return prefixLocation;
        const pattern = input.replace(/^\.\//, "");
        if (inventory) {
          for (const path of inventory) {
            const dotPath = path
              .split("/")
              .map((part) =>
                part.startsWith(".") ? `__dot__${part.slice(1)}` : part,
              )
              .join("/");
            const dotPattern = pattern
              .split("/")
              .map((part) =>
                part.startsWith(".") ? `__dot__${part.slice(1)}` : part,
              )
              .join("/");
            if (matchesGlob(dotPath, dotPattern)) await add(path);
          }
        } else await walk(prefix, pattern);
      }
    }
    const files: AskFile[] = [];
    const sorted = [...candidates].sort();
    const contributions = new Map<string, number>();
    for (const path of sorted) {
      const directory = dirname(path);
      contributions.set(directory, (contributions.get(directory) ?? 0) + 1);
    }
    let accepted = 0;
    for (let i = 0; i < sorted.length; i += CONCURRENCY) {
      const rows = await Promise.all(
        sorted.slice(i, i + CONCURRENCY).map(async (path) => {
          const result = await collectFiles(cwd, [path], signal, {
            exec,
            inventory,
          });
          if (!result.ok) {
            skipped.add(`${path} (${result.error})`);
            return;
          }
          const identity = result.identities[0];
          if (!identity) return;
          if (
            identity.content.includes("\0") ||
            identity.readSha256 !== identity.insertedSha256
          ) {
            skipped.add(`${path} (binary or invalid UTF-8)`);
            return;
          }
          return { path, content: identity.content, identity };
        }),
      );
      for (const file of rows)
        if (file) {
          accepted++;
          if (files.length < MAX_FILES) files.push(file);
        }
      if (accepted > MAX_FILES) {
        const largest = [...contributions]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 5);
        return {
          ok: false,
          error: `At least ${accepted} files exceeds MAX_FILES=${MAX_FILES}; narrow paths. Largest expanded directories: ${largest.map(([path, count]) => `${path}: ${count}`).join(", ")}.`,
        };
      }
    }
    return {
      ok: true,
      files,
      skipped: [...skipped].sort(),
      secret: [...secret].sort(),
    };
  } catch (error) {
    return { ok: false, error: `Cannot expand paths: ${String(error)}` };
  }
}
