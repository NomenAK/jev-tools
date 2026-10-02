import { posix } from "node:path";
import { isTestFile } from "./diff.ts";
import {
  type LexicalSource,
  type LexicalToken as Token,
  tokenize,
} from "./lexical.ts";

export type Framework =
  | "vitest"
  | "jest"
  | "node"
  | "bun"
  | "playwright"
  | "go"
  | "pytest"
  | "ava"
  | "mocha"
  | "deno"
  | "unknown";
export interface TestScenario {
  id: string;
  name: string;
  line: number;
  reliable: boolean;
  nameParts?: readonly string[];
  ancestors?: readonly string[];
  range?: { start: number; end: number };
}
export interface TestEntry {
  path: string;
  framework: Framework;
  runnerVersion?: string;
  cwd: string;
  config?: string;
  project?: string;
  options: readonly string[];
  commandRefusal?: string;
  nameFilterBlocked?: boolean;
  nameFilterReason?: string;
  invocation?: {
    executable: string;
    args: readonly string[];
    kind: "runner" | "typecheck";
  };
  scenarios: readonly TestScenario[];
  countKnown: boolean;
  kind: "runtime" | "types";
  provenance: string;
}
export interface Discovery {
  entries: readonly TestEntry[];
  evidence: readonly string[];
  limits: readonly {
    path: string;
    kind:
      | "incomplete"
      | "unsupported"
      | "unknown"
      | "types"
      | "local_runner_unproven"
      | "interactive_script_skipped";
    framework?: Framework;
  }[];
}
type Literal =
  | string
  | boolean
  | number
  | null
  | Literal[]
  | { [key: string]: Literal };
