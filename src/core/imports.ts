import { posix } from "node:path";
import { type LexicalSource, tokenize as tokens } from "./lexical.ts";

export interface ImportSource {
  path: string;
  text: string;
}
export type ImportLimit = {
  path: string;
  specifier: string;
  kind: "unresolved" | "dynamic" | "outside_repo" | "ambiguous";
};
export interface ImportGraph {
  edges: ReadonlyMap<string, readonly string[]>;
  limits: readonly ImportLimit[];
}

function parseConfiguration(
  text: string,
  lexical = tokens(text, false),
): Record<string, unknown> {
  return JSON.parse(
    lexical
      .filter(
        (token, index) =>
          !(
            token.value === "," &&
            ["}", "]"].includes(lexical[index + 1]?.value ?? "")
          ),
      )
      .map((token) =>
        token.string ? JSON.stringify(token.value) : token.value,
      )
      .join(" "),
  ) as Record<string, unknown>;
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

function exportEntries(manifest: Record<string, unknown>): [string, string][] {
  const value = manifest.exports;
  if (value === undefined)
    return exportTargets(manifest.main).map((target) => [".", target]);
  if (
    value &&
    typeof value === "object" &&
    Object.keys(value).some((key) => key.startsWith("."))
  )
    return Object.entries(value).flatMap(([key, target]) =>
      exportTargets(target).map((text): [string, string] => [key, text]),
    );
  return exportTargets(value).map((target) => [".", target]);
}

function wildcardMatch(pattern: string, value: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === value ? "" : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return value.startsWith(prefix) &&
    value.endsWith(suffix) &&
    value.length >= prefix.length + suffix.length
    ? value.slice(prefix.length, value.length - suffix.length)
    : undefined;
}

/** Discriminating literal search hints; callers still confirm each hit with the shared resolver. */
export function importSearchSpecifiers(
  configuration: readonly ImportSource[],
  targets: readonly string[],
): string[] {
  const patterns = new Set<string>();
  for (const target of targets) {
    const stem = target.replace(/\.[^./]+$/, "");
    const parts = stem.split("/");
    for (let index = 0; index < parts.length - 1; index++)
      patterns.add(`./${parts.slice(index).join("/")}`);
    patterns.add(`./${parts.at(-1)}`);
    if (parts.at(-1) === "index") {
      const folder = parts.slice(0, -1);
      for (let index = 0; index < folder.length - 1; index++)
        patterns.add(`./${folder.slice(index).join("/")}`);
      if (folder.length) patterns.add(`./${folder.at(-1)}`);
    }
  }
  for (const source of configuration) {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseConfiguration(source.text);
    } catch {
      continue;
    }
    const cwd = posix.dirname(source.path);
    if (
      posix.basename(source.path) === "package.json" &&
      typeof parsed.name === "string"
    ) {
      for (const [key, value] of exportEntries(parsed)) {
        if (!value.startsWith("./")) continue;
        const base = posix.join(cwd, value).replace(/\.[cm]?[jt]sx?$/, "");
        for (const target of targets) {
          const middle = wildcardMatch(
            base,
            target.replace(/\.[cm]?[jt]sx?$/, ""),
          );
          if (middle !== undefined)
            patterns.add(
              parsed.name +
                (key === "." ? "" : key.slice(1).replace("*", middle)),
            );
        }
      }
    }
    const options = parsed.compilerOptions as
      | Record<string, unknown>
      | undefined;
    if (!options || typeof options !== "object") continue;
    const base = posix.join(
      cwd,
      typeof options.baseUrl === "string" ? options.baseUrl : ".",
    );
    if (options.paths && typeof options.paths === "object")
      for (const [alias, values] of Object.entries(options.paths)) {
        if (!Array.isArray(values)) continue;
        for (const value of values) {
          if (typeof value !== "string") continue;
          const pattern = posix.join(base, value);
          const star = pattern.indexOf("*");
          for (const target of targets) {
            for (const stem of new Set([
              target.replace(/\.[cm]?[jt]sx?$/, ""),
              target.replace(/\/index\.[cm]?[jt]sx?$/, ""),
            ])) {
              if (
                star < 0
                  ? stem === pattern.replace(/\.[cm]?[jt]sx?$/, "")
                  : stem.startsWith(pattern.slice(0, star)) &&
                    stem.endsWith(pattern.slice(star + 1))
              ) {
                const middle =
                  star < 0
                    ? ""
                    : stem.slice(
                        star,
                        stem.length - (pattern.length - star - 1),
                      );
                patterns.add(alias.replace("*", middle));
              }
            }
          }
        }
      }
  }
  return [...patterns];
}

