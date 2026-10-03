import { type FileHandle, lstat } from "node:fs/promises";
import { posix } from "node:path";
import type { SgNode } from "@ast-grep/napi";
import { CONCURRENCY, STATE_MAX_CHARS, TIMEOUT_MS } from "../constants.ts";
import type { GitExec } from "../core/git.ts";
import {
  type CallerParser,
  type CallerPreparation,
  type CallerSource,
  prepareRiskCallers,
} from "../core/risk-callers.ts";
import type { SyntaxRootParser } from "../core/syntax.ts";
import type { EvidenceUnit, SourceFile } from "../core/units.ts";
import {
  admitGitPath,
  checkFileAdmission,
  openRepoFile,
  resolveInsideRepo,
} from "./files.ts";
import { loadSyntaxRootParser } from "./syntax.ts";
import { decodeUtf8, verifyGitUtf8 } from "./utf8.ts";

export async function loadCallerParser(
  sourceParser?: SyntaxRootParser,
): Promise<CallerParser | undefined> {
  const parser = sourceParser ?? (await loadSyntaxRootParser());
  if (!parser) return undefined;
  const versions = new Map<string, Map<string, SgNode | null>>();
  return {
    supports: parser.supports,
    parse(path, text) {
      let entries = versions.get(path);
      if (!entries) {
        entries = new Map();
        versions.set(path, entries);
      }
      if (entries.has(text)) return entries.get(text) ?? null;
      const result = parser.parseRaw(path, text);
      const root = result.ok ? result.root : null;
      entries.set(text, root);
      return root;
    },
  };
}
export async function collectRiskCallers(
  exec: GitExec,
  options: { cwd: string; base?: string; signal?: AbortSignal },
  units: readonly EvidenceUnit[],
  changedFiles: readonly SourceFile[] = [],
  sourceParser?: SyntaxRootParser,
): Promise<CallerPreparation> {
  if (!units.length) return { proofs: [], limits: [] };
  const parser = await loadCallerParser(sourceParser);
  const local = prepareRiskCallers(
    units,
    changedFiles.map((file) => ({
      path: file.path,
      beforePath: file.oldPath,
      before: file.before,
      after: file.after,
      limitation: file.limitation,
    })),
    parser,
  );
  const eligibleIds = new Set([
    ...local.proofs.map((proof) => proof.unitId),
    ...local.limits.map((limit) => limit.unitId),
  ]);
  const nameFor = (unit: EvidenceUnit): string | undefined => {
    const name = unit.name.split(".").at(-1) ?? unit.name;
    if (!parser?.supports(unit.file)) return;
    const probe = parser.parse(
      unit.file,
      unit.file.endsWith(".py")
        ? `def ${name}():\n    pass`
        : `function ${name}() {}`,
    );
    const declaration = probe
      ?.children()
      .find((node) =>
        ["function_definition", "function_declaration"].includes(
          String(node.kind()),
        ),
      );
    return declaration?.field("name")?.text() === name ? name : undefined;
  };
  const eligible = units.filter(
    (unit) =>
      eligibleIds.has(unit.id) &&
      ["function", "declaration", "slice"].includes(unit.kind) &&
      nameFor(unit) !== undefined,
  );
  const retainedLimits = local.limits.filter(
    (limit) => !eligible.some((unit) => unit.id === limit.unitId),
  );
  if (!eligible.length) return local;
  let cwd = options.cwd;
  const git = async (args: string[]) => {
    options.signal?.throwIfAborted();
    const result = await exec("git", args, {
      cwd,
      timeout: TIMEOUT_MS,
      signal: options.signal,
    });
    if (result.code !== 0 || result.killed)
      throw new Error(result.stderr || "git interrupted");
    return result.stdout;
  };
  try {
    // The tool supplies the already resolved comparison reference, as for collectUnits.
    cwd = (await git(["rev-parse", "--show-toplevel"])).trim();
    const ref = (options.base ?? "HEAD").trim();
    const sourceExtension: Record<string, string> = {
      ".js": ".ts",
      ".jsx": ".tsx",
      ".mjs": ".mts",
      ".cjs": ".cts",
    };
    const extensions = [
      "ts",
      "tsx",
      "mts",
      "cts",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "py",
    ];
    const tracked = await git([
      "ls-files",
      "-z",
      `--with-tree=${ref}`,
      "--",
      ...extensions.map((extension) => `*.${extension}`),
    ]);
    const beforePaths = new Set(tracked.split("\0"));
    const baseInventory = new Map<string, string>();
    for (const entry of (
      await git([
        "ls-tree",
        "-r",
        "--long",
        "-z",
        "--full-tree",
        "--end-of-options",
        ref,
      ])
    ).split("\0")) {
      const separator = entry.indexOf("\t");
      if (separator !== -1)
        baseInventory.set(entry.slice(separator + 1), entry);
    }
    const modifiedPaths = new Set(
      (
        await git([
          "diff",
          "--name-only",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          ref,
        ])
      ).split("\0"),
    );
    const currentPaths = new Set(
      (
        await git([
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
        ])
      )
        .split("\0")
        .filter(Boolean),
    );
    const names = [
      ...new Set(
        eligible
          .map((unit) => nameFor(unit))
          .filter((name): name is string => name !== undefined),
      ),
    ];
    const matched = new Set<string>();
    const inventory = [...beforePaths].filter((path) =>
      /\.(?:[cm]?[jt]sx?|py)$/.test(path),
    );
    const patternArgs = names.flatMap((name) => ["-e", name]);
    const priorSearch = exec(
      "git",
      [
        "grep",
        "-l",
        "-z",
        "-F",
        "-w",
        ...patternArgs,
        ref,
        "--",
        ...extensions.map((extension) => `*.${extension}`),
      ],
      { cwd, timeout: TIMEOUT_MS, signal: options.signal },
    ).catch((error: unknown) => ({
      stdout: "",
      stderr: String(error),
      code: 2,
      killed: false,
    }));
    // Explicit tracked paths prevent rg from collecting ignored or untracked callers.
    // Bound argument bytes as well as process concurrency, including long paths.
    const batches: string[][] = [];
    let batch: string[] = [];
    let bytes = 0;
    for (const path of inventory) {
      const size = Buffer.byteLength(path) + 1;
      if (batch.length && bytes + size > 96_000) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(path);
      bytes += size;
    }
    if (batch.length) batches.push(batch);
    for (let offset = 0; offset < batches.length; offset += CONCURRENCY) {
      await Promise.all(
        batches.slice(offset, offset + CONCURRENCY).map(async (paths) => {
          options.signal?.throwIfAborted();
          const metadata = await Promise.all(
            paths.map(async (path) => {
              try {
                const admission = await checkFileAdmission(
                  cwd,
                  path,
                  undefined,
                  options.signal,
                  currentPaths,
                );
                if (!admission.ok) return undefined;
                const location = await resolveInsideRepo(cwd, path);
                if (!location.ok) return undefined;
                return (await lstat(location.abs)).isFile() ? path : undefined;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT")
                  return undefined;
                throw error;
              }
            }),
          );
          const existing = metadata.filter(
            (path): path is string => path !== undefined,
          );
          if (!existing.length) return;
          let current:
            | { stdout: string; stderr: string; code: number; killed: boolean }
            | undefined;
          try {
            current = await exec(
              "rg",
              ["-l", "-0", "-F", "-w", ...patternArgs, "--", ...existing],
              { cwd, timeout: TIMEOUT_MS, signal: options.signal },
            );
          } catch {
            options.signal?.throwIfAborted();
          }
          if (!current || current.code > 1 || current.killed)
            current = await exec(
              "git",
              [
                "grep",
                "-l",
                "-z",
                "-F",
                "-w",
                ...patternArgs,
                "--",
                ...existing,
              ],
              { cwd, timeout: TIMEOUT_MS, signal: options.signal },
            );
          if (current.code > 1 || current.killed)
            throw new Error(
              current.stderr || "tracked caller name search failed",
            );
          for (const path of current.stdout.split("\0"))
            if (path && beforePaths.has(path)) matched.add(path);
        }),
      );
    }
    const prior = await priorSearch;
    if (prior.code > 1 || prior.killed)
      throw new Error(prior.stderr || "before caller name search failed");
    for (const path of prior.stdout.split("\0"))
      if (path.startsWith(`${ref}:`)) matched.add(path.slice(ref.length + 1));
    for (const file of changedFiles) matched.add(file.path);
    const paths = [...matched];
    const sources: CallerSource[] = [];
    const readBefore = async (
      path: string,
    ): Promise<{ text: string | null; limitation?: string }> => {
      if (!beforePaths.has(path)) return { text: null };
      if (
        !(
          await admitGitPath(
            cwd,
            path,
            ref,
            exec,
            options.signal,
            baseInventory,
          )
        ).ok
      )
        return { text: null, limitation: "before file not admitted" };
      const entry = baseInventory.get(path);
      const metadata =
        entry &&
        /^(?:100644|100755|120000) blob ([0-9a-f]+)\s+(\d+)\t/.exec(entry);
      if (!metadata) return { text: null };
      const object = metadata[1] ?? "";
      const size = Number(metadata[2]);
      if (!Number.isFinite(size) || size > STATE_MAX_CHARS)
        return { text: null, limitation: "before file exceeds read budget" };
      const text = await git([
        "show",
        "--no-ext-diff",
        "--no-textconv",
        "--end-of-options",
        object,
      ]);
      const decoded = verifyGitUtf8(text, object, size);
      if (!decoded.ok)
        return { text: null, limitation: `${path}: ${decoded.error}` };
      return text.length <= STATE_MAX_CHARS && !text.includes("\0")
        ? { text }
        : { text: null, limitation: "before binary or oversized" };
    };
    const readAfter = async (
      path: string,
    ): Promise<{ text: string | null; limitation?: string }> => {
      let handle: FileHandle | undefined;
      try {
        options.signal?.throwIfAborted();
        const location = await resolveInsideRepo(cwd, path);
        if (!location.ok) {
          const metadata = await admitGitPath(
            cwd,
            path,
            ref,
            exec,
            options.signal,
            baseInventory,
          );
          if (metadata.ok && location.error.includes("ENOENT"))
            return { text: null };
          return { text: null, limitation: "after file not admitted" };
        }
        const opened = await openRepoFile(cwd, path, {
          exec,
          signal: options.signal,
          inventory: currentPaths,
        });
        if (!opened.ok)
          return { text: null, limitation: "after file not admitted" };
        handle = opened.handle;
        const stat = { size: opened.size };
        if (stat.size > STATE_MAX_CHARS)
          return { text: null, limitation: "after file exceeds read budget" };
        const buffer = Buffer.alloc(STATE_MAX_CHARS + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await handle.read(
            buffer,
            offset,
            buffer.length - offset,
            null,
          );
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        if (offset > STATE_MAX_CHARS || buffer.subarray(0, offset).includes(0))
          return { text: null, limitation: "after binary or oversized" };
        const decoded = decodeUtf8(buffer.subarray(0, offset));
        return decoded.ok
          ? { text: decoded.text }
          : { text: null, limitation: `${path}: ${decoded.error}` };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { text: null };
        return { text: null, limitation: "after unreadable" };
      } finally {
        await handle?.close();
      }
    };
    for (let offset = 0; offset < paths.length; ) {
      const selected = paths.slice(offset, offset + CONCURRENCY);
      offset += selected.length;
      const batch = await Promise.all(
        selected.map(async (path) => {
          const changed = changedFiles.find((f) => f.path === path);
          if (changed)
            return {
              path,
              beforePath: changed.oldPath,
              before: changed.before,
              after: changed.after,
              limitation: changed.limitation,
            };
          if (!modifiedPaths.has(path)) {
            const after = await readAfter(path);
            if (after.text !== null)
              return {
                path,
                before: after.text,
                after: after.text,
                limitation: after.limitation,
              };
          }
          const [before, after] = await Promise.all([
            readBefore(path),
            readAfter(path),
          ]);
          return {
            path,
            before: before.text,
            after: after.text,
            limitation: before.limitation ?? after.limitation,
          };
        }),
      );
      sources.push(...batch);
      // Follow static import AST nodes from candidate files so imported concrete providers remain visible.
      for (const source of batch)
        for (const side of ["before", "after"] as const) {
          if (side === "after" && source.before === source.after) continue;
          const text = source[side];
          if (!text || !parser?.supports(source.path)) continue;
          const ast = parser.parse(source.path, text);
          if (!ast) continue;
          const visit = (node: typeof ast) => {
            if (
              [
                "import_statement",
                "import_from_statement",
                "export_statement",
              ].includes(String(node.kind()))
            ) {
              const literal = node.field("source") ?? node.field("module_name");
              if (literal) {
                const specifier =
                  literal.kind() === "string"
                    ? literal.text().slice(1, -1)
                    : literal.text();
                const sourcePath =
                  side === "before" &&
                  "beforePath" in source &&
                  typeof source.beforePath === "string"
                    ? source.beforePath
                    : source.path;
                // Repository paths are always "/"-separated; the platform
                // resolve would yield "C:\\src\\..." on Windows.
                const basePath = specifier.startsWith(".")
                  ? posix.resolve("/", sourcePath, "..", specifier).slice(1)
                  : specifier.replaceAll(".", "/");
                const runtimeSource = basePath.replace(
                  /\.(js|jsx|mjs|cjs)$/,
                  (extension) => sourceExtension[extension] ?? extension,
                );
                const candidates = new Set([
                  basePath,
                  runtimeSource,
                  ...extensions.map((extension) => `${basePath}.${extension}`),
                  `${basePath}/index.ts`,
                  `${basePath}/__init__.py`,
                ]);
                const matches = [...candidates].filter((path) =>
                  beforePaths.has(path),
                );
                if (matches.length === 1 && !matched.has(matches[0] ?? "")) {
                  matched.add(matches[0] ?? "");
                  paths.push(matches[0] ?? "");
                }
              }
            }
            for (const child of node.children()) visit(child);
          };
          if (source.path.endsWith(".py")) visit(ast);
          else
            for (const statement of ast.children()) {
              if (
                ["import_statement", "export_statement"].includes(
                  String(statement.kind()),
                ) &&
                statement.field("source")
              )
                visit(statement);
            }
        }
    }
    const prepared = prepareRiskCallers(eligible, sources, parser);
    prepared.limits.push(...retainedLimits);
    prepared.limits.push(
      ...eligible.map((unit) => ({
        unitId: unit.id,
        kind: "dynamic_access_uncovered" as const,
        reason: "callers found by name; dynamic access not covered",
        paths: [unit.file],
        missing: "dynamically named callers",
      })),
    );
    return prepared;
  } catch (error) {
    return {
      proofs: [],
      limits: eligible.map((unit) => ({
        unitId: unit.id,
        kind: "unreadable",
        reason: `caller collection failed: ${String(error)}`,
        paths: [unit.file],
        missing: "bounded tracked caller/provider source",
      })),
    };
  }
}
