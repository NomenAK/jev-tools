export interface LexicalToken {
  value: string;
  line: number;
  offset: number;
  string: boolean;
}
export interface LexicalSource {
  tokenize(path: string, text: string, python?: boolean): LexicalToken[];
  resolved?(path: string, text: string): void;
}
/** A lexical pass excludes comments and keeps literals separate from identifiers. */
export function tokenize(text: string, python = false): LexicalToken[] {
  const tokens: LexicalToken[] = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (/\s/.test(c)) {
      if (c === "\n") line++;
      i++;
      continue;
    }
    if (python ? c === "#" : text.slice(i, i + 2) === "//") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (!python && text.slice(i, i + 2) === "/*") {
      i += 2;
      while (i < text.length && text.slice(i, i + 2) !== "*/") {
        if (text[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    const start = i;
    const firstLine = line;
    const previous = tokens[tokens.length - 1];
    // A slash can begin a regex only where an expression can begin, not after
    // an operand (where it is division). Keep the entire literal opaque.
    if (
      !python &&
      c === "/" &&
      (!previous ||
        (!previous.string &&
          (/^[([{,:;=!?&|+*%~^<>-]$/.test(previous.value) ||
            [
              "return",
              "throw",
              "case",
              "delete",
              "void",
              "typeof",
              "yield",
              "await",
              "in",
              "of",
            ].includes(previous.value))))
    ) {
      let end = i + 1;
      let characterClass = false;
      while (end < text.length && text[end] !== "\n" && text[end] !== "\r") {
        const next = text[end];
        if (next === "\\") {
          end += 2;
          continue;
        }
        if (next === "[") characterClass = true;
        else if (next === "]") characterClass = false;
        else if (next === "/" && !characterClass) break;
        end++;
      }
      if (text[end] === "/") {
        end++;
        while (/[a-z]/i.test(text[end] ?? "")) end++;
        tokens.push({
          value: text.slice(i, end),
          line,
          offset: start,
          string: false,
        });
        i = end;
        continue;
      }
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote =
        python && text.slice(i, i + 3) === c.repeat(3) ? c.repeat(3) : c;
      i += quote.length;
      let value = "";
      let dynamic = false;
      while (i < text.length && text.slice(i, i + quote.length) !== quote) {
        if (text[i] === "\n") line++;
        if (c === "`" && text.slice(i, i + 2) === "${") dynamic = true;
        if (text[i] === "\\") {
          i++;
          const escaped = text[i++] ?? "";
          value +=
            escaped === "n"
              ? "\n"
              : escaped === "t"
                ? "\t"
                : escaped === "r"
                  ? "\r"
                  : escaped;
        } else value += text[i++];
      }
      const closed = text.slice(i, i + quote.length) === quote;
      if (closed) i += quote.length;
      tokens.push({
        value,
        line: firstLine,
        offset: start,
        string: closed && !dynamic,
      });
    } else if (/[\w$]/.test(c)) {
      while (i < text.length && /[\w$]/.test(text[i] ?? "")) i++;
      tokens.push({
        value: text.slice(start, i),
        line,
        offset: start,
        string: false,
      });
    } else {
      i++;
      tokens.push({ value: c, line, offset: start, string: false });
    }
  }
  return tokens;
}