export function buildImportGraph(
  files: readonly ImportSource[],
  options: { known?: ReadonlySet<string> } = {},
): ImportGraph {
  return createImportGraphBuilder(
    files,
    options.known ?? new Set(files.map((file) => file.path)),
  )(files);
}

/** Parse resolution configuration once, then resolve independent batches with identical semantics. */
export function createImportGraphBuilder(
  configuration: readonly ImportSource[],
  known: ReadonlySet<string>,
  lexical?: LexicalSource,
): (files: readonly ImportSource[]) => ImportGraph {
  const cache = new Map<
    string,
    { text: string; edges: readonly string[]; limits: readonly ImportLimit[] }
  >();
  let limits: ImportLimit[] = [];
  const packages = new Map<
    string,
    { cwd: string; manifest: Record<string, unknown> }[]
  >();
  const packageDirectories = new Set<string>();
  for (const path of known) {
    if (posix.basename(path) !== "package.json") continue;
    const directory = posix.dirname(path);
    const parent = posix.basename(posix.dirname(directory));
    packageDirectories.add(
      parent.startsWith("@")
        ? `${parent}/${posix.basename(directory)}`
        : posix.basename(directory),
    );
  }
  const aliases: {
    cwd: string;
    base: string;
    baseUrl: boolean;
    paths: Record<string, unknown>;
  }[] = [];
  for (const source of configuration) {
    if (
      posix.basename(source.path) !== "package.json" &&
      !/^tsconfig.*\.json$/.test(posix.basename(source.path))
    )
      continue;
    try {
      const parsed = parseConfiguration(
        source.text,
        lexical?.tokenize(source.path, source.text),
      );
      const cwd = posix.dirname(source.path);
      if (
        posix.basename(source.path) === "package.json" &&
        typeof parsed.name === "string"
      ) {
        const previous = packages.get(parsed.name) ?? [];
        previous.push({ cwd, manifest: parsed });
        packages.set(parsed.name, previous);
      } else if (
        parsed.compilerOptions &&
        typeof parsed.compilerOptions === "object"
      ) {
        const options = parsed.compilerOptions as Record<string, unknown>;
        aliases.push({
          cwd,
          base: posix.join(
            cwd,
            typeof options.baseUrl === "string" ? options.baseUrl : ".",
          ),
          baseUrl: typeof options.baseUrl === "string",
          paths:
            options.paths && typeof options.paths === "object"
              ? (options.paths as Record<string, unknown>)
              : {},
        });
      }
    } catch {
      limits.push({
        path: source.path,
        specifier: "configuration",
        kind: "unresolved",
      });
    }
  }
  const configurationLimits = limits;
  const resolve = (
    file: ImportSource,
    specifier: string,
    python: boolean,
  ): string[] => {
    if (specifier.startsWith("node:")) return [];
    let base: string;
    if (python) {
      let dots = 0;
      while (specifier[dots] === ".") dots++;
      base = dots ? posix.dirname(file.path) : "";
      for (let j = 1; j < dots; j++) base = posix.dirname(base);
      base = posix.join(base, specifier.slice(dots).replaceAll(".", "/"));
    } else {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        const name = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : (specifier.split("/")[0] ?? "");
        const workspace = packages.get(name);
        if (workspace) {
          if (
            aliases.some(
              (alias) =>
                !posix.relative(alias.cwd, file.path).startsWith("../") &&
                Object.keys(alias.paths).some(
                  (pattern) => wildcardMatch(pattern, specifier) !== undefined,
                ),
            )
          ) {
            limits.push({ path: file.path, specifier, kind: "ambiguous" });
            return [];
          }
          if (workspace.length !== 1) {
            limits.push({ path: file.path, specifier, kind: "ambiguous" });
            return [];
          }
          const found = workspace[0];
          if (!found) return [];
          const { cwd, manifest } = found;
          const suffix = specifier.slice(name.length);
          const key = suffix ? `.${suffix}` : ".";
          const entries = exportEntries(manifest);
          const exact = entries.filter(([pattern]) => pattern === key);
          const matching = exact.length
            ? exact
            : entries.filter(
                ([pattern]) => wildcardMatch(pattern, key) !== undefined,
              );
          const resolved = new Set<string>();
          for (const [pattern, target] of matching) {
            if (!target.startsWith("./")) continue;
            const middle = wildcardMatch(pattern, key) ?? "";
            const path = posix.normalize(
              posix.join(cwd, target.replace("*", middle)),
            );
            if (posix.relative(cwd, path).startsWith("../")) {
              limits.push({ path: file.path, specifier, kind: "outside_repo" });
              continue;
            }
            const previousLimits = limits.length;
            for (const match of resolve(
              file,
              `./${posix.relative(posix.dirname(file.path), path)}`,
              false,
            ))
              resolved.add(match);
            limits.splice(previousLimits);
          }
          if (!resolved.size)
            limits.push({ path: file.path, specifier, kind: "unresolved" });
          return [...resolved];
        } else {
          const local = aliases.filter(
            (alias) => !posix.relative(alias.cwd, file.path).startsWith("../"),
          );
          const matches: string[] = [];
          for (const alias of local)
            for (const [pattern, values] of Object.entries(alias.paths)) {
              const star = pattern.indexOf("*");
              if (
                !(star < 0
                  ? specifier === pattern
                  : specifier.startsWith(pattern.slice(0, star)) &&
                    specifier.endsWith(pattern.slice(star + 1)))
              )
                continue;
              if (!Array.isArray(values)) continue;
              const middle =
                star < 0
                  ? ""
                  : specifier.slice(
                      star,
                      specifier.length - (pattern.length - star - 1),
                    );
              for (const value of values)
                if (typeof value === "string") {
                  const target = posix.normalize(
                    posix.join(alias.base, value.replace("*", middle)),
                  );
                  if (target.startsWith("../")) {
                    limits.push({
                      path: file.path,
                      specifier,
                      kind: "outside_repo",
                    });
                    continue;
                  }
                  matches.push(
                    ...resolve(
                      file,
                      `./${posix.relative(posix.dirname(file.path), target)}`,
                      false,
                    ),
                  );
                }
            }
          const unique = [...new Set(matches)];
          if (unique.length) return unique;
          if (
            local.some((alias) => alias.baseUrl) ||
            specifier.startsWith("@/") ||
            specifier.startsWith("~/") ||
            specifier.startsWith("#") ||
            packageDirectories.has(name)
          )
            limits.push({ path: file.path, specifier, kind: "unresolved" });
          return [];
        }
      } else
        base = posix.normalize(posix.join(posix.dirname(file.path), specifier));
    }
    if (base.startsWith("../") || specifier.startsWith("/")) {
      limits.push({ path: file.path, specifier, kind: "outside_repo" });
      return [];
    }
    let candidates: string[];
    if (python) candidates = [`${base}.py`, posix.join(base, "__init__.py")];
    else if (known.has(base)) candidates = [base];
    else {
      const stem = base.replace(/\.[cm]?jsx?$/, "");
      candidates = [
        `${stem}.ts`,
        `${stem}.tsx`,
        `${stem}.mts`,
        `${stem}.cts`,
        `${base}.js`,
        `${base}.ts`,
        `${base}.tsx`,
        posix.join(base, "index.ts"),
        posix.join(base, "index.js"),
      ];
    }
    const matches = [...new Set(candidates)].filter((path) => known.has(path));
    if (matches.length !== 1) {
      // Standard-library imports are external; unknown roots/plugins remain explicit.
      const standard =
        /^(?:__future__|sys|os|pathlib|json|re|math|typing|collections|itertools|functools|datetime|unittest|contextlib|asyncio|subprocess|tempfile|shutil|logging|inspect|importlib|dataclasses|enum|abc|io|time|copy|decimal|statistics|warnings)(?:\.|$)/;
      if (!python || specifier.startsWith(".") || !standard.test(specifier))
        limits.push({
          path: file.path,
          specifier,
          kind: matches.length ? "ambiguous" : "unresolved",
        });
      return [];
    }
    return matches;
  };
  return (files) => {
    const edges = new Map<string, readonly string[]>();
    limits = [...configurationLimits];
    for (const file of files) {
      const cached = cache.get(file.path);
      if (cached?.text === file.text) {
        edges.set(file.path, cached.edges);
        limits.push(...cached.limits);
        continue;
      }
      const limitStart = limits.length;
      const python = file.path.endsWith(".py");
      if (!python && !/\.[cm]?[jt]sx?$/.test(file.path)) {
        edges.set(file.path, []);
        continue;
      }
      lexical?.resolved?.(file.path, file.text);
      const ts = lexical
        ? lexical.tokenize(file.path, file.text, python)
        : tokens(file.text, python);
      const targets = new Set<string>();
      const add = (specifier: string) => {
        for (const path of resolve(file, specifier, python)) targets.add(path);
      };
      const dynamic = (specifier = "") =>
        limits.push({ path: file.path, specifier, kind: "dynamic" });
      const readers = new Set<string>();
      readers.add("readFile");
      readers.add("readFileSync");
      if (!python)
        for (let i = 0; i < ts.length; i++) {
          if (ts[i]?.value !== "import" || ts[i]?.string) continue;
          let end = i + 1;
          while (end < ts.length && ts[end]?.value !== ";" && !ts[end]?.string)
            end++;
          if (
            !["node:fs", "fs", "node:fs/promises", "fs/promises"].includes(
              ts[end]?.value ?? "",
            )
          )
            continue;
          for (let j = i + 1; j < end; j++)
            if (["readFile", "readFileSync"].includes(ts[j]?.value ?? "")) {
              const local =
                ts[j + 1]?.value === "as" ? ts[j + 2]?.value : ts[j]?.value;
              if (local) readers.add(local);
            }
        }
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        if (!t || t.string) continue;
        if (
          python &&
          t.value === "sys" &&
          ts[i + 1]?.value === "." &&
          ts[i + 2]?.value === "path"
        )
          dynamic("sys.path mutation or lookup");
        if (python && t.value === "from") {
          let j = i + 1;
          let module = "";
          while (
            j < ts.length &&
            ts[j]?.line === t.line &&
            ts[j]?.value !== "import"
          )
            module += ts[j++]?.value ?? "";
          if (ts[j]?.value === "import") {
            if (module && !/^\.+$/.test(module)) add(module);
            // `from . import module` and `from pkg import module` may expose submodules.
            let k = j + 1;
            while (k < ts.length && ts[k]?.line === t.line) {
              const name = ts[k]?.value ?? "";
              if (
                /^\w+$/.test(name) &&
                name !== "as" &&
                ts[k - 1]?.value !== "as"
              ) {
                const spec = module.endsWith(".")
                  ? `${module}${name}`
                  : `${module}.${name}`;
                let dots = 0;
                while (spec[dots] === ".") dots++;
                let base = dots ? posix.dirname(file.path) : "";
                for (let level = 1; level < dots; level++)
                  base = posix.dirname(base);
                const local = posix.join(
                  base,
                  spec.slice(dots).replaceAll(".", "/"),
                );
                if (
                  /^\.+$/.test(module) ||
                  known.has(`${local}.py`) ||
                  known.has(posix.join(local, "__init__.py"))
                )
                  add(spec);
              }
              k++;
            }
          }
        } else if (
          python &&
          t.value === "import" &&
          ts[i - 1]?.value !== "from" &&
          !ts
            .slice(0, i)
            .some((prev) => prev.line === t.line && prev.value === "from")
        ) {
          let j = i + 1;
          let module = "";
          while (j < ts.length && ts[j]?.line === t.line) {
            if (ts[j]?.value === "as") break;
            if (ts[j]?.value === ",") {
              if (module) add(module);
              module = "";
            } else module += ts[j]?.value ?? "";
            j++;
          }
          if (module) add(module);
        } else if (!python && (t.value === "import" || t.value === "export")) {
          if (ts[i + 1]?.value === "(") {
            if (
              ts[i + 2]?.string &&
              ts[i + 3]?.value === ")" &&
              ts[i + 2]?.value !== "<dynamic>"
            )
              add(ts[i + 2]?.value ?? "");
            else dynamic();
          } else if (ts[i + 1]?.string) add(ts[i + 1]?.value ?? "");
          else {
            for (
              let j = i + 1;
              j < ts.length && ts[j]?.value !== ";" && j < i + 100;
              j++
            ) {
              if (ts[j]?.value === "from" && ts[j + 1]?.string) {
                add(ts[j + 1]?.value ?? "");
                break;
              }
              if ((ts[j]?.line ?? t.line) > t.line + 8) break;
            }
          }
        } else if (
          t.value === "URL" &&
          ts[i - 1]?.value === "new" &&
          ts[i + 1]?.value === "("
        ) {
          if (
            ts[i + 2]?.string &&
            ts[i + 3]?.value === "," &&
            ts[i + 4]?.value === "import" &&
            ts[i + 5]?.value === "." &&
            ts[i + 6]?.value === "meta" &&
            ts[i + 7]?.value === "." &&
            ts[i + 8]?.value === "url" &&
            ts[i + 9]?.value === ")"
          )
            add(ts[i + 2]?.value ?? "");
        } else if (
          (t.value === "require" || readers.has(t.value)) &&
          ts[i + 1]?.value === "("
        ) {
          if (
            ts[i + 2]?.string &&
            (ts[i + 3]?.value === "," || ts[i + 3]?.value === ")") &&
            ts[i + 2]?.value !== "<dynamic>"
          )
            add(ts[i + 2]?.value ?? "");
          else if (
            readers.has(t.value) &&
            ts[i + 2]?.value === "new" &&
            ts[i + 3]?.value === "URL" &&
            ts[i + 4]?.value === "(" &&
            ts[i + 5]?.string &&
            ts[i + 6]?.value === ","
          ) {
            // The nested URL token supplies the same statically resolved edge.
          } else dynamic();
        } else if (
          python &&
          (t.value === "__import__" || t.value === "import_module") &&
          ts[i + 1]?.value === "("
        )
          dynamic();
      }
      const dependencies = [...targets];
      edges.set(file.path, dependencies);
      cache.set(file.path, {
        text: file.text,
        edges: dependencies,
        limits: limits.slice(limitStart),
      });
    }
    const seenLimits = new Set<string>();
    const uniqueLimits = limits.filter((limit) => {
      const key = JSON.stringify([limit.path, limit.specifier, limit.kind]);
      if (seenLimits.has(key)) return false;
      seenLimits.add(key);
      return true;
    });
    return { edges, limits: uniqueLimits };
  };
}

