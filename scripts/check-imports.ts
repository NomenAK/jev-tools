import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  type ArchitectureImport,
  checkImportBoundaries,
  type ImportViolation,
} from "../src/core/import-boundaries.ts";

const root = resolve(process.argv[2] ?? ".");
const sourceRoot = join(root, "src");
async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const lists = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? sources(path)
        : Promise.resolve(/\.[cm]?tsx?$/.test(entry.name) ? [path] : []);
    }),
  );
  return lists.flat().sort();
}

try {
  const paths = await sources(sourceRoot);
  const known = new Set(paths);
  const imports: ArchitectureImport[] = [];
  const violations: ImportViolation[] = [];
  for (const path of paths) {
    const file = relative(sourceRoot, path).replaceAll("\\", "/");
    const text = await readFile(path, "utf8");
    const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    function add(node: ts.Node, specifier: string, typeOnly: boolean): void {
      let target: string | undefined;
      if (specifier.startsWith(".")) {
        const base = resolve(dirname(path), specifier);
        const candidates = [base, `${base}.ts`, join(base, "index.ts")];
        if (/\.[cm]?js$/.test(base)) candidates.push(base.replace(/js$/, "ts"));
        const found = candidates.find((candidate) => known.has(candidate));
        if (found) target = relative(sourceRoot, found).replaceAll("\\", "/");
      }
      imports.push({
        file,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        specifier,
        target,
        typeOnly,
      });
    }
    function reject(node: ts.Node, rule: string, detail: string): void {
      violations.push({
        file,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        rule,
        detail,
      });
    }
    function visit(node: ts.Node): void {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        // Named `type` specifiers still load the module under verbatimModuleSyntax.
        add(
          node,
          node.moduleSpecifier.text,
          Boolean(node.importClause?.isTypeOnly),
        );
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        add(node, node.moduleSpecifier.text, node.isTypeOnly);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const expression = node.moduleReference.expression;
        if (expression && ts.isStringLiteral(expression))
          add(node, expression.text, node.isTypeOnly);
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        add(node, node.argument.literal.text, true);
      } else if (ts.isCallExpression(node)) {
        const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const requireCall =
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require";
        if (dynamic || requireCall) {
          const argument = node.arguments[0];
          if (
            argument &&
            (ts.isStringLiteral(argument) ||
              ts.isNoSubstitutionTemplateLiteral(argument))
          )
            add(node, argument.text, false);
          else
            reject(
              node,
              "static-import-target",
              "nonliteral module loading cannot be checked",
            );
        }
        if (file.startsWith("core/")) {
          const called = ts.isIdentifier(node.expression)
            ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name.text
              : undefined;
          if (called === "fetch" || called === "getBuiltinModule") {
            reject(node, "pure-io", `${called} is forbidden in core/`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  violations.push(...checkImportBoundaries(imports));
  for (const violation of violations) {
    console.error(
      `src/${violation.file}:${violation.line} [${violation.rule}] ${violation.detail}`,
    );
  }
  if (violations.length) process.exitCode = 1;
  else
    console.log(
      `Import boundaries passed (${paths.length} files, ${imports.length} imports; type cycles included).`,
    );
} catch (error) {
  console.error(
    `Import boundary check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
