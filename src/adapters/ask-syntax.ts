import type { SgNode } from "@ast-grep/napi";
import type {
  ProofBinding,
  ProofDeclaration,
  ProofSyntax,
} from "../core/ask-proof.ts";
import type { ImportSource } from "../core/imports.ts";
import type { Limitation } from "../core/output.ts";
import type { SyntaxRootParser } from "../core/syntax.ts";
import { loadSyntaxRootParser } from "./syntax.ts";

function nodes(root: SgNode, kinds: readonly string[]): SgNode[] {
  const result: SgNode[] = [];
  for (const kind of kinds) {
    try {
      result.push(...root.findAll({ rule: { kind } }));
    } catch {
      /* Node kinds differ across the supported language grammars. */
    }
  }
  return result
    .map((node) => ({ node, index: node.range().start.index }))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.node);
}
function names(root: SgNode, includeTypes = true): string[] {
  const result = new Set<string>();
  const excluded = nodes(root, [
    "import_statement",
    "import_from_statement",
    "export_clause",
  ]).map((node) => node.range());
  const typeScopes: { name: string; start: number; end: number }[] = [];
  if (includeTypes) {
    for (const binder of nodes(root, [
      "type_parameter",
      "infer_type",
      "mapped_type_clause",
    ])) {
      const name =
        binder.field("name") ??
        binder.children().find((node) => node.kind() === "type_identifier");
      let scope = binder.parent();
      if (binder.kind() === "type_parameter") scope = scope?.parent() ?? null;
      if (binder.kind() === "infer_type") {
        while (scope && scope.kind() !== "conditional_type")
          scope = scope.parent();
        const own = name?.range();
        if (name && own)
          typeScopes.push({
            name: name.text(),
            start: own.start.index,
            end: own.end.index,
          });
        scope = scope?.field("consequence") ?? null;
      }
      if (name && scope) {
        const range = scope.range();
        typeScopes.push({
          name: name.text(),
          start: range.start.index,
          end: range.end.index,
        });
      }
    }
  }
  for (const node of nodes(root, [
    "identifier",
    "type_identifier",
    "nested_type_identifier",
    "member_expression",
    "attribute",
  ])) {
    const position = node.range().start.index;
    if (node.kind() === "type_identifier") {
      if (
        !includeTypes ||
        node.parent()?.kind() === "nested_type_identifier" ||
        typeScopes.some(
          (scope) =>
            scope.name === node.text() &&
            position >= scope.start &&
            position < scope.end,
        )
      )
        continue;
    }
    if (!includeTypes && node.kind() === "nested_type_identifier") continue;
    if (
      excluded.some(
        (range) => position >= range.start.index && position < range.end.index,
      )
    )
      continue;
    if (node.kind() === "identifier" || node.kind() === "type_identifier")
      result.add(node.text());
    else {
      const owner = node.field("object") ?? node.field("module");
      const property =
        node.field("property") ?? node.field("attribute") ?? node.field("name");
      if (owner && property) result.add(`${owner.text()}.${property.text()}`);
    }
  }
  return [...result];
}
function literal(node: SgNode | null | undefined): string | undefined {
  if (!node || !["string", "string_literal"].includes(String(node.kind())))
    return undefined;
  const fragments = nodes(node, ["string_fragment", "string_content"]);
  if (nodes(node, ["interpolation", "escape_sequence"]).length)
    return undefined;
  return fragments.map((fragment) => fragment.text()).join("");
}

