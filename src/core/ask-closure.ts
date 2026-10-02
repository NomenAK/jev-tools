import { posix } from "node:path";
import {
  CLOSURE_MAX_CHARS,
  STATE_MAX_CHARS,
  UNIT_MAX_CHARS,
} from "../constants.ts";
import type { Json, State } from "../jev/types.ts";
import type {
  ProofBinding,
  ProofDeclaration,
  ProofSyntax,
} from "./ask-proof.ts";
import type { ImportGraph } from "./imports.ts";
import type { Limitation } from "./output.ts";
import { truncate } from "./truncate.ts";

interface Candidate {
  declaration: ProofDeclaration;
  priority: number;
  depth: number;
  typeOnly: boolean;
}
export function buildAskClosure({
  graph,
  syntax,
  paths,
  intentions,
  state,
}: {
  graph: ImportGraph;
  syntax: ProofSyntax;
  paths: readonly string[];
  intentions: string;
  state: State;
}): {
  state: State;
  added: readonly { path: string; name: string; chars: number }[];
  omitted: readonly { path: string; name: string; reason: string }[];
  limitations: readonly Limitation[];
} {
  const limitations: Limitation[] = [];
  const dependencyLimit = (
    path: string,
    dependency: string,
    cause: string,
  ): Limitation => {
    const nonRelative =
      /^(?:unresolved|ambiguous) import$/.test(cause) &&
      dependency.length > 0 &&
      !dependency.startsWith(".") &&
      !dependency.startsWith("/") &&
      !dependency.startsWith("sys.path");
    return {
      path,
      dependency,
      cause: `${cause}${nonRelative ? " (external or standard-library, or unresolved repository alias)" : ""}`,
      fact: `${path} : ${dependency}, ${cause}${nonRelative ? "; external or standard-library dependency (or unresolved repository alias), not admitted as a repository file" : ""}`,
      next: nonRelative
        ? "Provide the dependency contract in state or a repository-local implementation in paths; do not read outside the repository."
        : "Provide the dependency explicitly in paths.",
    };
  };
  const relevant = new Set(paths);
  const candidates = new Map<string, Candidate>();
  const originalFiles =
    state.files &&
    typeof state.files === "object" &&
    !Array.isArray(state.files)
      ? state.files
      : {};
  const contained = (path: string) =>
    paths.includes(path) || Object.hasOwn(originalFiles, path);
  const declarations = (path: string, name: string) =>
    syntax.declarations.filter(
      (item) =>
        item.path === path &&
        (name === "*" ||
          item.name === name ||
          item.name.startsWith(`${name}.`)),
    );
  const mentioned = (name: string) =>
    intentions.split(/[^\p{L}\p{N}_$.]+/u).includes(name);
  const add = (
    declaration: ProofDeclaration,
    direct: boolean,
    depth: number,
    typeOnly = false,
  ) => {
    if (contained(declaration.path)) return;
    const changed =
      declaration.before !== undefined &&
      declaration.before !== declaration.text;
    const priority =
      mentioned(declaration.name) || direct ? 0 : changed ? 1 : 2;
    const key = `${declaration.path} (${declaration.name})`;
    const previous = candidates.get(key);
    if (
      !previous ||
      priority < previous.priority ||
      (priority === previous.priority &&
        (Number(typeOnly) < Number(previous.typeOnly) ||
          (typeOnly === previous.typeOnly && depth < previous.depth)))
    )
      candidates.set(key, { declaration, priority, depth, typeOnly });
  };
  const target = (binding: ProofBinding): string | undefined => {
    if (!binding.specifier) return binding.path;
    const edges = graph.edges.get(binding.path) ?? [];
    const python = binding.path.endsWith(".py");
    let base: string;
    if (python) {
      const relative = binding.specifier.match(/^\.+/)?.[0].length ?? 0;
      base = relative
        ? posix.join(
            posix.dirname(binding.path),
            ...Array.from({ length: relative - 1 }, () => ".."),
            binding.specifier.slice(relative).replaceAll(".", "/"),
          )
        : binding.specifier.replaceAll(".", "/");
    } else
      base =
        binding.specifier.startsWith(".") || binding.data
          ? posix.join(posix.dirname(binding.path), binding.specifier)
          : binding.specifier;
    base = posix.normalize(base);
    const alternatives = python
      ? [
          base,
          `${base}.py`,
          `${base}/__init__.py`,
          `${base}/${binding.imported}.py`,
        ]
      : [
          base,
          ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].map(
            (extension) => base.replace(/\.js$/, "") + extension,
          ),
          ...["ts", "tsx", "js", "jsx"].map(
            (extension) => `${base}/index.${extension}`,
          ),
        ];
    const matches = edges.filter((edge) =>
      alternatives.some(
        (alternative) =>
          edge === alternative ||
          (!binding.specifier.startsWith(".") &&
            edge.endsWith(`/${alternative}`)),
      ),
    );
    if (matches.length === 1) return matches[0];
    limitations.push(
      dependencyLimit(
        binding.path,
        binding.specifier,
        matches.length > 1 ? "ambiguous import" : "unresolved import",
      ),
    );
    return undefined;
  };
  const resolve = (
    path: string,
    name: string,
    direct: boolean,
    depth: number,
    visited: Set<string>,
    typeOnly = false,
  ) => {
    relevant.add(path);
    const key = `${path}:${name}`;
    if (visited.has(key)) return;
    visited.add(key);
    const found = declarations(path, name);
    for (const declaration of found) add(declaration, direct, depth, typeOnly);
    const exports = syntax.bindings.filter(
      (item) =>
        item.path === path &&
        item.reexport &&
        (item.local === name || item.local === "*" || name === "*"),
    );
    if (!found.length && !exports.length && !contained(path))
      limitations.push({
        fact: `${path} (${name}) : used declaration not found`,
        next: "Provide the declaration explicitly in paths.",
      });
    for (const binding of exports) {
      const destination = target(binding);
      if (destination)
        resolve(
          destination,
          binding.imported === "*" ? name : binding.imported,
          direct,
          depth,
          visited,
          typeOnly,
        );
    }
  };
  for (const path of paths) {
    const used =
      syntax.uses?.get(path) ??
      syntax.declarations
        .filter((item) => item.path === path)
        .flatMap((item) => item.usedNames);
    for (const binding of syntax.bindings.filter(
      (item) =>
        item.path === path &&
        (!item.reexport || path.endsWith("__init__.py")) &&
        (item.used ?? used.includes(item.local)),
    )) {
      const destination = target(binding);
      if (!destination) continue;
      if (binding.data) {
        relevant.add(destination);
        const source = syntax.sources?.find(
          (item) => item.path === destination,
        );
        if (source)
          add(
            {
              path: destination,
              name: "data",
              text: source.text,
              ...(syntax.before && Object.hasOwn(syntax.before, destination)
                ? { before: syntax.before[destination] }
                : {}),
              usedNames: [],
            },
            true,
            1,
          );
        else
          limitations.push({
            fact: `${destination} : data missing from the inventory`,
            next: "Provide this file in paths.",
          });
      } else if (binding.imported === "*" && binding.local !== "*") {
        const members = used.filter((item) =>
          item.startsWith(`${binding.local}.`),
        );
        for (const name of members)
          resolve(
            destination,
            name.slice(binding.local.length + 1),
            true,
            1,
            new Set(),
            binding.valueMembers
              ? !binding.valueMembers.includes(name)
              : binding.typeOnly,
          );
        if (!members.length)
          limitations.push({
            fact: `${path} : namespace ${binding.local} used without a statically resolved member`,
            next: "Provide the namespace declarations explicitly.",
          });
      } else
        resolve(
          destination,
          binding.imported,
          true,
          1,
          new Set(),
          binding.typeOnly,
        );
    }
    if (
      path.endsWith(".py") &&
      /(^|\/)(test[^/]*|[^/]*_test)\.py$/.test(path)
    ) {
      const fixtures = syntax.declarations.filter(
        (item) =>
          item.fixture &&
          posix.basename(item.path) === "conftest.py" &&
          (posix.dirname(item.path) === "." ||
            path.startsWith(`${posix.dirname(item.path)}/`)),
      );
      // Nearest fixture shadows ancestors, as in pytest.
      fixtures.sort((a, b) => b.path.length - a.path.length);
      const selected = new Set<string>();
      for (const fixture of fixtures) {
        if (
          selected.has(fixture.name) ||
          (!fixture.autouse && !used.includes(fixture.name))
        )
          continue;
        selected.add(fixture.name);
        relevant.add(fixture.path);
        add(fixture, true, 1);
        for (const name of fixture.usedNames)
          for (const helper of declarations(fixture.path, name))
            add(helper, false, 1);
        for (const binding of syntax.bindings.filter(
          (item) =>
            item.path === fixture.path &&
            fixture.usedNames.includes(item.local),
        )) {
          const destination = target(binding);
          if (destination)
            resolve(destination, binding.imported, false, 1, new Set());
        }
      }
    }
  }
  for (const limit of syntax.limits)
    if ([...relevant].some((path) => limit.fact.includes(path)))
      limitations.push(limit);
  for (const limit of graph.limits)
    if (relevant.has(limit.path))
      limitations.push(
        dependencyLimit(limit.path, limit.specifier, `${limit.kind} import`),
      );
  const ordered = [...candidates.values()].sort(
    (a, b) =>
      a.priority - b.priority ||
      Number(a.typeOnly) - Number(b.typeOnly) ||
      Number(
        b.declaration.before !== undefined &&
          b.declaration.before !== b.declaration.text,
      ) -
        Number(
          a.declaration.before !== undefined &&
            a.declaration.before !== a.declaration.text,
        ) ||
      a.depth - b.depth ||
      a.declaration.path.localeCompare(b.declaration.path) ||
      a.declaration.name.localeCompare(b.declaration.name),
  );
  const existing =
    state.closure &&
    typeof state.closure === "object" &&
    !Array.isArray(state.closure)
      ? state.closure
      : {};
  const closure: Record<string, Json> = { ...existing };
  let nextState = state;
  let budget = JSON.stringify(existing).length - 2;
  const added: { path: string; name: string; chars: number }[] = [];
  const omitted: { path: string; name: string; reason: string }[] = [];
  for (const { declaration } of ordered) {
    const { path, name } = declaration;
    const key = `${path} (${name})`;
    const paired =
      declaration.before !== undefined &&
      declaration.before !== declaration.text;
    if (Object.hasOwn(closure, key)) continue;
    const beforeBudget =
      !paired || declaration.before == null
        ? 0
        : declaration.before.length + declaration.text.length > UNIT_MAX_CHARS
          ? Math.floor(UNIT_MAX_CHARS / 2)
          : declaration.before.length;
    const before = !paired
      ? undefined
      : declaration.before == null
        ? declaration.before
        : truncate(declaration.before, beforeBudget);
    const after = truncate(
      declaration.text,
      UNIT_MAX_CHARS - (before?.length ?? 0),
    );
    const sliced =
      after.length < declaration.text.length ||
      (paired && (before?.length ?? 0) < (declaration.before?.length ?? 0));
    const value: Json = !paired
      ? after
      : { before: before ?? null, after: declaration.deleted ? null : after };
    const chars = after.length + (before?.length ?? 0);
    const contribution =
      JSON.stringify(key).length +
      1 +
      JSON.stringify(value).length +
      (Object.keys(closure).length ? 1 : 0);
    const candidateState = { ...state, closure: { ...closure, [key]: value } };
    const reason =
      budget + contribution > CLOSURE_MAX_CHARS
        ? "closure budget exceeded"
        : JSON.stringify(candidateState).length > STATE_MAX_CHARS
          ? "serialized state limit exceeded"
          : undefined;
    if (reason) {
      omitted.push({ path, name, reason });
      limitations.push({
        fact: `${key} : declaration omitted, ${reason}`,
        next: "Provide this declaration in a smaller call.",
      });
      continue;
    }
    closure[key] = value;
    nextState = candidateState;
    budget += contribution;
    added.push({ path, name, chars });
    if (sliced)
      limitations.push({
        fact: `${key} : sliced declaration (${chars} characters)`,
        next: "Read the complete declaration before drawing conclusions about an omitted part.",
      });
  }
  limitations.push({
    fact: "Import closure only, semantic depth 1; files without an import link are not checked.",
    next: "Provide configuration, documentation or data dependencies not linked by imports in paths.",
  });
  const seen = new Map<string, Limitation>();
  for (const limit of limitations) {
    const key = JSON.stringify(
      limit.path
        ? [limit.path, limit.cause, limit.dependency]
        : [limit.fact, limit.next],
    );
    const previous = seen.get(key);
    if (previous) {
      if (limit.cause === "dynamic import") {
        previous.count = (previous.count ?? 1) + 1;
        previous.fact = `${limit.fact} (${previous.count} occurrences)`;
      }
    } else seen.set(key, { ...limit });
  }
  const unique = [...seen.values()];
  return { state: nextState, added, omitted, limitations: unique };
}
