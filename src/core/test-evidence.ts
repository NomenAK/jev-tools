import { posix } from "node:path";
import type { SgNode } from "@ast-grep/napi";
import {
  type ImportGraph,
  type ImportSource,
  importClosure,
} from "./imports.ts";
import type { SyntaxRootParser } from "./syntax.ts";
import type { TestEntry } from "./test-discovery.ts";
import type { Declaration, EvidenceUnit } from "./units.ts";

export interface TestEvidenceLimit {
  kind:
    | "grammar_absent"
    | "parse_failed"
    | "parse_partial"
    | "unsupported"
    | "ambiguous"
    | "unresolved"
    | "dynamic"
    | "outside_repo";
  path: string;
  specifier?: string;
  declaration?: string;
}
export interface TestEvidence {
  paths: readonly string[];
  units: readonly EvidenceUnit[];
  imports: readonly ImportSource[];
  usedBy: ReadonlyMap<string, readonly ImportSource[]>;
  limits: readonly TestEvidenceLimit[];
  uncertain: boolean;
}
interface Binding {
  target: string;
  name: string;
}
interface Reference {
  name: string;
  member?: string;
}
interface Definition {
  file: string;
  declaration: Declaration;
  text: string;
  references: Reference[];
}
interface Module {
  definitions: Definition[];
  bindings: Map<string, Binding>;
  exports: Map<string, Binding[]>;
  stars: string[];
  references: Reference[];
  limits: TestEvidenceLimit[];
}
function references(node: SgNode): Reference[] {
  const found: Reference[] = [];
  const memberKind =
    node.kind() === "module" ||
    node.ancestors().some((ancestor) => ancestor.kind() === "module")
      ? "attribute"
      : "member_expression";
  for (const part of node.findAll({
    rule: { any: [{ kind: "identifier" }, { kind: memberKind }] },
  })) {
    const kind = String(part.kind());
    if (/^(member_expression|attribute)$/.test(kind)) {
      const object = part.field("object") ?? part.children()[0];
      const property = part.field("property") ?? part.children().at(-1);
      if (
        object?.kind() === "identifier" &&
        property &&
        /identifier$/.test(String(property.kind()))
      )
        found.push({ name: object.text(), member: property.text() });
    } else {
      const parent = part.parent();
      if (
        parent &&
        /^(import|export).*|^(member_expression|attribute)$/.test(
          String(parent.kind()),
        )
      )
        continue;
      found.push({ name: part.text() });
    }
  }
  return found;
}

