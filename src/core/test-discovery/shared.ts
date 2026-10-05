import type { LexicalToken as Token } from "../lexical.ts";

export type Literal =
  | string
  | boolean
  | number
  | null
  | Literal[]
  | { [key: string]: Literal };
export const unknown = Symbol("computed");
export type Parsed = Literal | typeof unknown;
export function literal(
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
export function skipExpression(
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
export function record(value: Parsed | undefined): {
  [key: string]: Literal;
} {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
export function strings(value: Literal | undefined): string[] {
  return typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];
}
export function expand(pattern: string): string[] {
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
export function matches(path: string, pattern: string): boolean {
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
export function shellWords(text: string): string[] {
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
export function closing(tokens: readonly Token[], start: number): number {
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