const unknown = Symbol("computed");
type Parsed = Literal | typeof unknown;
function literal(
  tokens: readonly Token[],
  start: number,
): { value: Parsed; end: number; complete: boolean } {
  const t = tokens[start];
  if (!t) return { value: unknown, end: start, complete: false };
  if (t.string) return { value: t.value, end: start + 1, complete: true };
  if (["true", "false", "null"].includes(t.value))
    return {
      value: t.value === "null" ? null : t.value === "true",
      end: start + 1,
      complete: true,
    };
  if (/^\d+$/.test(t.value))
    return { value: Number(t.value), end: start + 1, complete: true };
  if (t.value !== "{" && t.value !== "[")
    return { value: unknown, end: start + 1, complete: false };
  const object = t.value === "{";
  const endToken = object ? "}" : "]";
  const result: { [key: string]: Literal } = {};
  const items: Literal[] = [];
  let complete = true;
  let i = start + 1;
  while (i < tokens.length && tokens[i]?.value !== endToken) {
    if (tokens[i]?.value === ",") {
      i++;
      continue;
    }
    const key = tokens[i]?.value ?? "";
    if (object) {
      if (tokens[i + 1]?.value !== ":") {
        complete = false;
        i = skipExpression(tokens, i, endToken);
        continue;
      }
      i += 2;
    }
    const parsed = literal(tokens, i);
    const delimiter = tokens[parsed.end]?.value;
    if (
      parsed.value !== unknown &&
      (delimiter === "," || delimiter === endToken)
    ) {
      if (object) result[key] = parsed.value;
      else items.push(parsed.value);
      complete &&= parsed.complete;
      i = parsed.end;
    } else {
      complete = false;
      i = skipExpression(tokens, i, endToken);
    }
  }
  return {
    value: object ? result : items,
    end: i + 1,
    complete: complete && tokens[i]?.value === endToken,
  };
}
function skipExpression(
  tokens: readonly Token[],
  start: number,
  endToken: string,
): number {
  let depth = 0;
  let i = start;
  for (; i < tokens.length; i++) {
    const v = tokens[i]?.value ?? "";
    if (depth === 0 && (v === "," || v === endToken))
      return v === "," ? i + 1 : i;
    if (["{", "[", "("].includes(v)) depth++;
    if (["}", "]", ")"].includes(v)) depth--;
  }
  return i;
}
function record(value: Parsed | undefined): { [key: string]: Literal } {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
function strings(value: Literal | undefined): string[] {
  return typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];
}
function expand(pattern: string): string[] {
  const braces = /\{([^{}]+)\}/.exec(pattern);
  if (braces)
    return (braces[1] ?? "")
      .split(",")
      .flatMap((part) =>
        expand(
          pattern.slice(0, braces.index) +
            part +
            pattern.slice(braces.index + braces[0].length),
        ),
      );
  const group = /([?@+*]?)\(([^()]+)\)/.exec(pattern);
  if (group) {
    const choices = (group[2] ?? "").split("|");
    if (group[1] === "?") choices.push("");
    return choices.flatMap((part) =>
      expand(
        pattern.slice(0, group.index) +
          part +
          pattern.slice(group.index + group[0].length),
      ),
    );
  }
  return [pattern];
}
function matches(path: string, pattern: string): boolean {
  return expand(pattern.replace(/^\.\//, "")).some((p) => {
    let expression = "^";
    for (let i = 0; i < p.length; i++) {
      const c = p[i] ?? "";
      if (c === "*" && p[i + 1] === "*") {
        i++;
        if (p[i + 1] === "/") {
          expression += "(?:.*/)?";
          i++;
        } else expression += ".*";
      } else if (c === "*") expression += "[^/]*";
      else if (c === "?") expression += "[^/]";
      else if (c === "[" && p.indexOf("]", i + 1) > i + 1) {
        const end = p.indexOf("]", i + 1);
        const content = p.slice(i + 1, end);
        expression += `[${content.startsWith("!") ? `^${content.slice(1)}` : content}]`;
        i = end;
      } else expression += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
    return new RegExp(`${expression}$`).test(path);
  });
}
function shellWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (c === "\\" && quote !== "'") current += text[++i] ?? "";
    else if (quote) {
      if (c === quote) quote = "";
      else current += c;
    } else if (c === "'" || c === '"') quote = c;
    else if (/\s/.test(c)) {
      if (current) {
        words.push(current);
        current = "";
      }
    } else if (";&|<>".includes(c)) {
      if (current) words.push(current);
      words.push(c);
      current = "";
    } else current += c;
  }
  if (current) words.push(current);
  return words;
}
const moduleFramework: Record<string, Framework> = {
  vitest: "vitest",
  "@jest/globals": "jest",
  "node:test": "node",
  "bun:test": "bun",
  "@playwright/test": "playwright",
  ava: "ava",
  mocha: "mocha",
};
interface Imports {
  frameworks: Set<Framework>;
  tests: Set<string>;
  suites: Set<string>;
}
function imports(tokens: readonly Token[]): Imports {
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
function jsScenarios(
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
function closing(tokens: readonly Token[], start: number): number {
  const open = tokens[start]?.value;
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i]?.string) continue;
    if (tokens[i]?.value === open) depth++;
    if (tokens[i]?.value === close && --depth === 0) return i;
  }
  return tokens.length;
}
function pythonScenarios(
  text: string,
  config: { [key: string]: Literal },
): { scenarios: TestScenario[]; countKnown: boolean } {
  const result: TestScenario[] = [];
  const classes: { name: string; indent: number }[] = [];
  let decorators: string[] = [];
  let decoratorStart: number | undefined;
  let countKnown = true;
  const functionPatterns = strings(config.python_functions).flatMap(shellWords);
  const classPatterns = strings(config.python_classes).flatMap(shellWords);
  const source = text.split("\n");
  for (let i = 0; i < source.length; i++) {
    const line = source[i] ?? "";
    const tokens = tokenize(line, true);
    if (!tokens.length) continue;
    const indent = line.length - line.trimStart().length;
    while (
      classes.length &&
      indent <= (classes[classes.length - 1]?.indent ?? -1)
    )
      classes.pop();
    if (tokens[0]?.value === "@") {
      decoratorStart ??= i + 1;
      let decoration = line.trim();
      let balance =
        tokens.filter((t) => !t.string && ["(", "[", "{"].includes(t.value))
          .length -
        tokens.filter((t) => !t.string && [")", "]", "}"].includes(t.value))
          .length;
      while (balance > 0 && i + 1 < source.length) {
        const next = source[++i] ?? "";
        decoration += `\n${next}`;
        const nextTokens = tokenize(next, true);
        balance +=
          nextTokens.filter(
            (t) => !t.string && ["(", "[", "{"].includes(t.value),
          ).length -
          nextTokens.filter(
            (t) => !t.string && [")", "]", "}"].includes(t.value),
          ).length;
      }
      decorators.push(decoration);
      continue;
    }
    if (tokens[0]?.value === "class") {
      const name = tokens[1]?.value ?? "";
      if (
        (classPatterns.length ? classPatterns : ["Test*"]).some((p) =>
          matches(name, p),
        ) ||
        tokens.some((t) => t.value === "TestCase")
      )
        classes.push({ name, indent });
    }
    const def = tokens[0]?.value === "async" ? 1 : 0;
    if (tokens[def]?.value === "def") {
      const name = tokens[def + 1]?.value ?? "";
      const inClass = indent > 0;
      if (
        (!inClass || classes.length) &&
        (functionPatterns.length ? functionPatterns : ["test_*"]).some((p) =>
          matches(name, p),
        )
      ) {
        const qualified = [...classes.map((c) => c.name), name].join("::");
        const parameterDecorators = decorators
          .map((text) => tokenize(text, true))
          .filter((d) => d.some((t) => t.value === "parametrize"));
        let parameterIds: string[] | undefined;
        if (parameterDecorators.length === 1) {
          const decoration = parameterDecorators[0] ?? [];
          const idsIndex = decoration.findIndex(
            (t, index) =>
              t.value === "ids" && decoration[index + 1]?.value === "=",
          );
          const ids = literal(decoration, idsIndex + 2);
          const call =
            decoration.findIndex((t) => t.value === "parametrize") + 1;
          const argument = literal(decoration, call + 1);
          const values = literal(decoration, argument.end + 1);
          if (
            idsIndex >= 0 &&
            ids.complete &&
            values.complete &&
            Array.isArray(ids.value) &&
            Array.isArray(values.value) &&
            ids.value.length === values.value.length &&
            ids.value.length > 0 &&
            ids.value.every(
              (id) =>
                typeof id === "string" &&
                /^[\x20-\x7e]+$/.test(id) &&
                !id.includes("[") &&
                !id.includes("]") &&
                !id.includes("\\"),
            ) &&
            new Set(ids.value).size === ids.value.length
          )
            parameterIds = ids.value as string[];
        }
        // Generated IDs, stacked decorators and collection hooks stay conservative.
        const reliable = !parameterDecorators.length || !!parameterIds;
        if (!reliable) countKnown = false;
        let endLine = i + 1;
        for (let bodyLine = i + 1; bodyLine < source.length; bodyLine++) {
          const body = source[bodyLine] ?? "";
          if (!body.trim() || body.trimStart().startsWith("#")) continue;
          if (body.length - body.trimStart().length <= indent) break;
          endLine = bodyLine + 1;
        }
        for (const nodeName of parameterIds
          ? parameterIds.map((id) => `${qualified}[${id}]`)
          : [qualified]) {
          result.push({
            id: nodeName,
            name: nodeName,
            line: i + 1,
            reliable,
            range: { start: decoratorStart ?? i + 1, end: endLine },
            ...(classes.length
              ? { ancestors: classes.map((c) => c.name) }
              : {}),
          });
        }
      }
    }
    decorators = [];
    decoratorStart = undefined;
  }
  return { scenarios: result, countKnown };
}
interface Group {
  framework: Framework;
  cwd: string;
  config?: string;
  project?: string;
  include: string[];
  exclude: string[];
  setup: string[];
  options: string[];
  settings: { [key: string]: Literal };
  provenance: string;
  incomplete: boolean;
  types?: boolean;
}
function native(path: string, framework: Framework): boolean {
  if (framework === "go") return /_test\.go$/.test(path);
  if (framework === "pytest")
    return /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(path);
  if (framework === "bun")
    return /(?:\.(?:test|spec)|_(?:test|spec))\.[cm]?[jt]sx?$/.test(path);
  if (framework === "jest" && /(?:^|\/)__tests__\/.*\.[cm]?[jt]sx?$/.test(path))
    return true;
  if (framework === "ava")
    return /(?:^|\/)test(?:s)?\/.*\.[cm]?[jt]sx?$/.test(path);
  return (
    /\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/.test(path) ||
    /(?:^|\/)test\.[cm]?[jt]s$/.test(path)
  );
}
function directory(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "." : dir;
}
function relative(cwd: string, path: string): string {
  return posix.relative(cwd, path);
}
function under(cwd: string, path: string): boolean {
  const rel = relative(cwd, path);
  return rel !== ".." && !rel.startsWith("../");
}
function configFramework(path: string): Framework | undefined {
  const name = posix.basename(path);
  if (
    !/\.(?:setup|workspace)\./.test(name) &&
    /^vitest(?:\.[\w-]+)*\.(?:[cm]?[jt]s)$/.test(name)
  )
    return "vitest";
  if (/^jest\.config\./.test(name)) return "jest";
  if (/^playwright\.config\./.test(name)) return "playwright";
  if (["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"].includes(name))
    return "pytest";
  if (name === "bunfig.toml") return "bun";
  if (name === "deno.json" || name === "deno.jsonc") return "deno";
  if (/^\.mocharc\./.test(name)) return "mocha";
  if (/^ava\.config\.[cm]?js$/.test(name)) return "ava";
  return undefined;
}

