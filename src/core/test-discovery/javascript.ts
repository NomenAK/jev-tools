import type { LexicalToken as Token } from "../lexical.ts";
import { closing, literal, record } from "./shared.ts";
import type { Framework, TestScenario } from "./types.ts";

const moduleFramework: Record<string, Framework> = {
  vitest: "vitest",
  "@jest/globals": "jest",
  "node:test": "node",
  "bun:test": "bun",
  "@playwright/test": "playwright",
  ava: "ava",
  mocha: "mocha",
};
export interface Imports {
  frameworks: Set<Framework>;
  tests: Set<string>;
  suites: Set<string>;
}
export function imports(tokens: readonly Token[]): Imports {
  const result: Imports = {
    frameworks: new Set(),
    tests: new Set(),
    suites: new Set(),
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (
      !t.string &&
      t.value === "import" &&
      tokens[i + 1]?.value !== "(" &&
      tokens[i + 1]?.value !== "."
    ) {
      let end = i + 1;
      while (
        end < tokens.length &&
        !tokens[end]?.string &&
        tokens[end]?.value !== ";"
      )
        end++;
      const source = tokens[end];
      const framework = source?.string
        ? moduleFramework[source.value]
        : undefined;
      if (!framework) continue;
      result.frameworks.add(framework);
      for (let j = i + 1; j < end; j++) {
        const name = tokens[j]?.value ?? "";
        const local =
          tokens[j + 1]?.value === "as" ? tokens[j + 2]?.value : name;
        if (["test", "it", "default"].includes(name) && local)
          result.tests.add(local);
        if (["describe", "suite"].includes(name) && local)
          result.suites.add(local);
      }
      if (tokens[i + 1]?.value !== "{")
        result.tests.add(tokens[i + 1]?.value ?? "test");
    }
    if (
      t.value === "require" &&
      tokens[i + 1]?.value === "(" &&
      tokens[i + 2]?.string &&
      tokens[i + 3]?.value === ")"
    ) {
      const framework = moduleFramework[tokens[i + 2]?.value ?? ""];
      if (framework) {
        result.frameworks.add(framework);
        result.tests.add("test");
        result.tests.add("it");
        result.suites.add("describe");
      }
    }
    if (
      t.value === "Deno" &&
      tokens[i + 1]?.value === "." &&
      tokens[i + 2]?.value === "test"
    )
      result.frameworks.add("deno");
  }
  return result;
}
export function jsScenarios(
  tokens: readonly Token[],
  framework: Framework,
  bindings: Imports,
): { scenarios: TestScenario[]; countKnown: boolean } {
  const tests = new Set([...bindings.tests, "test", "it"]);
  const suites = new Set([...bindings.suites, "describe", "suite"]);
  if (framework === "mocha") {
    for (const name of ["specify", "xit", "xspecify"]) tests.add(name);
    for (const name of ["context", "xcontext", "xdescribe"]) suites.add(name);
  }
  const result: TestScenario[] = [];
  const scopes: { end: number; name: string; reliable: boolean }[] = [];
  let countKnown = true;
  for (let i = 0; i < tokens.length; i++) {
    while (scopes.length && (scopes[scopes.length - 1]?.end ?? Infinity) < i)
      scopes.pop();
    const t = tokens[i];
    if (!t) continue;
    if (t.string || (!tests.has(t.value) && !suites.has(t.value))) continue;
    if (
      tokens[i - 1]?.value === "." &&
      !["t", "ctx", "context", "Deno"].includes(tokens[i - 2]?.value ?? "")
    )
      continue;
    let suite = suites.has(t.value);
    let j = i + 1;
    let parameterized = false;
    let knownModifiers = true;
    let pendingModifier = false;
    while (tokens[j]?.value === ".") {
      const modifier = tokens[j + 1]?.value ?? "";
      pendingModifier ||= modifier === "todo" || modifier === "skip";
      if (["describe", "suite"].includes(modifier)) suite = true;
      if (["each", "for"].includes(modifier)) parameterized = true;
      knownModifiers &&= [
        "describe",
        "suite",
        "each",
        "for",
        "skipIf",
        "runIf",
        "if",
        "only",
        "skip",
        "todo",
        "concurrent",
        "sequential",
        "fails",
        "serial",
        "failing",
        "cb",
        "before",
        "after",
        "beforeEach",
        "afterEach",
        "always",
      ].includes(modifier);
      j += 2;
      if (
        ["each", "for", "skipIf", "runIf", "if"].includes(modifier) &&
        tokens[j]?.value === "("
      ) {
        j = closing(tokens, j) + 1;
      }
    }
    if (tokens[j]?.value !== "(") continue;
    const end = closing(tokens, j);
    const args: { start: number; end: number }[] = [];
    let start = j + 1;
    for (let k = start; k < end; k++) {
      const token = tokens[k];
      if (token?.string) continue;
      if (["(", "[", "{"].includes(token?.value ?? "")) {
        k = closing(tokens, k);
      } else if (token?.value === ",") {
        args.push({ start, end: k });
        start = k + 1;
      }
    }
    if (start < end) args.push({ start, end });
    const title = tokens[j + 1];
    const callback = args.find((arg) => {
      const head = tokens[arg.start]?.value;
      if (
        head === "function" ||
        (head === "async" && tokens[arg.start + 1]?.value === "function")
      )
        return true;
      for (let k = arg.start; k < arg.end; k++) {
        const token = tokens[k];
        if (token?.string) continue;
        if (["(", "[", "{"].includes(token?.value ?? ""))
          k = closing(tokens, k);
        else if (token?.value === "=" && tokens[k + 1]?.value === ">")
          return true;
      }
      return false;
    });
    const optionsArg = title?.string ? args[1] : args[0];
    const nodeOptions =
      framework === "node" && tokens[optionsArg?.start ?? end]?.value === "{"
        ? record(literal(tokens, optionsArg?.start ?? end).value)
        : {};
    const callbackFreeNode =
      framework === "node" &&
      !suite &&
      !callback &&
      (args.length === 1 ||
        (args.length === 2 && tokens[args[1]?.start ?? end]?.value === "{"));
    if (
      callbackFreeNode &&
      (pendingModifier || nodeOptions.todo || nodeOptions.skip)
    )
      continue;
    // Unlike JS runners, Node executes bare literal declarations as passing tests.
    if (
      !callbackFreeNode &&
      !callback &&
      title?.string &&
      (args.length <= 1 ||
        (args.length === 2 && tokens[args[1]?.start ?? end]?.value === "{"))
    )
      continue;
    if (!args.length) {
      countKnown = false;
      continue;
    }
    const functionStart =
      callback && tokens[callback.start]?.value === "async"
        ? callback.start + 1
        : callback?.start;
    const namedFunction =
      framework === "node" &&
      callback?.start === j + 1 &&
      functionStart !== undefined &&
      tokens[functionStart]?.value === "function"
        ? tokens[
            functionStart + (tokens[functionStart + 1]?.value === "*" ? 2 : 1)
          ]
        : undefined;
    const objectTitle =
      framework === "node" && title?.value === "{"
        ? record(literal(tokens, j + 1).value).name
        : undefined;
    const staticName =
      title?.string && args[0]?.end === j + 2
        ? title.value
        : typeof objectTitle === "string"
          ? objectTitle
          : namedFunction && /^[a-zA-Z_$][\w$]*$/.test(namedFunction.value)
            ? namedFunction.value
            : undefined;
    const reliable =
      staticName !== undefined &&
      (!!callback || callbackFreeNode) &&
      knownModifiers &&
      !parameterized &&
      scopes.every((s) => s.reliable);
    const name = staticName ?? `<dynamic:${t.line}>`;
    if (!reliable) countKnown = false;
    const ancestors = scopes.map((s) => s.name);
    if (suite) scopes.push({ end, name, reliable });
    else {
      const nativeName = [...ancestors, name].join(
        framework === "playwright" ? " › " : " ",
      );
      const nativeAncestors =
        framework === "node"
          ? ancestors.map((_, index) => ancestors.slice(0, index + 1).join(" "))
          : ancestors;
      result.push({
        id: `s${result.length + 1}`,
        name: nativeName,
        nameParts: [...ancestors, name],
        line: t.line,
        reliable,
        ...(tokens[end]
          ? { range: { start: t.line, end: tokens[end]?.line ?? t.line } }
          : {}),
        ...(ancestors.length || framework === "node"
          ? { ancestors: nativeAncestors }
          : {}),
      });
      if (framework === "node") scopes.push({ end, name, reliable });
    }
  }
  const names = new Set<string>();
  for (const scenario of result) {
    if (names.has(scenario.name)) {
      countKnown = false;
      for (const same of result)
        if (same.name === scenario.name) same.reliable = false;
    }
    names.add(scenario.name);
  }
  return { scenarios: result, countKnown };
}