export function importClosure(
  graph: ImportGraph,
  start: string,
  options: { maxDepth?: number; stop?: (path: string) => boolean } = {},
): { paths: readonly string[]; limits: readonly ImportLimit[] } {
  const seen = new Set<string>([start]);
  const queue = [{ path: start, depth: 0 }];
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (!item) continue;
    if (
      item.depth >= (options.maxDepth ?? Infinity) ||
      options.stop?.(item.path)
    )
      continue;
    for (const path of graph.edges.get(item.path) ?? []) {
      if (!seen.has(path)) {
        seen.add(path);
        queue.push({ path, depth: item.depth + 1 });
      }
    }
  }
  return {
    paths: [...seen],
    limits: graph.limits.filter((limit) => seen.has(limit.path)),
  };
}

/** Forward closure with injected reads; configuration and reached batches share the exact resolver. */
export async function importClosureLazy(
  read: (path: string) => Promise<ImportSource | undefined>,
  start: string,
  options: {
    known: ReadonlySet<string>;
    configuration?: readonly ImportSource[];
    stop?: (path: string) => boolean;
    cache?: Map<string, Promise<ImportGraph>>;
    build?: (files: readonly ImportSource[]) => ImportGraph;
  },
): Promise<{ paths: readonly string[]; limits: readonly ImportLimit[] }> {
  const build =
    options.build ??
    createImportGraphBuilder(options.configuration ?? [], options.known);
  const cache = options.cache ?? new Map<string, Promise<ImportGraph>>();
  const seen = new Set([start]);
  const queue = [start];
  const limits: ImportLimit[] = [];
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index];
    if (!path || options.stop?.(path)) continue;
    let pending = cache.get(path);
    if (!pending) {
      pending = read(path).then((source) =>
        source
          ? build([source])
          : {
              edges: new Map(),
              limits: [{ path, specifier: path, kind: "unresolved" as const }],
            },
      );
      cache.set(path, pending);
    }
    const graph = await pending;
    limits.push(...graph.limits);
    for (const target of graph.edges.get(path) ?? [])
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
  }
  return { paths: [...seen], limits };
}