/** Configuration files needed before planning configured test paths. */
export function isTestConfiguration(path: string): boolean {
  const name = posix.basename(path);
  return (
    configFramework(path) !== undefined ||
    name === "package.json" ||
    /^vitest\.workspace\.[cm]?[jt]s$/.test(name)
  );
}
function iniSettings(
  text: string,
  path: string,
): { settings: { [key: string]: Literal }; complete: boolean } | undefined {
  const settings: { [key: string]: Literal } = {};
  let active = posix.basename(path) === "pytest.ini";
  let seen = active;
  let key = "";
  let complete = true;
  const source = text.split("\n");
  for (let lineIndex = 0; lineIndex < source.length; lineIndex++) {
    const line = source[lineIndex] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
      continue;
    if (trimmed.startsWith("[")) {
      active = [
        "[pytest]",
        "[tool.pytest.ini_options]",
        "[tool:pytest]",
        "[test]",
      ].includes(trimmed);
      seen ||= active;
      continue;
    }
    if (!active) continue;
    const equal = line.indexOf("=");
    if (equal >= 0) {
      key = line.slice(0, equal).trim();
      let value = line.slice(equal + 1).trim();
      if (value.startsWith("[")) {
        while (
          !literal(tokenize(value), 0).complete &&
          lineIndex + 1 < source.length
        )
          value += `\n${source[++lineIndex] ?? ""}`;
      }
      if (
        value.startsWith("[") ||
        value.startsWith('"') ||
        value.startsWith("'")
      ) {
        const parsed = literal(tokenize(value), 0);
        if (parsed.value !== unknown) settings[key] = parsed.value;
        complete &&= parsed.complete;
      } else settings[key] = value;
    } else if (/^\s/.test(line) && key)
      settings[key] = `${String(settings[key] ?? "")} ${trimmed}`;
    else complete = false;
  }
  return seen ? { settings, complete } : undefined;
}
function readConfig(
  text: string,
  tokens = tokenize(text),
): {
  settings: { [key: string]: Literal };
  complete: boolean;
} {
  let start = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.value === "default" && tokens[i - 1]?.value === "export") {
      start = i + 1;
      if (
        tokens[start]?.value === "defineConfig" &&
        tokens[start + 1]?.value === "("
      )
        start += 2;
      break;
    }
    if (tokens[i]?.value === "exports" && tokens[i + 1]?.value === "=") {
      start = i + 2;
      break;
    }
  }
  if (start < 0 && tokens[0]?.value === "{") start = 0;
  const parsed = literal(tokens, start);
  return {
    settings: record(parsed.value),
    complete:
      parsed.complete && !!tokens[start] && tokens[start]?.value === "{",
  };
}
function groupFrom(
  framework: Framework,
  cwd: string,
  config: string,
  settings: { [key: string]: Literal },
  complete: boolean,
  project?: string,
): Group {
  const test = ["vitest", "deno"].includes(framework)
    ? record(settings.test)
    : settings;
  const root =
    typeof settings.root === "string"
      ? settings.root
      : typeof test.root === "string"
        ? test.root
        : undefined;
  const actualCwd = root ? posix.normalize(posix.join(cwd, root)) : cwd;
  let include = strings(
    test.include ?? test.testMatch ?? test.files ?? test.spec,
  );
  let exclude = strings(test.exclude ?? test.testPathIgnorePatterns);
  if (framework === "deno") exclude.push(...strings(settings.exclude));
  if (framework === "mocha") exclude.push(...strings(test.ignore));
  if (framework === "playwright") {
    const testDir = typeof test.testDir === "string" ? test.testDir : ".";
    include = strings(test.testMatch).map((p) => posix.join(testDir, p));
    if (!include.length && testDir !== ".")
      include = [
        `${testDir}/**/*.spec.{js,ts,jsx,tsx,mjs,cjs}`,
        `${testDir}/**/*.test.{js,ts,jsx,tsx,mjs,cjs}`,
      ];
    exclude = strings(test.testIgnore);
  }
  if (framework === "pytest") {
    const paths = strings(test.testpaths).flatMap((s) => shellWords(s));
    const filenames = strings(test.python_files).flatMap((s) => shellWords(s));
    if (paths.length || filenames.length)
      include = (paths.length ? paths : ["."]).flatMap((p) =>
        (filenames.length ? filenames : ["test_*.py", "*_test.py"]).map((f) =>
          posix.join(p, "**", f),
        ),
      );
    exclude = strings(test.norecursedirs)
      .flatMap((s) => shellWords(s))
      .map((p) => `**/${p}/**`);
  }
  const negatives = include
    .filter((p) => p.startsWith("!"))
    .map((p) => p.slice(1));
  exclude.push(...negatives);
  include = include.filter((p) => !p.startsWith("!"));
  const options =
    framework === "pytest"
      ? typeof test.addopts === "string"
        ? shellWords(test.addopts)
        : strings(test.addopts)
      : [];
  return {
    framework,
    cwd: actualCwd,
    config,
    ...(project
      ? { project }
      : typeof test.name === "string"
        ? { project: test.name }
        : {}),
    include,
    exclude,
    setup: strings(test.setupFiles ?? test.globalSetup),
    options,
    settings: test,
    provenance: `config:${config}`,
    incomplete: !complete,
  };
}