/** Collect AST metadata only; repository resolution remains in the shared I8 graph. */
export async function collectProofSyntax(
  files: readonly ImportSource[],
  before?: Readonly<Record<string, string | null>>,
  sourceParser?: SyntaxRootParser,
): Promise<ProofSyntax> {
  const declarations: ProofDeclaration[] = [];
  const bindings: ProofBinding[] = [];
  const limits: Limitation[] = [];
  const uses = new Map<string, readonly string[]>();
  const parser = sourceParser ?? (await loadSyntaxRootParser());
  for (const file of files) {
    if (!parser?.supports(file.path)) {
      limits.push({
        fact: `${file.path} : unsupported language${/\.[cm]?[jt]sx?$|\.py$/.test(file.path) ? ", optional parser unavailable" : ""}`,
        next: "Install the language parser or provide the required declarations.",
      });
      continue;
    }
    const python = file.path.endsWith(".py");
    const parsed = parser.parseRaw(file.path, file.text);
    if (!parsed.ok) {
      limits.push({
        fact: `${file.path}: parse_failed`,
        next: "read the complete source and check its syntax",
      });
      continue;
    }
    const root = parsed.root;
    const cachedParser = Object.create(parser) as SyntaxRootParser;
    cachedParser.parseRaw = () => parsed;
    const syntax = cachedParser.declarations(file.path, file.text, {
      descendAbove: Infinity,
    });
    for (const limit of syntax.limits) {
      if (limit.kind === "parse_partial" && limit.declaration) continue;
      limits.push({
        fact: `${file.path} : ${limit.kind}`,
        next: "check the complete supplied source",
      });
    }
    if (syntax.limits.some((limit) => limit.kind === "parse_failed")) continue;
    const usedNames = names(root);
    const valueNames = names(root, false);
    uses.set(file.path, usedNames);
    const collectDeclarations = (tree: SgNode) => {
      const result: { name: string; text: string; node: SgNode }[] = [];
      for (const outer of tree.children()) {
        const envelope = outer;
        const node = ["export_statement", "decorated_definition"].includes(
          String(outer.kind()),
        )
          ? (outer
              .children()
              .find((child) =>
                [
                  "function_declaration",
                  "generator_function_declaration",
                  "class_declaration",
                  "lexical_declaration",
                  "variable_declaration",
                  "function_definition",
                  "class_definition",
                  "type_alias_declaration",
                  "interface_declaration",
                  "enum_declaration",
                ].includes(String(child.kind())),
              ) ?? outer)
          : outer;
        if (
          [
            "function_declaration",
            "generator_function_declaration",
            "class_declaration",
            "function_definition",
            "class_definition",
            "type_alias_declaration",
            "interface_declaration",
            "enum_declaration",
          ].includes(String(node.kind()))
        ) {
          const name = node.field("name")?.text();
          if (name)
            result.push({ name, text: envelope.text(), node: envelope });
        } else if (
          ["lexical_declaration", "variable_declaration"].includes(
            String(node.kind()),
          )
        ) {
          for (const variable of node
            .children()
            .filter((child) => child.kind() === "variable_declarator")) {
            const name = variable.field("name")?.text();
            if (name)
              result.push({ name, text: envelope.text(), node: envelope });
          }
        } else if (python && node.kind() === "expression_statement") {
          const assignment = node
            .children()
            .find((child) => child.kind() === "assignment");
          const name = assignment?.field("left")?.text();
          if (name)
            result.push({ name, text: envelope.text(), node: envelope });
        }
      }
      for (const declaration of result) {
        if (!declaration.node.find({ rule: { kind: "ERROR" } })) continue;
        const fact = `${file.path} : parse_partial (${declaration.name})`;
        if (!limits.some((limit) => limit.fact === fact))
          limits.push({
            fact,
            next: "check the complete supplied source declaration",
          });
      }
      return result;
    };
    const old =
      before && Object.hasOwn(before, file.path)
        ? before[file.path]
        : undefined;
    const oldRoot =
      typeof old === "string" ? parser.parseRaw(file.path, old) : undefined;
    const oldDeclarations = oldRoot?.ok
      ? collectDeclarations(oldRoot.root)
      : [];
    const currentDeclarations = collectDeclarations(root);
    for (const declaration of currentDeclarations) {
      const tree = declaration.node;
      const decorators = nodes(tree, ["decorator"]);
      declarations.push({
        path: file.path,
        name: declaration.name,
        text: declaration.text,
        ...(old !== undefined
          ? {
              before:
                oldDeclarations.find((item) => item.name === declaration.name)
                  ?.text ?? null,
            }
          : {}),
        usedNames: names(tree),
        fixture:
          python &&
          decorators.some((node) =>
            nodes(node, ["identifier"]).some(
              (item) => item.text() === "fixture",
            ),
          ),
        autouse:
          python &&
          decorators.some((node) =>
            nodes(node, ["keyword_argument"]).some(
              (item) =>
                item.field("name")?.text() === "autouse" &&
                item.field("value")?.text() === "True",
            ),
          ),
      });
    }
    for (const declaration of oldDeclarations) {
      if (!currentDeclarations.some((item) => item.name === declaration.name))
        declarations.push({
          path: file.path,
          name: declaration.name,
          text: "",
          before: declaration.text,
          usedNames: names(declaration.node),
          deleted: true,
        });
    }
    const add = (
      local: string,
      imported: string,
      specifier: string,
      reexport: boolean,
      data = false,
    ) =>
      bindings.push({
        path: file.path,
        local,
        imported,
        specifier,
        reexport,
        used:
          data ||
          usedNames.includes(local) ||
          usedNames.some((name) => name.startsWith(`${local}.`)),
        ...(data ? { data: true } : {}),
        typeOnly:
          !data &&
          !valueNames.some(
            (name) => name === local || name.startsWith(`${local}.`),
          ),
        valueMembers: valueNames.filter((name) => name.startsWith(`${local}.`)),
      });
    for (const node of nodes(root, [
      "import_statement",
      "import_from_statement",
      "export_statement",
    ])) {
      if (python) {
        const children = node.children();
        const module =
          node.kind() === "import_from_statement"
            ? children.find((child) =>
                ["relative_import", "dotted_name"].includes(
                  String(child.kind()),
                ),
              )
            : undefined;
        for (const child of children) {
          if (child === module) continue;
          if (child.kind() === "aliased_import") {
            const original =
              child.field("name")?.text() ??
              child
                .children()
                .find((item) => item.kind() === "dotted_name")
                ?.text();
            const alias =
              child.field("alias")?.text() ??
              child
                .children()
                .filter((item) => item.kind() === "identifier")
                .at(-1)
                ?.text();
            if (original)
              add(
                alias ?? original,
                module ? original : "*",
                module?.text() ?? original,
                file.path.endsWith("__init__.py"),
              );
          } else if (child.kind() === "dotted_name")
            add(
              child.text().split(".")[0] ?? child.text(),
              module ? child.text() : "*",
              module?.text() ?? child.text(),
              file.path.endsWith("__init__.py"),
            );
          else if (child.kind() === "wildcard_import" && module)
            add("*", "*", module.text(), file.path.endsWith("__init__.py"));
        }
      } else {
        const specifier = literal(
          node.field("source") ??
            node.children().find((child) => child.kind() === "string"),
        );
        const reexport = node.kind() === "export_statement";
        const specs = nodes(node, ["import_specifier", "export_specifier"]);
        if (specifier) {
          for (const spec of specs) {
            const ids = spec
              .children()
              .filter((child) => child.kind() === "identifier");
            const imported = spec.field("name")?.text() ?? ids[0]?.text();
            const alias = spec.field("alias")?.text() ?? ids.at(-1)?.text();
            if (imported) add(alias ?? imported, imported, specifier, reexport);
          }
          const clause = node
            .children()
            .find((child) => child.kind() === "import_clause");
          const defaultName = clause
            ?.children()
            .find((child) => child.kind() === "identifier");
          if (defaultName) add(defaultName.text(), "default", specifier, false);
          const namespace = nodes(node, [
            "namespace_import",
            "namespace_export",
          ])[0];
          if (namespace)
            add(
              namespace
                .children()
                .find((child) => child.kind() === "identifier")
                ?.text() ?? "*",
              "*",
              specifier,
              reexport,
            );
          else if (
            reexport &&
            !specs.length &&
            node.children().some((child) => child.text() === "*")
          )
            add("*", "*", specifier, true);
        } else if (reexport) {
          if (node.children().some((child) => child.kind() === "default")) {
            const declaration = node
              .children()
              .find((child) => child.field("name") !== null);
            const name = declaration?.field("name")?.text();
            if (name) add("default", name, "", true);
          }
          for (const spec of specs) {
            const ids = spec
              .children()
              .filter((child) => child.kind() === "identifier");
            if (ids[0])
              add(ids.at(-1)?.text() ?? ids[0].text(), ids[0].text(), "", true);
          }
        }
      }
    }
    const readAliases = bindings
      .filter(
        (binding) =>
          binding.path === file.path && binding.imported === "readFileSync",
      )
      .map((binding) => binding.local);
    for (const call of nodes(root, python ? ["call"] : ["call_expression"])) {
      const fn = call.field("function");
      const fnName = fn?.text() ?? "";
      if (
        fnName === "readFileSync" ||
        fnName.endsWith(".readFileSync") ||
        readAliases.includes(fnName)
      ) {
        const argument = (
          call.field("arguments") ??
          call.children().find((child) => child.kind() === "arguments")
        )
          ?.children()
          .find((child) => child.kind() === "string");
        const specifier = literal(argument);
        if (specifier !== undefined)
          add(specifier, "*", specifier, false, true);
        else
          limits.push({
            fact: `${file.path} : unresolved dynamic readFileSync call`,
            next: "Provide the data file explicitly.",
          });
      }
      if (["import", "__import__", "importlib.import_module"].includes(fnName))
        limits.push({
          fact: `${file.path} : unresolved dynamic import ${call.text()}`,
          next: "Provide the dependency explicitly.",
        });
    }
  }
  return {
    declarations,
    bindings,
    limits,
    sources: files,
    uses,
    ...(before ? { before } : {}),
  };
}