/** Builds one lazy, cached declaration index for an inventory. Unknown chains remain judgeable. */
export function prepareTestEvidence(
  files: readonly ImportSource[],
  graph: ImportGraph,
  units: readonly EvidenceUnit[],
  parser: SyntaxRootParser | undefined,
): (entry: TestEntry) => TestEvidence {
  const sources = new Map(files.map((file) => [file.path, file]));
  const modules = new Map<string, Module>();
  const dependencyCache = new Map<
    Definition,
    { definitions: Definition[]; limits: TestEvidenceLimit[] }
  >();
  const resolutionCache = new Map<
    string,
    { definitions: Definition[]; limits: TestEvidenceLimit[] }
  >();
  const closureCache = new Map<
    string,
    { paths: readonly string[]; limits: readonly TestEvidenceLimit[] }
  >();
  const rootCache = new Map<
    string,
    { definitions: Definition[]; limits: TestEvidenceLimit[] }
  >();
  const declarationParents = new Map<Definition, Set<Definition>>();
  const declarationHits = new Map<Definition, EvidenceUnit[]>();
  const reachesUnit = new Set<Definition>();
  const indexed = new Set<Definition>();
  const propagationQueue: Definition[] = [];
  let propagationOffset = 0;
  const packageDirectories = new Map<string, string[]>();
  for (const file of files) {
    if (posix.basename(file.path) !== "package.json") continue;
    try {
      const manifest = JSON.parse(file.text) as { name?: string };
      if (typeof manifest.name === "string") {
        const directories = packageDirectories.get(manifest.name) ?? [];
        directories.push(posix.dirname(file.path));
        packageDirectories.set(manifest.name, directories);
      }
    } catch {
      // Invalid manifests cannot establish package identity.
    }
  }
  const reachesDiff = new Set(units.map((unit) => unit.file));
  const importers = new Map<string, string[]>();
  for (const [path, dependencies] of graph.edges)
    for (const dependency of dependencies) {
      const parents = importers.get(dependency) ?? [];
      parents.push(path);
      importers.set(dependency, parents);
    }
  const pending = [...reachesDiff];
  for (const dependency of pending)
    for (const path of importers.get(dependency) ?? [])
      if (!reachesDiff.has(path)) {
        reachesDiff.add(path);
        pending.push(path);
      }
  const target = (
    path: string,
    specifier: string,
    limits: TestEvidenceLimit[],
  ): string | undefined => {
    const edges = graph.edges.get(path) ?? [];
    let matches: readonly string[];
    if (specifier.startsWith(".") || path.endsWith(".py")) {
      let base: string;
      if (path.endsWith(".py")) {
        const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
        let dir = dots ? posix.dirname(path) : ".";
        for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
        base = posix.join(dir, specifier.slice(dots).replaceAll(".", "/"));
      } else base = posix.normalize(posix.join(posix.dirname(path), specifier));
      const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
      matches = edges.filter(
        (edge) =>
          edge === base ||
          edge.replace(/\.[cm]?[jt]sx?$/, "") === stem ||
          edge === `${base}.py` ||
          edge === `${base}/__init__.py` ||
          (/^index\.[jt]s$/.test(posix.basename(edge)) &&
            posix.dirname(edge) === base),
      );
    } else {
      // Only claim a package target when its manifest identifies the graph edge.
      const directories = packageDirectories.get(specifier) ?? [];
      matches = edges.filter((edge) =>
        directories.some(
          (directory) => !posix.relative(directory, edge).startsWith("../"),
        ),
      );
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1 || (specifier.startsWith(".") && edges.length))
      limits.push({
        path,
        kind: matches.length > 1 ? "ambiguous" : "unsupported",
        specifier,
      });
    return undefined;
  };
  const getModule = (path: string): Module => {
    const cached = modules.get(path);
    if (cached) return cached;
    const result: Module = {
      definitions: [],
      bindings: new Map(),
      exports: new Map(),
      stars: [],
      references: [],
      limits: [],
    };
    modules.set(path, result);
    const file = sources.get(path);
    if (!file) {
      result.limits.push({ path, kind: "unresolved" });
      return result;
    }
    if (!parser?.supports(path)) {
      result.limits.push({ path, kind: "grammar_absent" });
      return result;
    }
    const parsed = parser.parseRaw(path, file.text);
    if (!parsed.ok) {
      result.limits.push({ path, kind: "parse_failed" });
      return result;
    }
    // Declaration extraction reuses this AST rather than invoking the grammar a second time.
    const cachedParser = Object.create(parser) as SyntaxRootParser;
    cachedParser.parseRaw = () => parsed;
    const declarations =
      /(?:[._-]test|[._-]spec)\.[cm]?[jt]sx?$|(?:^|\/)test[^/]*\.py$/.test(path)
        ? {
            declarations: [],
            limits: parsed.root.find({ rule: { kind: "ERROR" } })
              ? [{ kind: "parse_partial" as const }]
              : [],
          }
        : cachedParser.declarations(path, file.text, {
            descendAbove: Infinity,
          });
    result.limits.push(
      ...declarations.limits.map((limit) => ({ ...limit, path })),
    );
    if (declarations.limits.some((limit) => limit.kind === "parse_failed")) {
      return result;
    }
    const lines = file.text.split("\n");
    const children = parsed.root.children().map((node) => ({
      node,
      start: node.range().start.line + 1,
      end: node.range().end.line + (node.range().end.column ? 1 : 0),
      refs: references(node),
    }));
    for (const declaration of declarations.declarations) {
      const refs: Reference[] = [];
      for (const child of children) {
        if (child.start >= declaration.start && child.end <= declaration.end)
          refs.push(...child.refs);
      }
      result.definitions.push({
        file: path,
        declaration,
        text: lines.slice(declaration.start - 1, declaration.end).join("\n"),
        references: refs,
      });
      if (declaration.exported || path.endsWith(".py"))
        result.exports.set(declaration.name, [
          { target: path, name: declaration.name },
        ]);
    }
    const addExport = (name: string, binding: Binding): void => {
      result.exports.set(name, [...(result.exports.get(name) ?? []), binding]);
    };
    for (const { node, refs } of children) {
      const kind = String(node.kind());
      if (kind === "import_statement" && !path.endsWith(".py")) {
        const string = node
          .children()
          .find((child) => child.kind() === "string");
        if (!string) continue;
        const specifier = string.text().slice(1, -1);
        const destination = target(path, specifier, result.limits);
        if (!destination) continue;
        const clause = node
          .children()
          .find((child) => child.kind() === "import_clause");
        if (!clause) continue;
        for (const child of clause.children()) {
          if (child.kind() === "identifier")
            result.bindings.set(child.text(), {
              target: destination,
              name: "default",
            });
          if (child.kind() === "namespace_import")
            result.bindings.set(child.children().at(-1)?.text() ?? "", {
              target: destination,
              name: "*",
            });
          if (child.kind() === "named_imports")
            for (const spec of child
              .children()
              .filter((part) => part.kind() === "import_specifier")) {
              const names = spec
                .children()
                .filter((part) => part.kind() === "identifier");
              result.bindings.set(names.at(-1)?.text() ?? "", {
                target: destination,
                name: names[0]?.text() ?? "",
              });
            }
        }
      } else if (kind === "export_statement") {
        const string = node
          .children()
          .find((child) => child.kind() === "string");
        const destination = string
          ? target(path, string.text().slice(1, -1), result.limits)
          : path;
        if (!destination) continue;
        const clause = node
          .children()
          .find((child) => child.kind() === "export_clause");
        if (clause)
          for (const spec of clause
            .children()
            .filter((part) => part.kind() === "export_specifier")) {
            const names = spec
              .children()
              .filter((part) => part.kind() === "identifier");
            addExport(names.at(-1)?.text() ?? "", {
              target: destination,
              name: names[0]?.text() ?? "",
            });
          }
        else if (node.children().some((child) => child.kind() === "*"))
          result.stars.push(destination);
        else if (node.children().some((child) => child.kind() === "default")) {
          const definition = result.definitions.find(
            (def) =>
              def.declaration.start <= node.range().start.line + 1 &&
              def.declaration.end >= node.range().end.line + 1,
          );
          const identifier = node
            .children()
            .find((child) => child.kind() === "identifier");
          if (definition || identifier)
            addExport("default", {
              target: path,
              name: definition?.declaration.name ?? identifier?.text() ?? "",
            });
          else
            result.limits.push({
              path,
              kind: "unsupported",
              specifier: "default export expression",
            });
        }
      } else if (
        path.endsWith(".py") &&
        /^(import_from_statement|import_statement)$/.test(kind)
      ) {
        const children = node.children();
        const from = kind === "import_from_statement";
        const moduleNode = from
          ? children.find((child) =>
              /^(dotted_name|relative_import)$/.test(String(child.kind())),
            )
          : undefined;
        const module = moduleNode?.text() ?? "";
        for (const child of children) {
          if (
            !/^(aliased_import|dotted_name)$/.test(String(child.kind())) ||
            child === moduleNode
          )
            continue;
          const names =
            child.kind() === "aliased_import"
              ? child
                  .children()
                  .filter((part) =>
                    /^(identifier|dotted_name)$/.test(String(part.kind())),
                  )
                  .map((part) => part.text())
              : [child.text()];
          const destination = target(
            path,
            from ? module : (names[0] ?? ""),
            result.limits,
          );
          if (destination)
            result.bindings.set(names.at(-1) ?? "", {
              target: destination,
              name: from ? (names[0] ?? "") : "*",
            });
        }
      } else result.references.push(...refs);
    }
    return result;
  };
  return (entry) => {
    const starts = [entry.path];
    if (entry.framework === "pytest")
      for (const file of files)
        if (
          posix.basename(file.path) === "conftest.py" &&
          (posix.dirname(file.path) === "." ||
            entry.path.startsWith(`${posix.dirname(file.path)}/`))
        )
          starts.push(file.path);
    const closures = starts.map((path) => {
      let closure = closureCache.get(path);
      if (!closure) {
        closure = importClosure(graph, path);
        closureCache.set(path, closure);
      }
      return closure;
    });
    const paths = [...new Set(closures.flatMap((closure) => closure.paths))];
    const limits: TestEvidenceLimit[] = closures.flatMap(
      (closure) => closure.limits,
    );
    // Missing lexical edges are already uncertain; AST analysis cannot invent a path.
    if (!units.length || !starts.some((path) => reachesDiff.has(path))) {
      return {
        paths,
        units: limits.length ? units : [],
        imports: [],
        usedBy: new Map(),
        limits,
        uncertain: limits.length > 0,
      };
    }
    const resolveUncached = (
      path: string,
      name: string,
      exported: boolean,
      seen = new Set<string>(),
    ): Definition[] => {
      if (!reachesDiff.has(path)) return [];
      const key = `${path}:${name}:${exported}`;
      if (seen.has(key)) return [];
      const next = new Set(seen).add(key);
      const module = getModule(path);
      if (!exported) {
        const local = module.definitions.filter(
          (def) => def.declaration.name === name,
        );
        if (local.length) return local;
        const binding = module.bindings.get(name);
        return binding && binding.name !== "*"
          ? resolve(binding.target, binding.name, true, next)
          : [];
      }
      if (module.stars.some((star) => !reachesDiff.has(star))) {
        limits.push({ path, kind: "ambiguous", specifier: name });
      }
      const bindings = module.exports.get(name);
      const found = bindings
        ? bindings.flatMap((binding) =>
            binding.target === path && binding.name === name
              ? module.definitions.filter(
                  (def) => def.declaration.name === name,
                )
              : resolve(
                  binding.target,
                  binding.name,
                  binding.target !== path,
                  next,
                ),
          )
        : name === "default"
          ? []
          : module.stars.flatMap((star) => resolve(star, name, true, next));
      const unique = [...new Set(found)];
      if (unique.length > 1)
        limits.push({ path, kind: "ambiguous", specifier: name });
      return unique;
    };
    const resolve = (
      path: string,
      name: string,
      exported: boolean,
      seen = new Set<string>(),
    ): Definition[] => {
      if (seen.size) return resolveUncached(path, name, exported, seen);
      const key = `${path}:${name}:${exported}`;
      const cached = resolutionCache.get(key);
      if (cached) {
        limits.push(...cached.limits);
        return cached.definitions;
      }
      const limitStart = limits.length;
      const definitions = resolveUncached(path, name, exported, seen);
      resolutionCache.set(key, {
        definitions,
        limits: limits.slice(limitStart),
      });
      return definitions;
    };
    const dependencies = (path: string, refs: Reference[]): Definition[] =>
      refs.flatMap((ref) => {
        const module = getModule(path);
        const binding = module.bindings.get(ref.name);
        const resolveImported = (name: string): Definition[] => {
          if (!binding) return [];
          if (!reachesDiff.has(binding.target)) return [];
          const found = resolve(binding.target, name, true);
          if (!found.length)
            limits.push({
              path,
              kind: "unresolved",
              specifier: `${ref.name}${ref.member ? `.${ref.member}` : ""}`,
            });
          return found;
        };
        if (ref.member && binding) {
          if (binding.name === "*") return resolveImported(ref.member);
          limits.push({
            path,
            kind: "unsupported",
            specifier: `${ref.name}.${ref.member}`,
          });
          return resolveImported(binding.name);
        }
        if (binding?.name === "*") {
          limits.push({ path, kind: "unsupported", specifier: ref.name });
          return [];
        }
        return binding
          ? resolveImported(binding.name)
          : resolve(path, ref.name, false);
      });
    const reachable = new Set<Definition>();
    const visit = (definition: Definition): void => {
      if (reachable.has(definition)) return;
      reachable.add(definition);
      let cached = dependencyCache.get(definition);
      if (!cached) {
        const limitStart = limits.length;
        const definitions = [
          ...new Set(dependencies(definition.file, definition.references)),
        ].filter((dep) => dep !== definition);
        cached = { definitions, limits: limits.slice(limitStart) };
        dependencyCache.set(definition, cached);
      } else limits.push(...cached.limits);
      const deps = cached.definitions;
      if (!indexed.has(definition)) {
        indexed.add(definition);
        const matched = units.filter(
          (unit) =>
            unit.file === definition.file &&
            (unit.name === definition.declaration.name ||
              (unit.afterRange &&
                unit.afterRange.start <= definition.declaration.end &&
                unit.afterRange.end >= definition.declaration.start)),
        );
        if (matched.length) declarationHits.set(definition, matched);
        for (const dependency of deps) {
          const parents =
            declarationParents.get(dependency) ?? new Set<Definition>();
          parents.add(definition);
          declarationParents.set(dependency, parents);
        }
        if (
          (matched.length ||
            deps.some((dependency) => reachesUnit.has(dependency))) &&
          !reachesUnit.has(definition)
        ) {
          reachesUnit.add(definition);
          propagationQueue.push(definition);
        }
      }
      for (const dep of deps) visit(dep);
    };
    for (const start of starts) {
      let roots = rootCache.get(start);
      if (!roots) {
        const module = getModule(start);
        const limitStart = limits.length;
        roots = {
          definitions: [
            ...dependencies(start, module.references),
            ...module.definitions,
          ],
          limits: limits.slice(limitStart),
        };
        rootCache.set(start, roots);
      } else limits.push(...roots.limits);
      for (const definition of roots.definitions) visit(definition);
    }
    while (propagationOffset < propagationQueue.length) {
      const dependency = propagationQueue[propagationOffset++];
      if (!dependency) continue;
      for (const parent of declarationParents.get(dependency) ?? []) {
        if (reachesUnit.has(parent)) continue;
        reachesUnit.add(parent);
        propagationQueue.push(parent);
      }
    }
    const hits = new Map(
      [...reachable].flatMap((definition) => {
        const matched = declarationHits.get(definition);
        return matched ? [[definition, matched] as const] : [];
      }),
    );
    const relevant = new Set(
      [...reachable].filter((definition) => reachesUnit.has(definition)),
    );
    for (const path of paths) limits.push(...(modules.get(path)?.limits ?? []));
    const uniqueLimits = [
      ...new Map(
        limits.map((limit) => [
          `${limit.path}:${limit.kind}:${limit.specifier ?? ""}`,
          limit,
        ]),
      ).values(),
    ];
    // Unknown import edges stay conservative; declaration limits affect only
    // branches whose files can reach the diff through known import edges.
    const uncertain =
      closures.some((closure) => closure.limits.length > 0) ||
      uniqueLimits.some((limit) => reachesDiff.has(limit.path));
    const reached = units.filter(
      (unit) =>
        paths.includes(unit.file) ||
        closures.some((closure) => closure.limits.length),
    );
    const intermediates = [...relevant].filter(
      (definition) => definition.file !== entry.path && !hits.has(definition),
    );
    const imports = intermediates
      .filter(
        (definition) => !units.some((unit) => unit.file === definition.file),
      )
      .map((definition) => ({ path: definition.file, text: definition.text }));
    const usedBy = new Map<string, ImportSource[]>();
    for (const unit of reached)
      usedBy.set(
        unit.id,
        intermediates
          .filter((definition) => definition.file === unit.file)
          .map((definition) => ({
            path: definition.file,
            text: definition.text,
          })),
      );
    return {
      paths,
      units: reached,
      imports,
      usedBy,
      limits: uniqueLimits,
      uncertain,
    };
  };
}
