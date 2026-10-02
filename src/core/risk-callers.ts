import type { SgNode } from "@ast-grep/napi";
import {
  CLOSURE_MAX_CHARS,
  STATE_MAX_CHARS,
  UNIT_MAX_CHARS,
} from "../constants.ts";
import type { Json, Question, State } from "../jev/types.ts";
import type { EvidenceUnit } from "./units.ts";

export interface CallerSource {
  path: string;
  before: string | null;
  after: string | null;
  beforePath?: string;
  limitation?: string;
}
export interface CallerParser {
  supports(path: string): boolean;
  parse(path: string, text: string): SgNode | null;
}
export interface EvidenceSpan {
  path: string;
  start: number;
  end: number;
}
export interface CallerLimit {
  unitId: string;
  kind:
    | "parser_absent"
    | "parse_failed"
    | "parse_partial"
    | "binding_unknown"
    | "provider_missing"
    | "dynamic_import"
    | "metaprogramming"
    | "piece_cut"
    | "budget"
    | "unreadable"
    | "caller_missing"
    | "dynamic_access_uncovered";
  reason: string;
  paths: string[];
  missing: string;
}
export interface CallerProof {
  unitId: string;
  state: State;
  question: Question;
  paths: EvidenceSpan[];
}
export interface CallerPreparation {
  proofs: CallerProof[];
  limits: CallerLimit[];
}
interface Parsed {
  path: string;
  root: SgNode;
  all: SgNode[];
  errors: { start: number; end: number }[];
  syntax: {
    node: SgNode;
    name: string;
    start: number;
    end: number;
    invalid: boolean;
    callable: boolean;
  }[];
  syntaxByName: Map<string, Parsed["syntax"]>;
  ranges: Map<number, { start: number; end: number }>;
  scopes: Map<number, SgNode>;
  parents: Map<number, SgNode | undefined>;
  declarations: Map<number, Map<string, SgNode[]>>;
  writes: Map<string, Set<number>>;
  imports: SgNode[];
  identifiers: SgNode[];
  calls: SgNode[];
  aliases: Map<string, Set<string>>;
  memo: Map<string, Located | undefined>;
  dynamic: boolean;
  meta: boolean;
}
interface Located {
  file: Parsed;
  node: SgNode;
}
interface Piece extends EvidenceSpan {
  text: string;
}
const question: Question = {
  type: "choice",
  instructions:
    "Compare the concrete before caller/provider/unit combination to the complete after combination, accounting for all coordinated edits. From the source code shown (not an execution), what happens to this concrete caller? If the actual provider implementation is missing or selected from unseen configuration, choose cannot_tell.",
  criteria: {
    no_new_failure:
      "The after caller path still works: supported rename, equivalent refactor, or coordinated migration; no newly failing call is shown.",
    new_failure:
      "The before caller succeeds, but the after caller adds a concrete exception, rejected await or missing/non-callable member on that path.",
    cannot_tell:
      "The actual provider implementation or binding needed to establish the caller outcome is not present.",
  },
};
const callableKinds: Record<string, true> = {
  function_declaration: true,
  generator_function_declaration: true,
  function_definition: true,
  method_definition: true,
  arrow_function: true,
  function_expression: true,
};
function nodes(root: SgNode, file?: Parsed): SgNode[] {
  const range = file?.ranges.get(root.id());
  if (file && range) return file.all.slice(range.start, range.end);
  const result: SgNode[] = [];
  const visit = (node: SgNode) => {
    result.push(node);
    for (const child of node.children()) visit(child);
  };
  visit(root);
  return result;
}
function indexFile(path: string, root: SgNode): Parsed {
  const file: Parsed = {
    path,
    root,
    all: [],
    errors: [],
    syntax: [],
    syntaxByName: new Map(),
    ranges: new Map(),
    scopes: new Map(),
    parents: new Map(),
    declarations: new Map(),
    writes: new Map(),
    imports: [],
    identifiers: [],
    calls: [],
    aliases: new Map(),
    memo: new Map(),
    dynamic: false,
    meta: false,
  };
  const invalid = new Set<number>();
  for (const error of root.findAll({ rule: { kind: "ERROR" } })) {
    const range = error.range();
    file.errors.push({
      start: range.start.line + 1,
      end: range.end.line + (range.end.column === 0 ? 0 : 1),
    });
    invalid.add(error.id());
    for (const ancestor of error.ancestors()) invalid.add(ancestor.id());
  }
  const syntaxNode = (
    node: SgNode,
    name: string,
    invalidClass: boolean,
    callable: boolean,
  ) => {
    const range = node.range();
    const entry = {
      node,
      name,
      start: range.start.line + 1,
      end: range.end.line + (range.end.column === 0 ? 0 : 1),
      invalid: invalid.has(node.id()) || invalidClass,
      callable,
    };
    file.syntax.push(entry);
    const named = file.syntaxByName.get(name) ?? [];
    named.push(entry);
    file.syntaxByName.set(name, named);
  };
  const visit = (
    node: SgNode,
    owner?: SgNode,
    declaratorName?: string,
    invalidClass = false,
    indexOnly = false,
  ) => {
    const kind = String(node.kind());
    const callable = !!callableKinds[kind];
    const classNode =
      kind === "class_declaration" || kind === "class_definition";
    const badClass = invalidClass || (classNode && invalid.has(node.id()));
    const skip =
      kind === "ERROR" ||
      ((callable ||
        /^(?:export_statement|lexical_declaration|variable_declaration|variable_declarator|class_declaration|class_definition|assignment)$/.test(
          kind,
        )) &&
        invalid.has(node.id()));
    const syntaxKind =
      callable ||
      classNode ||
      kind === "interface_declaration" ||
      kind === "type_alias_declaration" ||
      kind === "variable_declarator" ||
      kind === "assignment";
    if (syntaxKind) {
      const syntaxName = node.field("name")?.text() ?? declaratorName ?? "";
      syntaxNode(node, syntaxName, badClass, callable);
    }
    const childDeclarator =
      kind === "variable_declarator"
        ? node.field("name")?.text()
        : declaratorName;
    if (skip || indexOnly) {
      for (const child of node.children())
        visit(child, owner, childDeclarator, badClass, true);
      return;
    }
    const start = file.all.length;
    file.all.push(node);
    const nameNode = ["variable_declarator", "assignment"].includes(kind)
      ? (node.field("name") ?? node.field("left"))
      : [
            "function_declaration",
            "function_definition",
            "class_declaration",
            "class_definition",
          ].includes(kind)
        ? node.field("name")
        : undefined;
    if (nameNode && owner) {
      const names =
        file.declarations.get(owner.id()) ?? new Map<string, SgNode[]>();
      const name = nameNode.text();
      const declarations = names.get(name) ?? [];
      declarations.push(node);
      names.set(name, declarations);
      file.declarations.set(owner.id(), names);
      const value = node.field("value") ?? node.field("right");
      if (
        value &&
        ["identifier", "member_expression", "attribute"].includes(
          String(value.kind()),
        )
      ) {
        const original = (
          value.field("property") ??
          value.field("attribute") ??
          value
        ).text();
        const aliases = file.aliases.get(original) ?? new Set<string>();
        aliases.add(name);
        file.aliases.set(original, aliases);
      }
    }
    if (["import_specifier", "aliased_import"].includes(kind)) {
      const original = node.field("name")?.text();
      const alias = node.field("alias")?.text();
      if (original && alias) {
        const aliases = file.aliases.get(original) ?? new Set<string>();
        aliases.add(alias);
        file.aliases.set(original, aliases);
      }
    }
    if (kind === "import_clause") {
      const alias = node
        .children()
        .find((child) => child.kind() === "identifier")
        ?.text();
      if (alias) {
        const aliases = file.aliases.get("default") ?? new Set<string>();
        aliases.add(alias);
        file.aliases.set("default", aliases);
      }
    }
    if (
      [
        "assignment_expression",
        "augmented_assignment",
        "update_expression",
        "assignment",
      ].includes(kind)
    ) {
      const left = node.field("left") ?? node.field("argument");
      const name = left?.text().split(/[.[]/, 1)[0];
      if (name) {
        const writes = file.writes.get(name) ?? new Set<number>();
        writes.add(node.id());
        file.writes.set(name, writes);
      }
    }
    if (["import_statement", "import_from_statement"].includes(kind))
      file.imports.push(node);
    if (kind === "identifier") file.identifiers.push(node);
    if (["call", "call_expression"].includes(kind)) {
      file.calls.push(node);
      const called = node.field("function")?.text();
      if (called === "__import__") file.dynamic = true;
      if (
        ["eval", "exec", "setattr", "Object.defineProperty"].includes(
          called ?? "",
        )
      )
        file.meta = true;
    }
    if (kind === "import" && node.parent()?.kind() === "call_expression")
      file.dynamic = true;
    if (
      callableKinds[kind] ||
      ["program", "module", "statement_block", "block"].includes(kind)
    ) {
      file.parents.set(node.id(), owner);
      owner = node;
    }
    if (owner) file.scopes.set(node.id(), owner);
    for (const child of node.children())
      visit(child, owner, childDeclarator, badClass);
    file.ranges.set(node.id(), { start, end: file.all.length });
  };
  visit(root);
  return file;
}
function envelope(node: SgNode): SgNode {
  let current = node;
  const parent = current.parent();
  if (
    parent &&
    ["variable_declarator", "assignment"].includes(String(parent.kind())) &&
    (parent.field("value") ?? parent.field("right"))?.id() === current.id()
  )
    current = parent.parent() ?? parent;
  if (
    ["arrow_function", "function_expression"].includes(String(current.kind()))
  )
    current =
      current
        .ancestors()
        .find((n) =>
          ["lexical_declaration", "variable_declaration"].includes(
            String(n.kind()),
          ),
        ) ?? current;
  if (
    ["export_statement", "decorated_definition"].includes(
      String(current.parent()?.kind()),
    )
  )
    current = current.parent() ?? current;
  return current;
}
function piece(file: Parsed, node: SgNode): Piece {
  const value = envelope(node);
  const range = value.range();
  return {
    path: file.path,
    start: range.start.line + 1,
    end: range.end.line + (range.end.column === 0 ? 0 : 1),
    text: value.text(),
  };
}
function parameters(node: SgNode): string[] {
  const params = node.field("parameters");
  if (!params) return [];
  return params
    .children()
    .filter((n) => !["(", ")", ","].includes(n.text()))
    .map(
      (n) => n.field("pattern")?.text() ?? n.field("name")?.text() ?? n.text(),
    );
}
function functionName(node: SgNode): string {
  return (
    node.field("name")?.text() ??
    node
      .ancestors()
      .find((n) => n.kind() === "variable_declarator")
      ?.field("name")
      ?.text() ??
    ""
  );
}
function members(
  node: SgNode,
  file?: Parsed,
): { receiver: string; member: string }[] {
  return nodes(node, file)
    .filter((n) =>
      ["member_expression", "attribute"].includes(String(n.kind())),
    )
    .map((n) => ({
      receiver: (n.field("object") ?? n.field("value"))?.text() ?? "",
      member: (n.field("property") ?? n.field("attribute"))?.text() ?? "",
    }))
    .filter((n) => n.receiver && n.member);
}
function resolvePath(
  path: string,
  specifier: string,
  files: readonly Parsed[],
): Parsed | undefined {
  const parts = path.split("/");
  parts.pop();
  let candidates: string[];
  if (specifier.startsWith(".")) {
    const input = specifier.includes("/")
      ? specifier
      : specifier.replaceAll(".", "/");
    for (const part of input.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    candidates = [parts.join("/")];
  } else
    candidates = [
      specifier.replaceAll(".", "/"),
      [...parts, specifier.replaceAll(".", "/")].join("/"),
    ];
  const sourceExtensions: Record<string, string> = {
    ".js": ".ts",
    ".jsx": ".tsx",
    ".mjs": ".mts",
    ".cjs": ".cts",
  };
  for (const candidate of [...candidates]) {
    const extension = /\.[^./]+$/.exec(candidate)?.[0] ?? "";
    const sourceExtension = sourceExtensions[extension];
    if (sourceExtension)
      candidates.push(candidate.slice(0, -extension.length) + sourceExtension);
  }
  const matches = files.filter((file) =>
    candidates.some(
      (base) =>
        file.path === base ||
        [
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
          ".mts",
          ".cts",
          ".mjs",
          ".cjs",
          ".py",
          "/index.ts",
          "/index.js",
          "/__init__.py",
        ].some((ext) => file.path === base + ext),
    ),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
function resolveIdentifier(
  file: Parsed,
  name: string,
  at: SgNode,
  files: readonly Parsed[],
  seen = new Set<string>(),
): Located | undefined {
  const scope = file.scopes.get(at.id());
  const key = `${name}:${scope?.id() ?? at.id()}`;
  const cycleKey = `${file.path}:${key}`;
  if (seen.has(cycleKey)) return;
  if (file.memo.has(key)) return file.memo.get(key);
  seen.add(cycleKey);
  const resolved = resolveScopedIdentifier(file, name, scope, files, seen);
  seen.delete(cycleKey);
  file.memo.set(key, resolved);
  return resolved;
}
function resolveScopedIdentifier(
  file: Parsed,
  name: string,
  scope: SgNode | undefined,
  files: readonly Parsed[],
  seen: Set<string>,
): Located | undefined {
  for (; scope; scope = file.parents.get(scope.id())) {
    const candidates = file.declarations.get(scope.id())?.get(name) ?? [];
    if (candidates.length > 1) return;
    const found = candidates[0];
    if (found) {
      if (
        ["variable_declarator", "assignment"].includes(String(found.kind()))
      ) {
        const writes = file.writes.get(name);
        if (writes && (writes.size > 1 || !writes.has(found.id()))) return;
      }
      const value = found.field("value") ?? found.field("right");
      if (
        value &&
        ["identifier", "member_expression", "attribute"].includes(
          String(value.kind()),
        )
      )
        return resolveExpression(file, value, files, seen);
      return { file, node: value ?? found };
    }
    if (callableKinds[String(scope.kind())] && parameters(scope).includes(name))
      return;
  }
  for (const imp of file.imports) {
    const source = imp.field("source") ?? imp.field("module_name");
    if (!source) continue;
    const specifier =
      source.kind() === "string" ? source.text().slice(1, -1) : source.text();
    let imported: string | undefined;
    for (const binding of nodes(imp, file)) {
      if (
        ["import_specifier", "aliased_import"].includes(String(binding.kind()))
      ) {
        const original = binding.field("name");
        const alias = binding.field("alias");
        if ((alias ?? original)?.text() === name) imported = original?.text();
      }
      if (
        binding.kind() === "import_clause" &&
        binding
          .children()
          .some((n) => n.kind() === "identifier" && n.text() === name)
      )
        imported = "default";
      if (
        imp.kind() === "import_from_statement" &&
        binding.kind() === "dotted_name" &&
        binding.id() !== source.id() &&
        binding.text() === name
      )
        imported = name;
    }
    if (!imported) continue;
    const other = resolvePath(file.path, specifier, files);
    if (!other) return;
    if (imported === "default") {
      const exp = other.all.find(
        (n) =>
          n.kind() === "export_statement" &&
          n.children().some((c) => c.kind() === "default"),
      );
      const value =
        exp?.field("declaration") ??
        exp?.field("value") ??
        exp?.children().find((n) => callableKinds[String(n.kind())]);
      return value ? { file: other, node: value } : undefined;
    }
    return resolveIdentifier(other, imported, other.root, files, seen);
  }
  return;
}
function resolveExpression(
  file: Parsed,
  value: SgNode,
  files: readonly Parsed[],
  seen = new Set<string>(),
): Located | undefined {
  if (value.kind() === "identifier")
    return resolveIdentifier(file, value.text(), value, files, seen);
  if (!["member_expression", "attribute"].includes(String(value.kind())))
    return;
  const receiver = (value.field("object") ?? value.field("value"))?.text();
  const member = (value.field("property") ?? value.field("attribute"))?.text();
  if (!receiver || !member) return;
  for (const imp of file.imports.filter(
    (n) => n.kind() === "import_statement",
  )) {
    const source = imp.field("source");
    const namespace = nodes(imp, file).find(
      (n) =>
        n.kind() === "namespace_import" &&
        n
          .children()
          .some((c) => c.kind() === "identifier" && c.text() === receiver),
    );
    const pythonAlias = nodes(imp, file).find(
      (n) =>
        n.kind() === "aliased_import" && n.field("alias")?.text() === receiver,
    );
    const pythonModule = nodes(imp, file).find(
      (n) => n.kind() === "dotted_name" && n.text() === receiver,
    );
    const specifier = source
      ? source.text().slice(1, -1)
      : (pythonAlias?.field("name") ?? pythonModule)?.text();
    if ((!namespace && !pythonAlias && !pythonModule) || !specifier) continue;
    const other = resolvePath(file.path, specifier, files);
    if (other) return resolveIdentifier(other, member, other.root, files, seen);
  }
  return;
}
function provider(
  file: Parsed,
  value: SgNode,
  files: readonly Parsed[],
  seen = new Set<string>(),
): Located | undefined {
  const key = `${file.path}:${value.id()}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (
    [
      "object",
      "dictionary",
      "class_declaration",
      "class_definition",
      "list",
      "tuple",
    ].includes(String(value.kind()))
  ) {
    if (
      nodes(value, file).some(
        (n) =>
          ([
            "spread_element",
            "dictionary_splat",
            "class_heritage",
            "argument_list",
          ].includes(String(n.kind())) &&
            n.parent()?.id() === value.id()) ||
          n.field("name")?.text() === "__getattr__" ||
          n.field("name")?.text() === "__getattribute__",
      )
    )
      return;
    return { file, node: value };
  }
  if (value.kind() === "identifier") {
    const found = resolveIdentifier(file, value.text(), value, files);
    return found ? provider(found.file, found.node, files, seen) : undefined;
  }
  if (
    ["new_expression", "call", "call_expression"].includes(String(value.kind()))
  ) {
    const fn = value.field("constructor") ?? value.field("function");
    if (!fn) return;
    const found = resolveExpression(file, fn, files);
    if (!found) return;
    if (
      ["class_declaration", "class_definition"].includes(
        String(found.node.kind()),
      )
    )
      return provider(found.file, found.node, files, seen);
    if (callableKinds[String(found.node.kind())]) {
      const returns = nodes(found.node, found.file).filter(
        (n) => n.kind() === "return_statement",
      );
      if (returns.length !== 1) return;
      const returned = returns[0]
        ?.children()
        .find((n) => n.kind() !== "return");
      if (!returned) return;
      const supplied = provider(found.file, returned, files, seen);
      return supplied ? { file: found.file, node: found.node } : undefined;
    }
  }
  return;
}
export function prepareRiskCallers(
  units: readonly EvidenceUnit[],
  sources: readonly CallerSource[],
  parser: CallerParser | null | undefined,
  budgets: { piece?: number; closure?: number; state?: number } = {},
): CallerPreparation {
  const result: CallerPreparation = { proofs: [], limits: [] };
  const parsed: Record<"before" | "after", Parsed[]> = {
    before: [],
    after: [],
  };
  const failures: {
    path: string;
    kind: CallerLimit["kind"];
    missing: string;
  }[] = [];
  if (parser)
    for (const source of sources) {
      if (source.limitation)
        failures.push({
          path: source.path,
          kind: "unreadable",
          missing: source.limitation,
        });
      let beforeFile: Parsed | undefined;
      for (const side of ["before", "after"] as const) {
        const text = source[side];
        if (text === null) continue;
        const path =
          side === "before" ? (source.beforePath ?? source.path) : source.path;
        if (
          side === "after" &&
          beforeFile?.path === path &&
          source.before === text
        ) {
          parsed.after.push({ ...beforeFile, memo: new Map() });
          for (const failure of failures.filter(
            (failure) =>
              failure.path === path &&
              failure.kind === "parse_partial" &&
              failure.missing.startsWith("before "),
          ))
            failures.push({
              ...failure,
              missing: failure.missing.replace(/^before /, "after "),
            });
          continue;
        }
        if (!parser.supports(path)) {
          failures.push({
            path,
            kind: "parser_absent",
            missing: `${side} grammar`,
          });
          continue;
        }
        const root = parser.parse(path, text);
        if (root) {
          const errors = root.findAll({ rule: { kind: "ERROR" } });
          if (errors.length) {
            const lines = [
              ...new Set(errors.map((error) => error.range().start.line + 1)),
            ];
            failures.push({
              path,
              kind: "parse_partial",
              missing: `${side} syntax at lines ${lines.slice(0, 3).join(", ")}${lines.length > 3 ? "…" : ""} (${errors.length} errors)`,
            });
          }
          const file = indexFile(path, root);
          parsed[side].push(file);
          if (side === "before") beforeFile = file;
        } else
          failures.push({ path, kind: "parse_failed", missing: `${side} AST` });
      }
    }
  for (const unit of units) {
    if (
      !/\.(?:[cm]?[jt]sx?|py)$/.test(unit.file) ||
      unit.before === null ||
      unit.after === null
    )
      continue;
    const limit = (
      kind: CallerLimit["kind"],
      paths: string[],
      missing: string,
    ) =>
      result.limits.push({
        unitId: unit.id,
        kind,
        paths,
        missing,
        reason: `${kind}: ${missing}`,
      });
    if (!parser?.supports(unit.file)) {
      limit("parser_absent", [unit.file], "member-access AST");
      continue;
    }
    const targetFile = parsed.before.find(
      (f) =>
        f.path ===
        (sources.find((s) => s.path === unit.file)?.beforePath ?? unit.file),
    );
    const afterTargetFile = parsed.after.find((f) => f.path === unit.file);
    const name = unit.name.split(".").at(-1);
    const syntaxCandidates = (
      file: Parsed | undefined,
      range: EvidenceUnit["beforeRange"],
    ) =>
      (unit.kind === "hunk"
        ? file?.syntax
        : file?.syntaxByName.get(name ?? "")
      )?.filter(
        (entry) =>
          !range || (entry.start <= range.end && entry.end >= range.start),
      ) ?? [];
    const beforeCandidates = syntaxCandidates(targetFile, unit.beforeRange);
    const afterCandidates = syntaxCandidates(afterTargetFile, unit.afterRange);
    const intervalInvalid = (
      file: Parsed | undefined,
      range: EvidenceUnit["beforeRange"],
    ) =>
      !!range &&
      !!file?.errors.some(
        (error) => error.start <= range.end && error.end >= range.start,
      );
    if (
      [...beforeCandidates, ...afterCandidates].some(
        (entry) => entry.invalid,
      ) ||
      intervalInvalid(targetFile, unit.beforeRange) ||
      intervalInvalid(afterTargetFile, unit.afterRange)
    ) {
      limit("parse_partial", [unit.file], "enclosing changed declaration AST");
      continue;
    }
    const locate = (entries: Parsed["syntax"]) =>
      (
        entries.find((entry) => entry.callable) ??
        entries.find(
          (entry) =>
            !["class_declaration", "class_definition"].includes(
              String(entry.node.kind()),
            ),
        )
      )?.node;
    const target = unit.kind === "hunk" ? undefined : locate(beforeCandidates);
    const afterTarget =
      unit.kind === "hunk" ? undefined : locate(afterCandidates);
    const oldRoot =
      target ??
      (unit.kind === "hunk" ? targetFile?.root : undefined) ??
      parser.parse(unit.file, unit.before);
    const newRoot =
      afterTarget ??
      (unit.kind === "hunk" ? afterTargetFile?.root : undefined) ??
      parser.parse(unit.file, unit.after);
    if (!oldRoot || !newRoot) {
      limit("parse_failed", [unit.file], "complete changed declaration AST");
      continue;
    }
    const inRange = (node: SgNode, range: EvidenceUnit["beforeRange"]) => {
      const span = node.range();
      return (
        !range ||
        (span.start.line + 1 <= range.end &&
          span.end.line + (span.end.column === 0 ? 0 : 1) >= range.start)
      );
    };
    const errors = [
      ...oldRoot
        .findAll({ rule: { kind: "ERROR" } })
        .filter(
          (node) =>
            target ||
            oldRoot !== targetFile?.root ||
            inRange(node, unit.beforeRange),
        ),
      ...newRoot
        .findAll({ rule: { kind: "ERROR" } })
        .filter(
          (node) =>
            afterTarget ||
            newRoot !== afterTargetFile?.root ||
            inRange(node, unit.afterRange),
        ),
    ];
    if (errors.length) {
      limit(
        "parse_partial",
        [unit.file],
        `changed source interval (${errors.length} errors)`,
      );
      continue;
    }
    const intervalMembers = (
      root: SgNode,
      file: Parsed | undefined,
      range: EvidenceUnit["beforeRange"],
    ) =>
      nodes(root, file)
        .filter(
          (node) =>
            ["member_expression", "attribute"].includes(String(node.kind())) &&
            (!file || unit.kind !== "hunk" || inRange(node, range)),
        )
        .flatMap((node) => members(node, file).slice(0, 1));
    const beforeMembers = intervalMembers(
      oldRoot,
      target || oldRoot === targetFile?.root ? targetFile : undefined,
      unit.beforeRange,
    );
    const afterMembers = intervalMembers(
      newRoot,
      afterTarget || newRoot === afterTargetFile?.root
        ? afterTargetFile
        : undefined,
      unit.afterRange,
    );
    const replaced = beforeMembers.filter(
      (old) =>
        !afterMembers.some(
          (next) =>
            next.receiver === old.receiver && next.member === old.member,
        ) &&
        afterMembers.some(
          (next) =>
            next.receiver === old.receiver &&
            next.member !== old.member &&
            !beforeMembers.some(
              (previous) =>
                previous.receiver === next.receiver &&
                previous.member === next.member,
            ),
        ),
    );
    if (!replaced.length) continue;
    for (const failure of failures)
      limit(failure.kind, [failure.path], failure.missing);
    if (["slice", "hunk"].includes(unit.kind)) {
      limit("piece_cut", [unit.file], "complete changed declaration");
      continue;
    }
    const combinations: {
      caller: { before: Json; after: Json; bindings: Json };
      provider: { before: Json; after: Json };
    }[] = [];
    const spans: EvidenceSpan[] = [];
    let extra = 0;
    // The declaration identity is resolved in the complete repository source above.
    if (!targetFile || !target) {
      limit("binding_unknown", [unit.file], "target declaration");
      continue;
    }
    const receiverIndices = replaced.map((m) =>
      parameters(target).indexOf(m.receiver),
    );
    // A receiver can be passed by a caller or concretely bound inside the changed declaration.
    let candidates = 0;
    const targetNames = new Set([functionName(target), "default"]);
    for (const name of targetNames)
      for (const side of [parsed.before, parsed.after])
        for (const file of side)
          for (const alias of file.aliases.get(name) ?? [])
            targetNames.add(alias);
    for (const file of parsed.before)
      for (const reference of file.identifiers) {
        if (!targetNames.has(reference.text())) continue;
        const parent = reference.parent();
        if (
          !parent ||
          !["arguments", "argument_list"].includes(String(parent.kind()))
        )
          continue;
        const bound = resolveExpression(file, reference, parsed.before);
        if (
          bound?.file.path === targetFile.path &&
          bound.node.id() === target.id()
        )
          limit(
            "binding_unknown",
            [file.path],
            `callback ${reference.text()} at line ${reference.range().start.line + 1}: concrete callback arguments`,
          );
      }
    for (const file of parsed.before)
      for (const call of file.calls) {
        const fn = call.field("function");
        if (!fn) continue;
        if (
          !targetNames.has(
            (fn.field("property") ?? fn.field("attribute") ?? fn).text(),
          )
        )
          continue;
        const binding = resolveExpression(file, fn, parsed.before);
        if (
          !binding ||
          binding.file.path !== targetFile.path ||
          binding.node.id() !== target.id()
        ) {
          if (fn.text() === functionName(target) && !binding)
            limit(
              "binding_unknown",
              [file.path],
              `candidate ${fn.text()} at line ${call.range().start.line + 1}`,
            );
          continue;
        }
        candidates++;
        if (file.dynamic) {
          limit(
            "dynamic_import",
            [file.path],
            "candidate caller dynamic import target",
          );
          continue;
        }
        if (file.meta) {
          limit(
            "metaprogramming",
            [file.path],
            "candidate caller computed definitions",
          );
          continue;
        }
        const caller =
          call.ancestors().find((n) => callableKinds[String(n.kind())]) ??
          call
            .ancestors()
            .find((n) =>
              ["lexical_declaration", "expression_statement"].includes(
                String(n.kind()),
              ),
            ) ??
          call;
        const callerPiece = piece(file, caller);
        const afterPath =
          sources.find((s) => (s.beforePath ?? s.path) === file.path)?.path ??
          file.path;
        const afterFile = parsed.after.find((f) => f.path === afterPath);
        const callerName = functionName(caller);
        const afterCaller = afterFile?.all.find((n) =>
          callerName
            ? callableKinds[String(n.kind())] && functionName(n) === callerName
            : n.kind() === caller.kind() &&
              n.range().start.line === caller.range().start.line,
        );
        if (!afterFile || !afterCaller) {
          limit(
            "caller_missing",
            [file.path, afterPath],
            "complete after caller",
          );
          continue;
        }
        if (afterFile.dynamic) {
          limit(
            "dynamic_import",
            [afterPath],
            "after candidate caller dynamic import target",
          );
          continue;
        }
        if (afterFile.meta) {
          limit(
            "metaprogramming",
            [afterPath],
            "after candidate caller computed definitions",
          );
          continue;
        }
        const afterTargetPath = unit.file;
        const callsAfter = nodes(afterCaller, afterFile).filter((n) => {
          if (!["call", "call_expression"].includes(String(n.kind())))
            return false;
          const called = n.field("function");
          if (!called) return false;
          if (
            !targetNames.has(
              (
                called.field("property") ??
                called.field("attribute") ??
                called
              ).text(),
            )
          )
            return false;
          const bound = resolveExpression(afterFile, called, parsed.after);
          return (
            bound?.file.path === afterTargetPath &&
            functionName(bound.node) === unit.name.split(".").at(-1)
          );
        });
        const callAfter = callsAfter.length === 1 ? callsAfter[0] : undefined;
        if (!callAfter) {
          limit(
            "binding_unknown",
            [afterPath],
            "unique coordinated after call",
          );
          continue;
        }
        const args =
          call
            .field("arguments")
            ?.children()
            .filter((n) => !["(", ")", ","].includes(n.text())) ?? [];
        const argsAfter =
          callAfter
            .field("arguments")
            ?.children()
            .filter((n) => !["(", ")", ","].includes(n.text())) ?? [];
        const providersBefore: Piece[] = [];
        const providersAfter: Piece[] = [];
        let valid = true;
        for (let position = 0; position < receiverIndices.length; position++) {
          const index = receiverIndices[position] ?? -1;
          const receiver = replaced[position]?.receiver ?? "";
          const localOldNode =
            index < 0
              ? nodes(target, targetFile).find(
                  (n) =>
                    ["variable_declarator", "assignment"].includes(
                      String(n.kind()),
                    ) &&
                    (n.field("name") ?? n.field("left"))?.text() === receiver,
                )
              : undefined;
          const localNewNode =
            index < 0 && afterTarget
              ? nodes(afterTarget, afterTargetFile).find(
                  (n) =>
                    ["variable_declarator", "assignment"].includes(
                      String(n.kind()),
                    ) &&
                    (n.field("name") ?? n.field("left"))?.text() === receiver,
                )
              : undefined;
          const oldArg =
            index < 0
              ? (localOldNode?.field("value") ?? localOldNode?.field("right"))
              : args[index];
          const newArg =
            index < 0
              ? (localNewNode?.field("value") ?? localNewNode?.field("right"))
              : argsAfter[index];
          const oldProvider =
            oldArg &&
            provider(index < 0 ? targetFile : file, oldArg, parsed.before);
          const newProvider =
            newArg &&
            provider(
              index < 0 ? (afterTargetFile ?? afterFile) : afterFile,
              newArg,
              parsed.after,
            );
          if (!oldProvider || !newProvider) {
            limit(
              "provider_missing",
              [file.path, afterPath],
              `concrete before/after provider for ${index < 0 ? receiver : `argument ${index + 1}`}`,
            );
            valid = false;
            break;
          }
          for (const supplied of [oldProvider, newProvider]) {
            if (supplied.file.dynamic) {
              limit(
                "dynamic_import",
                [supplied.file.path],
                "bound provider dynamic import target",
              );
              valid = false;
            }
            if (supplied.file.meta) {
              limit(
                "metaprogramming",
                [supplied.file.path],
                "bound provider computed definitions",
              );
              valid = false;
            }
          }
          if (!valid) break;
          providersBefore.push(
            piece(oldProvider.file, index < 0 ? target : oldProvider.node),
          );
          providersAfter.push(
            piece(
              newProvider.file,
              index < 0 ? (afterTarget ?? newProvider.node) : newProvider.node,
            ),
          );
        }
        if (!valid) continue;
        const bindingPieces = (
          source: Parsed,
          declaration: SgNode,
        ): Piece[] => {
          const collected: Piece[] = source.imports.map((n) =>
            piece(source, n),
          );
          for (const reference of nodes(declaration, source).filter(
            (n) => n.kind() === "identifier",
          )) {
            const located = resolveIdentifier(
              source,
              reference.text(),
              reference,
              source === file ? parsed.before : parsed.after,
            );
            if (
              !located ||
              located.node.id() === target.id() ||
              callableKinds[String(located.node.kind())]
            )
              continue;
            const value = piece(located.file, located.node);
            if (
              !collected.some(
                (p) =>
                  p.path === value.path &&
                  p.start === value.start &&
                  p.end === value.end,
              )
            )
              collected.push(value);
          }
          return collected;
        };
        const contextBefore = bindingPieces(file, caller);
        const contextAfter = bindingPieces(afterFile, afterCaller);
        const pieces = [
          callerPiece,
          piece(afterFile, afterCaller),
          ...providersBefore,
          ...providersAfter,
          ...contextBefore,
          ...contextAfter,
        ];
        const oversized = pieces.find(
          (p) => p.text.length > (budgets.piece ?? UNIT_MAX_CHARS),
        );
        if (oversized) {
          limit(
            "piece_cut",
            [oversized.path],
            `${oversized.start}-${oversized.end} complete piece`,
          );
          continue;
        }
        const size = pieces.reduce((sum, p) => sum + p.text.length, 0);
        if (extra + size > (budgets.closure ?? CLOSURE_MAX_CHARS)) {
          limit(
            "budget",
            pieces.map((p) => p.path),
            "caller/provider closure budget",
          );
          continue;
        }
        extra += size;
        spans.push(
          ...pieces.map(({ path, start, end }) => ({ path, start, end })),
        );
        combinations.push({
          caller: {
            before: { ...callerPiece },
            after: { ...piece(afterFile, afterCaller) },
            bindings: {
              before: contextBefore.map((p) => ({ ...p })),
              after: contextAfter.map((p) => ({ ...p })),
            },
          },
          provider: {
            before: providersBefore.map((p) => ({ ...p })),
            after: providersAfter.map((p) => ({ ...p })),
          },
        });
      }
    if (!candidates)
      limit("caller_missing", [unit.file], "statically bound local caller");
    if (!combinations.length) continue;
    const state: State = {
      changedUnits: [{ ...unit }],
      callerEvidence: {
        source: "static code only; not executed",
        caller: {
          before: combinations.map((value) => value.caller.before),
          after: combinations.map((value) => value.caller.after),
          bindings: combinations.map((value) => value.caller.bindings),
        },
        provider: {
          before: combinations.map((value) => value.provider.before),
          after: combinations.map((value) => value.provider.after),
        },
      },
    };
    if (JSON.stringify(state).length > (budgets.state ?? STATE_MAX_CHARS)) {
      limit(
        "budget",
        spans.map((p) => p.path),
        "serialized caller evidence state",
      );
      continue;
    }
    result.proofs.push({ unitId: unit.id, state, question, paths: spans });
  }
  result.limits = result.limits.filter(
    (value, index, all) =>
      all.findIndex(
        (other) =>
          other.unitId === value.unitId &&
          other.kind === value.kind &&
          other.missing === value.missing &&
          other.paths.join("\0") === value.paths.join("\0"),
      ) === index,
  );
  return result;
}
