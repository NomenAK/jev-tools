import {
  LOCATE_SECTION_MAX_LINES,
  LOCATE_SECTION_MIN_LINES,
  LOCATE_WINDOW_LINES,
} from "../constants.ts";

export interface SectionDeclaration {
  name: string;
  start: number;
  end: number;
}
export interface Section {
  id: string;
  label: string;
  start: number;
  end: number;
  text: string;
  serializedTextChars?: number;
}
export interface Sections {
  sections: Section[];
  lines: number;
  method: "syntax" | "markdown" | "heuristic" | "windows";
}

/** Exact Markdown heading sections; callers may apply their own display grouping. */
export function markdownSections(
  text: string,
): (Section & { level: number })[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const headings: { start: number; label: string; level: number }[] = [];
  let fence: { character: string; length: number } | undefined;
  let frontMatter = lines[0]?.trim() === "---";
  let html: string | undefined;
  let previousText = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (frontMatter) {
      if (index > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) frontMatter = false;
      previousText = false;
      continue;
    }
    if (html) {
      if (html === "blank" ? !line.trim() : line.toLowerCase().includes(html))
        html = undefined;
      previousText = false;
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1]?.[0] === fence.character &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      )
        fence = undefined;
      previousText = false;
      continue;
    }
    if (marker && !(marker[1]?.[0] === "`" && marker[2]?.includes("`"))) {
      fence = {
        character: marker[1]?.[0] ?? "`",
        length: marker[1]?.length ?? 3,
      };
      previousText = false;
      continue;
    }
    const block = /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i.exec(line);
    const closing = line.trimStart().startsWith("<!--")
      ? "-->"
      : block
        ? `</${block[1]?.toLowerCase()}>`
        : /^ {0,3}<\/?(?:address|article|aside|blockquote|div|dl|fieldset|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|section|table|tbody|td|th|tr|ul)(?:\s|\/?>|$)/i.test(
              line,
            )
          ? "blank"
          : undefined;
    if (closing) {
      if (closing === "blank" || !line.toLowerCase().includes(closing))
        html = closing;
      previousText = false;
      continue;
    }
    const heading = /^ {0,3}#{1,6}(?:[\t ]+|$)(.*?)\s*$/.exec(line);
    if (heading) {
      headings.push({
        start: index + 1,
        level: line.trimStart().match(/^#+/)?.[0].length ?? 1,
        label: (heading[1] ?? "").replace(/[\t ]+#+[\t ]*$/, "").trim(),
      });
      previousText = false;
    } else if (previousText && /^ {0,3}(?:=+|-+)\s*$/.test(line)) {
      headings.push({
        start: index,
        level: line.trimStart().startsWith("=") ? 1 : 2,
        label: lines[index - 1]?.trim() ?? "",
      });
      previousText = false;
    } else previousText = Boolean(line.trim()) && !/^ {4}|^\t/.test(line);
  }
  return headings.map((heading, index) => {
    const end = (headings[index + 1]?.start ?? lines.length + 1) - 1;
    return {
      id: `S${index + 1}`,
      ...heading,
      end,
      text: lines.slice(heading.start - 1, end).join("\n"),
    };
  });
}

