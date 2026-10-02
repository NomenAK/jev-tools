import type { SgNode } from "@ast-grep/napi";
import type { SyntaxRootParser } from "../core/syntax.ts";
import type {
  Declaration,
  DeclarationResult,
  SyntaxParser,
} from "../core/units.ts";

let parserPromise: Promise<SyntaxRootParser | undefined> | undefined;
/** Optional grammars resolve from this extension, not the repository under review. */
export function loadSyntaxParser(): Promise<SyntaxParser | undefined> {
  parserPromise ??= createParser();
  return parserPromise;
}
/** Raw AST access shares grammar availability and registration with declaration extraction. */
export function loadSyntaxRootParser(): Promise<SyntaxRootParser | undefined> {
  parserPromise ??= createParser();
  return parserPromise;
}
async function createParser(): Promise<SyntaxRootParser | undefined> {
  try {
    const napi = await import("@ast-grep/napi");
    let python = false;
    try {
      const language = await import("@ast-grep/lang-python");
      napi.registerDynamicLanguage({ python: language.default });
      python = true;
    } catch {
      /* buildUnits reports the missing grammar for each affected file. */
    }
    const parser: SyntaxRootParser = {
      supports: (path) =>
        /\.[cm]?[jt]sx?$/.test(path) || (python && path.endsWith(".py")),
      parseRaw(path, text) {
        try {
          const language = path.endsWith(".py")
            ? "python"
            : /\.[cm]?tsx?$/.test(path)
              ? path.endsWith("tsx")
                ? napi.Lang.Tsx
                : napi.Lang.TypeScript
              : path.endsWith(".jsx")
                ? "jsx"
                : napi.Lang.JavaScript;
          const root = napi.parse(language, text).root();
          return { ok: true, root };
        } catch {
          return { ok: false, error: "Source parser unavailable" };
        }
      },
      parse(path, text) {
        const parsed = this.parseRaw(path, text);
        if (!parsed.ok) return parsed;
        return parsed.root.find({ rule: { kind: "ERROR" } })
          ? { ok: false, error: "Source syntax incomplete" }
          : parsed;
      },
      declarations(path, text, options) {
        const isPython = path.endsWith(".py");
        const parsed = this.parseRaw(path, text);
        if (!parsed.ok)
          return { declarations: [], limits: [{ kind: "parse_failed" }] };
        const root = parsed.root;
        const result: Declaration[] = [];
        const limits: DeclarationResult["limits"] = [];
        const errors = root.findAll({ rule: { kind: "ERROR" } });
        const declarationKind =
          /^(?:function_declaration|generator_function_declaration|method_definition|function_definition|lexical_declaration|variable_declaration|type_alias_declaration|interface_declaration|enum_declaration|class_declaration|class_definition)$/;
        if (
          errors.some(
            (error) =>
              !error
                .ancestors()
                .some((node) => declarationKind.test(String(node.kind()))) &&
              (error
                .findAll({ rule: { regex: ".*" } })
                .some((node) => declarationKind.test(String(node.kind()))) ||
                /^(?:export\s+)?(?:function|const|let|var|class)\b/.test(
                  error.text().trim(),
                )),
          )
        )
          return { declarations: [], limits: [{ kind: "parse_failed" }] };
        const attributedErrors = new Set<number>();
        const source = text.split("\n");
        const visit = (node: SgNode) => {
          const kind = String(node.kind());
          // Most AST nodes cannot yield a declaration; avoid constructing their ancestor chains.
          if (
            !/^(?:function_declaration|generator_function_declaration|method_definition|function_definition|lexical_declaration|variable_declaration|type_alias_declaration|interface_declaration|enum_declaration|expression_statement|class_declaration|class_definition)$/.test(
              kind,
            )
          ) {
            for (const child of node.children()) visit(child);
            return;
          }
          const ancestors = node.ancestors();
          const functionNode =
            /^(?:function_declaration|generator_function_declaration|method_definition|function_definition)$/.test(
              kind,
            );
          const variable =
            /^(?:lexical_declaration|variable_declaration|type_alias_declaration|interface_declaration|enum_declaration)$/.test(
              kind,
            ) &&
            ancestors.every(
              (a) => !/function|method|statement_block/.test(String(a.kind())),
            );
          const callableVariable =
            variable &&
            node.find({
              rule: {
                any: [
                  { kind: "arrow_function" },
                  { kind: "function_expression" },
                ],
              },
            }) !== null;
          const assignment =
            isPython &&
            kind === "expression_statement" &&
            node.parent()?.kind() === "module" &&
            node.children().some((child) => child.kind() === "assignment");
          const classNode =
            options?.descendAbove !== undefined &&
            /^(?:class_declaration|class_definition)$/.test(kind);
          if (functionNode || variable || assignment || classNode) {
            let envelope = node;
            if (
              node.parent()?.kind() === "decorated_definition" ||
              node.parent()?.kind() === "export_statement"
            )
              envelope = node.parent() ?? node;
            const named =
              node.field("name") ?? node.find({ rule: { kind: "identifier" } });
            const owner = ancestors
              .filter((a) =>
                /^(?:class_definition|class_declaration|internal_module|module)$/.test(
                  String(a.kind()),
                ),
              )
              .reverse()
              .map((a) => a.field("name")?.text())
              .filter(Boolean);
            let name = [...owner, named?.text() ?? "declaration"].join(".");
            if (assignment)
              name = node.text().split(/\s*[:=]/, 1)[0] ?? "declaration";
            let start = envelope.range().start.line;
            const body =
              node.field("body") ??
              (callableVariable
                ? node
                    .find({
                      rule: {
                        any: [
                          { kind: "arrow_function" },
                          { kind: "function_expression" },
                        ],
                      },
                    })
                    ?.field("body")
                : null);
            const tokens = (part: SgNode): string[] => {
              const children = part.children();
              if (
                !children.length ||
                /string|comment/.test(String(part.kind()))
              )
                return part.kind() === "comment" ? [] : [part.text()];
              return children.flatMap(tokens);
            };
            const accessor =
              kind === "method_definition"
                ? node
                    .children()
                    .find((child) => /^(get|set)$/.test(String(child.kind())))
                    ?.kind()
                : undefined;
            const end = envelope.range().end;
            // Include the immediately preceding comment block without swallowing another declaration.
            while (
              start > 0 &&
              /^\s*(?:\/\/|\/\*|\*|\*\/|#)/.test(source[start - 1] ?? "")
            )
              start--;
            result.push({
              kind:
                functionNode || callableVariable ? "function" : "declaration",
              name,
              type: accessor ? `${kind}:${accessor}` : kind,
              signatureEnd: body
                ? body.range().start.line + (isPython ? 0 : 1)
                : undefined,
              body: body ? JSON.stringify(tokens(body)) : undefined,
              exported: isPython
                ? !name.split(".").some((part) => part.startsWith("_"))
                : ancestors.some((a) => a.kind() === "export_statement") ||
                  envelope.kind() === "export_statement",
              start: start + 1,
              end: end.line + (end.column === 0 ? 0 : 1),
            });
            const declarationErrors = envelope.findAll({
              rule: { kind: "ERROR" },
            });
            if (declarationErrors.length) {
              limits.push({ kind: "parse_partial", declaration: name });
              for (const error of declarationErrors)
                attributedErrors.add(error.id());
            }
            if (
              options?.descendAbove === undefined ||
              end.line + (end.column === 0 ? 0 : 1) - start <=
                options.descendAbove
            )
              return;
          }
          for (const child of node.children()) visit(child);
        };
        visit(root);
        if (errors.some((error) => !attributedErrors.has(error.id())))
          limits.push({ kind: "parse_partial" });
        return { declarations: result, limits };
      },
    };
    return parser;
  } catch {
    return undefined;
  }
}