/** Pure discovery over the caller's tracked-file snapshot; no I/O or configuration evaluation. */
export function discoverTests(
  files: readonly { path: string; text: string }[],
  plannedPaths?: Set<string>,
  lexical?: LexicalSource,
  configurationPaths?: Set<string>,
): Discovery {
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map(ordered.map((f) => [posix.normalize(f.path), f]));
  const groups: Group[] = [];
  const invocations: {
    cwd: string;
    framework: Framework;
    config?: string;
    project?: string;
    invocation: NonNullable<TestEntry["invocation"]>;
  }[] = [];
  const typechecks: {
    cwd: string;
    invocation: NonNullable<TestEntry["invocation"]>;
  }[] = [];
  const limits: {
    path: string;
    kind:
      | "incomplete"
      | "unsupported"
      | "unknown"
      | "types"
      | "local_runner_unproven"
      | "interactive_script_skipped";
    framework?: Framework;
  }[] = [];
  const addLimit = (
    path: string,
    kind:
      | "incomplete"
      | "unsupported"
      | "unknown"
      | "types"
      | "local_runner_unproven"
      | "interactive_script_skipped",
    framework?: Framework,
  ) => {
    if (
      !limits.some(
        (l) => l.path === path && l.kind === kind && l.framework === framework,
      )
    )
      limits.push({ path, kind, ...(framework ? { framework } : {}) });
  };
  const visited = new Set<string>();
  const addConfig = (
    path: string,
    framework: Framework,
    options: string[] = [],
    project?: string,
  ) => {
    configurationPaths?.add(path);
    const key = `${path}:${framework}:${project ?? ""}:${JSON.stringify(options)}`;
    if (visited.has(key)) return;
    visited.add(key);
    const file = byPath.get(path);
    if (!file) {
      addLimit(path, "incomplete", framework);
      return;
    }
    const parsed =
      framework === "pytest" || path.endsWith(".toml")
        ? iniSettings(file.text, path)
        : readConfig(file.text, lexical?.tokenize(file.path, file.text));
    if (!parsed) return;
    const group = groupFrom(
      framework,
      directory(path),
      path,
      parsed.settings,
      parsed.complete,
      project,
    );
    if (framework === "deno") {
      const task = record(parsed.settings.tasks).test;
      if (typeof task === "string") {
        const words = shellWords(task);
        const flags = words.slice(2).filter((word) => word.startsWith("-"));
        const safe =
          words[0] === "deno" &&
          words[1] === "test" &&
          flags.every((flag) =>
            /^(?:-A|--allow-all|--allow-(?:read|write|net|env|run|sys|ffi)(?:=[\w@./,:*-]+)?|--no-check|--parallel|--fail-fast|--quiet)$/.test(
              flag,
            ),
          ) &&
          words
            .slice(2)
            .every((word) => flags.includes(word) || /^[\w./*-]+$/.test(word));
        if (safe) group.options.push(...flags);
        else group.incomplete = true;
      }
    }
    group.options.push(...options);
    const projects =
      parsed.settings.projects ?? record(parsed.settings.test).projects;
    if (Array.isArray(projects)) {
      for (const item of projects) {
        if (typeof item === "string") {
          const reference = posix.normalize(posix.join(directory(path), item));
          const found = ordered.filter(
            (f) =>
              matches(f.path, reference) ||
              (under(reference, f.path) &&
                configFramework(f.path) === framework),
          );
          if (!found.length) addLimit(reference, "incomplete", framework);
          for (const child of found)
            addConfig(child.path, framework, group.options);
        } else {
          const childSettings = record(item);
          const child = groupFrom(
            framework,
            group.cwd,
            path,
            {
              ...parsed.settings,
              ...childSettings,
              ...(framework === "vitest"
                ? {
                    test: {
                      ...record(parsed.settings.test),
                      ...record(childSettings.test),
                    },
                  }
                : {}),
            },
            parsed.complete,
          );
          child.options.push(...options);
          groups.push(child);
        }
      }
      // A projects list defines separate execution contexts, not an extra root run.
      if (group.incomplete) addLimit(path, "incomplete", framework);
    } else groups.push(group);
    const typecheck = record(group.settings.typecheck);
    if (strings(typecheck.include).length)
      groups.push({
        ...group,
        include: strings(typecheck.include),
        exclude: strings(typecheck.exclude),
        types: true,
      });
    if (group.incomplete) addLimit(path, "incomplete", framework);
  };
  // Configs must constrain implicit package scripts regardless of path ordering.
  for (const file of ordered) {
    const framework = configFramework(file.path);
    if (framework) addConfig(file.path, framework);
  }
  for (const file of ordered) {
    const framework = configFramework(file.path);
    if (framework) addConfig(file.path, framework);
    if (/^vitest\.workspace\.[cm]?[jt]s$/.test(posix.basename(file.path))) {
      const tokens = lexical
        ? lexical.tokenize(file.path, file.text)
        : tokenize(file.text);
      const index = tokens.findIndex(
        (t, i) => t.value === "default" && tokens[i - 1]?.value === "export",
      );
      const parsed = literal(tokens, index + 1);
      if (!parsed.complete) addLimit(file.path, "incomplete", "vitest");
      if (Array.isArray(parsed.value))
        for (const item of parsed.value) {
          if (typeof item === "string") {
            const pattern = posix.join(directory(file.path), item);
            const refs = ordered.filter(
              (f) =>
                matches(f.path, pattern) ||
                (under(pattern, f.path) &&
                  configFramework(f.path) === "vitest"),
            );
            if (!refs.length) addLimit(pattern, "incomplete", "vitest");
            for (const ref of refs) addConfig(ref.path, "vitest");
          } else
            groups.push(
              groupFrom(
                "vitest",
                directory(file.path),
                file.path,
                record(item),
                parsed.complete,
              ),
            );
        }
    }
    if (posix.basename(file.path) !== "package.json") continue;
    let manifest: { [key: string]: Literal };
    try {
      manifest = record(JSON.parse(file.text));
    } catch {
      addLimit(file.path, "incomplete");
      continue;
    }
    for (const framework of ["jest", "ava", "mocha"] as const)
      if (manifest[framework])
        groups.push(
          groupFrom(
            framework,
            directory(file.path),
            file.path,
            record(manifest[framework]),
            true,
          ),
        );
    const scripts = record(manifest.scripts);
    const claimedScripts = new Set<string>();
    for (const [scriptName, script] of Object.entries(scripts).sort(
      ([a], [b]) => Number(b === "test") - Number(a === "test"),
    )) {
      if (typeof script !== "string") continue;
      const allWords = shellWords(script);
      const lastSeparator = allWords.lastIndexOf("&");
      const tail = allWords.slice(lastSeparator + 1);
      const avaLoader =
        tail[1] === "ava" &&
        /^NODE_OPTIONS=--import=[\w@./-]+$/.test(tail[0] ?? "") &&
        allWords
          .slice(0, lastSeparator + 1)
          .every((word) => ["xo", "tsc", "&"].includes(word));
      const words = avaLoader ? tail : allWords;
      const simple = !words.some(
        (w) =>
          [";", "&", "|", "<", ">"].includes(w) ||
          w.includes("$") ||
          w.includes("`"),
      );
      if (
        words[0] === "tsc" &&
        simple &&
        words.some(
          (w) => w === "-p" || w === "--project" || w.startsWith("--project="),
        )
      ) {
        typechecks.push({
          cwd: directory(file.path),
          invocation: {
            executable: "tsc",
            args: words.slice(1),
            kind: "typecheck",
          },
        });
      }
      const commands: Record<string, Framework> = {
        vitest: "vitest",
        jest: "jest",
        bun: "bun",
        playwright: "playwright",
        pytest: "pytest",
        ava: "ava",
        mocha: "mocha",
        deno: "deno",
        node: "node",
        go: "go",
      };
      const index = words.findIndex(
        (w, i) =>
          commands[w] &&
          (w !== "node" || words.slice(i + 1).includes("--test")) &&
          (!["bun", "deno", "go"].includes(w) || words[i + 1] === "test"),
      );
      if (index < 0) continue;
      const framework = commands[words[index] ?? ""];
      if (!framework) continue;
      const args = words.slice(index + 1);
      const configIndex = args.findIndex((w) => ["--config", "-c"].includes(w));
      const configFlag = args.find((w) => w.startsWith("--config="));
      const reference =
        configIndex >= 0 ? args[configIndex + 1] : configFlag?.slice(9);
      const options: string[] = [];
      const includes: string[] = [];
      let incomplete = words.some(
        (w) =>
          [";", "&", "|", "<", ">"].includes(w) ||
          w.includes("$") ||
          w.includes("`"),
      );
      if (
        ["ava", "mocha", "deno"].includes(framework) &&
        index > 0 &&
        !avaLoader
      )
        incomplete = true;
      let scriptCwd = directory(file.path);
      let unsafeOptions = false;
      let project: string | undefined;
      const interactive = args.some(
        (arg) =>
          [
            "--watch",
            "--watchAll",
            "-w",
            ...(framework === "mocha" ? [] : ["--ui"]),
          ].includes(arg) ||
          (framework === "mocha"
            ? /^(?:--watch|--watchAll)=/
            : /^(?:--watch|--watchAll|--ui)=/
          ).test(arg),
      );
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? "";
        if (["run", "test", "--test"].includes(arg)) continue;
        if (
          [
            "--watch",
            "--watchAll",
            "-w",
            ...(framework === "mocha" ? [] : ["--ui"]),
          ].includes(arg) ||
          (framework === "mocha"
            ? /^(?:--watch|--watchAll)=/
            : /^(?:--watch|--watchAll|--ui)=/
          ).test(arg)
        )
          continue;
        if (["--config", "-c"].includes(arg)) {
          i++;
          continue;
        }
        if (arg.startsWith("--config=")) continue;
        if (["--project", "--selectProjects"].includes(arg)) {
          project = args[++i];
          continue;
        }
        if (arg.startsWith("--project=")) {
          project = arg.slice(10);
          continue;
        }
        if (arg === "--cwd" || arg.startsWith("--cwd=")) {
          const cwd = arg === "--cwd" ? args[++i] : arg.slice(6);
          if (cwd) scriptCwd = posix.normalize(posix.join(scriptCwd, cwd));
          else {
            incomplete = true;
            unsafeOptions = true;
          }
          continue;
        }
        if (
          framework === "deno" &&
          /^(?:-A|--allow-all|--allow-(?:read|write|net|env|run|sys|ffi)(?:=.*)?)$/.test(
            arg,
          )
        ) {
          options.push(arg);
          continue;
        }
        if (
          [
            "--reporter",
            "--environment",
            "--pool",
            "--timeout",
            "--testTimeout",
            "--loader",
            "--import",
            "--require",
            "--grep",
            "--fgrep",
            "--file",
            "--spec",
            "--ui",
            "--extension",
            "--maxWorkers",
            "--minWorkers",
            "-n",
            "-r",
            "-m",
            "-k",
          ].includes(arg)
        ) {
          options.push(arg, args[++i] ?? "");
          continue;
        }
        if (arg.startsWith("-")) {
          if (
            !arg.includes("=") &&
            args[i + 1] &&
            !args[i + 1]?.startsWith("-") &&
            ![
              "--coverage",
              "--run",
              "--noEmit",
              "--passWithNoTests",
              "--bail",
            ].includes(arg)
          ) {
            unsafeOptions = true;
            incomplete = true;
            i++;
          } else options.push(arg);
        } else if (
          /\.(?:[cm]?[jt]sx?|py)$/.test(arg) ||
          arg.includes("*") ||
          (framework === "deno" && arg.endsWith("/")) ||
          byPath.has(posix.join(directory(file.path), arg))
        )
          includes.push(arg);
        else incomplete = true;
      }
      if (unsafeOptions) options.length = 0;
      if (
        reference &&
        ["ava", "mocha", "deno"].includes(framework) &&
        !byPath.has(
          posix.normalize(posix.join(directory(file.path), reference)),
        )
      )
        incomplete = true;
      const context = JSON.stringify([
        framework,
        scriptCwd,
        reference ?? "",
        project ?? "",
      ]);
      if (claimedScripts.has(context)) continue;
      claimedScripts.add(context);
      if (interactive)
        addLimit(file.path, "interactive_script_skipped", framework);
      if (reference)
        addConfig(
          posix.normalize(posix.join(directory(file.path), reference)),
          framework,
          options,
          project,
        );
      if (reference && ["ava", "mocha", "deno"].includes(framework)) {
        const configPath = posix.normalize(
          posix.join(directory(file.path), reference),
        );
        for (const group of groups.filter(
          (group) =>
            group.config === configPath && group.framework === framework,
        )) {
          group.cwd = scriptCwd;
          if (!group.include.length || framework === "mocha")
            group.include.push(...includes);
          group.incomplete ||= incomplete;
        }
      }
      if (!reference) {
        const existing = groups.filter(
          (g) => g.framework === framework && g.cwd === scriptCwd,
        );
        if (!existing.length)
          groups.push({
            framework,
            cwd: scriptCwd,
            ...(project ? { project } : {}),
            include: includes,
            exclude: [],
            setup: [],
            options,
            settings: {},
            provenance: `script:${file.path}:${scriptName}`,
            incomplete,
          });
        else
          for (const group of existing) {
            group.options.push(...options);
            if (
              ["ava", "mocha", "deno"].includes(framework) &&
              (!group.include.length || framework === "mocha")
            )
              group.include.push(...includes);
            if (["ava", "mocha", "deno"].includes(framework))
              group.incomplete ||= incomplete;
          }
      }
      if (simple && (index === 0 || avaLoader) && !incomplete && !interactive) {
        const prefix =
          framework === "node"
            ? ["--test"]
            : ["bun", "go", "deno", "playwright"].includes(framework)
              ? ["test"]
              : framework === "vitest" && args.includes("run")
                ? ["run"]
                : [];
        invocations.push({
          cwd: scriptCwd,
          framework,
          ...(reference
            ? {
                config: posix.normalize(
                  posix.join(directory(file.path), reference),
                ),
              }
            : {}),
          ...(project ? { project } : {}),
          invocation: {
            executable: index === 1 ? "env" : (words[index] ?? framework),
            args: [
              ...(index === 1
                ? [words[0] ?? "", words[index] ?? framework]
                : []),
              ...prefix,
              ...options,
            ],
            kind: "runner",
          },
        });
      }
      if (incomplete) addLimit(file.path, "incomplete", framework);
    }
  }
  const entries: TestEntry[] = [];
  for (const file of ordered) {
    const typeFile = /\.(?:test|spec)-d\.[cm]?tsx?$/.test(file.path);
    const candidate =
      typeFile ||
      ["vitest", "jest", "node", "bun", "ava", "go", "pytest"].some(
        (framework) => native(file.path, framework as Framework),
      ) ||
      groups.some((group) => {
        if (!under(group.cwd, file.path)) return false;
        const local = relative(group.cwd, file.path);
        return group.include.some(
          (pattern) =>
            matches(local, pattern) ||
            (under(pattern, local) && !pattern.includes("*")),
        );
      });
    if (!candidate) continue;
    if (plannedPaths) {
      plannedPaths.add(file.path);
      continue;
    }
    const python = file.path.endsWith(".py");
    const tokens = lexical
      ? lexical.tokenize(file.path, file.text, python)
      : tokenize(file.text, python);
    const bindings = imports(tokens);
    if (file.path.endsWith("_test.go")) {
      bindings.frameworks.add("go");
      if (
        /^\/\/\s*(?:go:build|\+build)\b/m.test(file.text) ||
        /_(?:linux|windows|darwin|amd64|arm64)_test\.go$/.test(file.path)
      )
        addLimit(file.path, "incomplete", "go");
    }
    if (file.path.endsWith(".py") && native(file.path, "pytest"))
      bindings.frameworks.add("pytest");
    const applicable = groups.filter((g) => under(g.cwd, file.path));
    const matched: Group[] = [];
    const blocked = new Set<Framework>();
    for (const group of applicable) {
      const local = relative(group.cwd, file.path);
      if (group.exclude.some((p) => matches(local, p) || local.includes(p))) {
        blocked.add(group.framework);
        continue;
      }
      const explicit = group.include.length > 0;
      if (
        !explicit &&
        group.provenance.startsWith("script:") &&
        !bindings.frameworks.has(group.framework) &&
        !["pytest", "go"].includes(group.framework)
      )
        continue;
      const included = explicit
        ? group.include.some(
            (p) => matches(local, p) || (under(p, local) && !p.includes("*")),
          )
        : native(local, group.framework) || typeFile;
      if (!included) {
        blocked.add(group.framework);
        continue;
      }
      if (!explicit && group.setup.some((p) => matches(local, p))) {
        blocked.add(group.framework);
        continue;
      }
      if (typeFile && !group.types) continue;
      matched.push(group);
    }
    // A closer package/config overrides an ancestor's default convention.
    const deepest = new Map<Framework, number>();
    for (const group of applicable)
      deepest.set(
        group.framework,
        Math.max(deepest.get(group.framework) ?? 0, group.cwd.length),
      );
    const candidates = matched.filter(
      (g) => g.cwd.length === deepest.get(g.framework),
    );
    for (const framework of bindings.frameworks) {
      if (
        blocked.has(framework) ||
        candidates.some((g) => g.framework === framework) ||
        applicable.some((g) => g.framework === framework)
      )
        continue;
      if (!native(file.path, framework)) continue;
      candidates.push({
        framework,
        cwd: framework === "go" ? directory(file.path) : ".",
        include: [],
        exclude: [],
        setup: [],
        options: [],
        settings: {},
        provenance: `declaration:${framework}`,
        incomplete: false,
      });
    }
    const frameworks = new Set([
      ...candidates.map((g) => g.framework),
      ...bindings.frameworks,
    ]);
    if (frameworks.size > 1 && candidates.length) {
      addLimit(file.path, "incomplete");
      continue;
    }
    if (typeFile && !candidates.length)
      candidates.push({
        framework: bindings.frameworks.values().next().value ?? "unknown",
        cwd: ".",
        include: [],
        exclude: [],
        setup: [],
        options: [],
        settings: {},
        provenance: "type convention",
        incomplete: false,
        types: true,
      });
    for (const group of candidates) {
      if (
        group.framework === "ava" &&
        !group.include.length &&
        /(?:^|\/)(?:_[^/]*|helpers|fixtures)(?:\/|$)/.test(file.path)
      )
        continue;
      let extracted: { scenarios: TestScenario[]; countKnown: boolean };
      const exclusiveMocha =
        group.framework === "mocha" &&
        tokens.some(
          (token, index) =>
            token.value === "only" &&
            tokens[index - 1]?.value === "." &&
            tokens[index + 1]?.value === "(",
        );
      if (group.framework === "pytest")
        extracted = pythonScenarios(file.text, group.settings);
      else if (group.framework === "go") {
        const scenarios: TestScenario[] = [];
        for (let i = 0; i < tokens.length - 2; i++) {
          const name = tokens[i + 1]?.value ?? "";
          if (
            tokens[i]?.value === "func" &&
            tokens[i + 2]?.value === "(" &&
            /^(?:Test[^a-z]|Example(?:[^a-z]|$))/.test(name)
          ) {
            // Go examples are runnable only with an Output/Unordered output directive.
            const end = closing(tokens, i + 2);
            const bodyStart = tokens.findIndex(
              (t, j) => j > end && t.value === "{",
            );
            const bodyEnd =
              bodyStart < 0 ? bodyStart : closing(tokens, bodyStart);
            const body =
              bodyStart < 0
                ? ""
                : file.text.slice(
                    tokens[bodyStart]?.offset ?? 0,
                    tokens[bodyEnd]?.offset ?? file.text.length,
                  );
            if (
              name.startsWith("Example") &&
              !/\/\/\s*(?:Unordered output|Output):/i.test(body)
            )
              continue;
            const line = tokens[i]?.line ?? 1;
            scenarios.push({
              id: name,
              name,
              line,
              reliable: true,
              ...(tokens[bodyEnd]
                ? { range: { start: line, end: tokens[bodyEnd]?.line ?? line } }
                : {}),
            });
          }
        }
        extracted = { scenarios, countKnown: true };
      } else extracted = jsScenarios(tokens, group.framework, bindings);
      if (exclusiveMocha) extracted.countKnown = false;
      const explicit = group.include.length > 0;
      if (!explicit && !extracted.scenarios.length && !typeFile) continue;
      const kind = typeFile || group.types ? "types" : "runtime";
      const entry: TestEntry = {
        path: file.path,
        framework: group.framework,
        cwd: group.cwd,
        ...(group.config ? { config: group.config } : {}),
        ...(group.project ? { project: group.project } : {}),
        options: group.options,
        scenarios: extracted.scenarios,
        countKnown:
          extracted.countKnown &&
          !group.incomplete &&
          extracted.scenarios.length > 0,
        kind,
        provenance: group.provenance,
        ...(["ava", "deno"].includes(group.framework) && group.incomplete
          ? {
              commandRefusal:
                "runner configuration or options are not statically resolved",
            }
          : {}),
        ...(group.framework === "mocha"
          ? {
              ...(applicable.some(
                (candidate) =>
                  candidate.framework === "mocha" &&
                  (candidate.settings.spec !== undefined ||
                    candidate.settings.file !== undefined ||
                    candidate.options.some((option) =>
                      /^(?:--spec|--file)(?:=|$)/.test(option),
                    )),
              )
                ? { commandRefusal: "Mocha additive spec is not neutralized" }
                : applicable.some(
                      (candidate) =>
                        candidate.framework === "mocha" &&
                        (candidate.incomplete ||
                          candidate.settings.extends !== undefined),
                    )
                  ? {
                      commandRefusal:
                        "Mocha configuration is not statically resolved",
                    }
                  : {}),
              ...(exclusiveMocha
                ? {
                    nameFilterReason:
                      "Mocha .only declarations restrict project execution",
                  }
                : {}),
              nameFilterBlocked:
                applicable.some(
                  (candidate) =>
                    candidate.framework === "mocha" &&
                    (["grep", "fgrep", "invert"].some(
                      (key) => candidate.settings[key] !== undefined,
                    ) ||
                      (candidate.settings.ui !== undefined &&
                        candidate.settings.ui !== "bdd")),
                ) ||
                group.options.some(
                  (option, index) =>
                    /^(?:--grep|--fgrep|--invert|-g|-f|-i)(?:=|$)/.test(
                      option,
                    ) ||
                    (option === "--ui" && group.options[index + 1] !== "bdd") ||
                    (option.startsWith("--ui=") && option !== "--ui=bdd"),
                ),
            }
          : {}),
      };
      const proven = invocations.find(
        (i) =>
          i.framework === group.framework &&
          under(i.cwd, file.path) &&
          (!i.config || i.config === group.config) &&
          (!i.project || i.project === group.project),
      );
      if (kind === "types") {
        const typecheck = typechecks
          .filter((t) => under(t.cwd, file.path))
          .sort((a, b) => b.cwd.length - a.cwd.length)[0];
        if (typecheck) {
          entry.invocation = typecheck.invocation;
          entry.cwd = typecheck.cwd;
        }
      } else if (proven) entry.invocation = proven.invocation;
      else if (!["ava", "mocha", "deno", "unknown"].includes(group.framework))
        addLimit(file.path, "local_runner_unproven", group.framework);
      if (
        !entries.some(
          (e) =>
            e.path === entry.path &&
            e.framework === entry.framework &&
            e.cwd === entry.cwd &&
            e.config === entry.config &&
            e.project === entry.project &&
            e.kind === entry.kind &&
            JSON.stringify(e.options) === JSON.stringify(entry.options),
        )
      )
        entries.push(entry);
      if (
        ["ava", "mocha", "deno"].includes(group.framework) &&
        group.incomplete
      )
        addLimit(file.path, "incomplete", group.framework);
      if (kind === "types") addLimit(file.path, "types", group.framework);
    }
  }
  const evidence = ordered
    .filter((f) => isTestFile(f.path) || entries.some((e) => e.path === f.path))
    .map((f) => f.path);
  for (const path of evidence)
    if (!entries.some((e) => e.path === path)) {
      addLimit(path, "incomplete");
      if (!limits.some((limit) => limit.path === path && limit.framework))
        addLimit(path, "unknown", "unknown");
    }
  return { entries, evidence, limits };
}