/** Produces disjoint, exhaustive ranges; labels never replace the underlying evidence. */
export function sectionFile(
  path: string,
  text: string,
  declarations?: readonly SectionDeclaration[],
): Sections {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length) return { sections: [], lines: 0, method: "windows" };
  const boundaries: { start: number; label: string }[] = [];
  let method: Sections["method"] = "windows";
  if (declarations?.length) {
    const sorted = [...declarations].sort(
      (a, b) => a.start - b.start || b.end - a.end,
    );
    const ancestors: SectionDeclaration[] = [];
    for (let index = 0; index < sorted.length; index++) {
      const declaration = sorted[index];
      if (!declaration) continue;
      while ((ancestors.at(-1)?.end ?? Infinity) < declaration.end)
        ancestors.pop();
      const enclosing = ancestors.at(-1);
      const suppressed =
        enclosing &&
        enclosing.end - enclosing.start + 1 <= LOCATE_SECTION_MAX_LINES;
      if (!suppressed && boundaries.at(-1)?.start !== declaration.start)
        boundaries.push({ start: declaration.start, label: declaration.name });
      ancestors.push(declaration);
      if (!suppressed && declaration.end < lines.length)
        boundaries.push({
          start: declaration.end + 1,
          label: `${enclosing?.name ?? declaration.name} continuation`,
        });
    }
    boundaries.sort(
      (a, b) =>
        a.start - b.start ||
        Number(a.label.endsWith(" continuation")) -
          Number(b.label.endsWith(" continuation")),
    );
    for (let index = boundaries.length - 1; index > 0; index--)
      if (boundaries[index]?.start === boundaries[index - 1]?.start)
        boundaries.splice(index, 1);
    method = "syntax";
  } else if (/\.(?:md|mdx|markdown)$/i.test(path)) {
    for (const section of markdownSections(text))
      boundaries.push({ start: section.start, label: section.label });
    if (boundaries.length) method = "markdown";
  }
  if (!boundaries.length) {
    let pythonClass:
      | { name: string; indent: number; start: number; seenMethod: boolean }
      | undefined;
    lines.forEach((line, index) => {
      const indentation = line.length - line.trimStart().length;
      if (
        path.endsWith(".py") &&
        line.trim() &&
        !line.trimStart().startsWith("#")
      ) {
        if (pythonClass && indentation <= pythonClass.indent)
          pythonClass = undefined;
        const className = /^\s*class\s+(\w+)/.exec(line)?.[1];
        if (className) {
          pythonClass = {
            name: className,
            indent: indentation,
            start: index + 1,
            seenMethod: false,
          };
          boundaries.push({ start: index + 1, label: className });
          return;
        }
      }
      const declaration =
        /^\s*(?:(?:export|default|async|public|private|protected|static|abstract)\s+)*(?:(?:function\s*\*?|class|interface|enum|type|def|fn|func|struct|impl)\s+([\w.$]+)|(?:const|let|var)\s+([\w$]+)\s*=|([\w$]+)\s*\([^;]*\)\s*(?::[^=]+)?\s*\{)/.exec(
          line,
        );
      if (!declaration) return;
      const indent = line.length - line.trimStart().length;
      if (
        indent > 4 ||
        /^(?:if|for|while|switch|catch)$/.test(declaration[3] ?? "")
      )
        return;
      let start = index + 1;
      if (
        path.endsWith(".py") &&
        pythonClass &&
        /^\s*(?:async\s+)?def\s/.test(line) &&
        !pythonClass.seenMethod
      ) {
        boundaries.pop();
        pythonClass.seenMethod = true;
        start = pythonClass.start;
      }
      boundaries.push({
        start,
        label: pythonClass
          ? `${pythonClass.name}.${declaration[1] ?? "method"}`
          : (declaration[1] ?? declaration[2] ?? declaration[3] ?? "section"),
      });
    });
    if (boundaries.length) method = "heuristic";
  }
  if (!boundaries.length) {
    for (let start = 1; start <= lines.length; start += LOCATE_WINDOW_LINES)
      boundaries.push({
        start,
        label: `lines ${start}-${Math.min(lines.length, start + LOCATE_WINDOW_LINES - 1)}`,
      });
  } else {
    const first = boundaries[0];
    if (first) first.start = 1;
  }
  const ranges = boundaries.map((boundary, index) => ({
    ...boundary,
    end: (boundaries[index + 1]?.start ?? lines.length + 1) - 1,
  }));
  // Split oversized leaf nodes without losing a line or inventing syntax.
  const chunks = ranges.flatMap((range) => {
    const result: typeof ranges = [];
    const size =
      method === "windows" ? LOCATE_WINDOW_LINES : LOCATE_SECTION_MAX_LINES;
    for (let start = range.start; start <= range.end; start += size)
      result.push({
        start,
        end: Math.min(range.end, start + size - 1),
        label: range.label,
      });
    return result;
  });
  const merged: typeof ranges = [];
  for (const chunk of chunks) {
    const previous = merged.at(-1);
    if (
      method !== "windows" &&
      previous &&
      (chunk.end - chunk.start + 1 < LOCATE_SECTION_MIN_LINES ||
        previous.end - previous.start + 1 < LOCATE_SECTION_MIN_LINES) &&
      chunk.end - previous.start + 1 <= LOCATE_SECTION_MAX_LINES
    ) {
      previous.end = chunk.end;
      previous.label += ` / ${chunk.label}`;
    } else merged.push({ ...chunk });
  }
  return {
    lines: lines.length,
    method,
    sections: merged.map((range, index) => ({
      id: `S${index + 1}`,
      ...range,
      text: lines.slice(range.start - 1, range.end).join("\n"),
    })),
  };
}
