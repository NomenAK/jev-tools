import { ASK_MAX_FILES } from "../constants.ts";
import type { Question, State } from "../jev/types.ts";
import type { CompiledAsks } from "./asks.ts";

export interface UnresolvedAskReference {
  reference: string;
  reason: string;
}

const fileSelector =
  /\b(files|files_before)\s*\[\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\]/g;
const selector =
  /\b[A-Za-z_$][\w$]*(?:(?:\s*\.\s*[A-Za-z_$][\w$]*)|(?:\s*\[\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\d+)\s*\]))*/g;

function unquote(value: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value.slice(1, -1).replace(/\\(['\\])/g, "$1");
}

function looksLikePath(value: string): boolean {
  if (/\s/.test(value) || /^(?:[a-z]+:|www\.)/i.test(value)) return false;
  if (
    !/[A-Za-z_]/.test(value) ||
    /^(?:state|docs?|files|files_before)\./.test(value)
  )
    return false;
  if (/^(?:e\.g|i\.e|Node\.js|Next\.js|Vue\.js)$/i.test(value)) return false;
  return (
    /^(?:\.?\.?\/)?[\w.@+-]+(?:\/[\w.@+-]+)+$/.test(value) ||
    /^[\w@+-][\w.@+-]*\.(?:[cm]?[jt]sx?|py|json|jsonc|ya?ml|toml|ini|cfg|conf|md|mdx|txt|rst|html?|css|scss|sql|sh|bash|rs|go|java|rb|php|c|h|cpp|hpp|vue|svelte|xml|csv|env|lock)$/i.test(
      value,
    ) ||
    /^\.[A-Za-z][\w.-]*$/.test(value) ||
    /^(?:README|LICENSE|LICENCE|Makefile|Dockerfile|CHANGELOG|AGENTS|CLAUDE)(?:\.[\w-]+)?$/.test(
      value,
    )
  );
}

/** Explicit paths only: numbers, dates and URLs are not evidence references. */
export function citedPaths(text: string): string[] {
  const found = new Set<string>();
  const withoutUrls = text.replace(
    /\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>"'`]+/gi,
    " ",
  );
  const withoutSelectors = withoutUrls.replace(
    fileSelector,
    (_whole, _root: string, quoted: string) => {
      found.add(unquote(quoted));
      return " ";
    },
  );
  const withoutFields = withoutSelectors.replace(selector, (value) =>
    value.includes("[") || /^(?:state|docs?|files|files_before)\./.test(value)
      ? " "
      : value,
  );
  const unquoted = withoutFields.replace(
    /`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'/g,
    (
      _whole,
      backtick: string | undefined,
      double: string | undefined,
      single: string | undefined,
    ) => {
      const value = backtick ?? double ?? single ?? "";
      if (looksLikePath(value)) {
        found.add(value);
        return " ";
      }
      return value;
    },
  );
  for (const match of unquoted.matchAll(/[\w.@+-]+(?:\/[\w.@+-]+)*/g)) {
    const value = match[0].replace(/[.,;:!?]+$/, "");
    if (
      looksLikePath(value) &&
      (!value.includes("/") ||
        looksLikePath(value.slice(value.lastIndexOf("/") + 1)))
    )
      found.add(value);
  }
  return [...found];
}

function questionText(question: Question): string {
  const criteria = question.criteria;
  return [
    question.instructions,
    ...(criteria ? Object.values(criteria) : []),
  ].join("\n");
}

function readingTexts(plan: CompiledAsks): { id: string; text: string }[] {
  return plan.readings.map((reading) => ({
    id: reading.id,
    text: [reading.id, reading.twin, ...Object.values(reading.controls ?? {})]
      .flatMap((id) =>
        id && plan.questions[id] ? [questionText(plan.questions[id])] : [],
      )
      .join("\n"),
  }));
}

function normalized(path: string): string {
  return path.replace(/^(?:\.\/)+/, "");
}

export function resolveAskReferences(
  plan: CompiledAsks,
  note: string | undefined,
  files: Readonly<Record<string, string>>,
  inventory: readonly string[],
): {
  additions: readonly { reference: string; path: string }[];
  unresolved: readonly UnresolvedAskReference[];
} {
  const references = new Set(
    readingTexts(plan).flatMap(({ text }) => citedPaths(text)),
  );
  for (const reference of citedPaths(note ?? "")) references.add(reference);
  const paths = [...new Set([...inventory, ...Object.keys(files)])];
  const exact = new Map(paths.map((path) => [normalized(path), path]));
  const selected = new Set(Object.keys(files).map(normalized));
  const additions: { reference: string; path: string }[] = [];
  const unresolved: UnresolvedAskReference[] = [];
  for (const reference of references) {
    if (Object.hasOwn(files, reference)) continue;
    const key = normalized(reference);
    const direct = exact.get(key);
    const matches = direct
      ? [direct]
      : paths.filter((path) => normalized(path).endsWith(`/${key}`));
    if (matches.length !== 1) {
      unresolved.push({
        reference,
        reason: `${reference} is cited but missing from state (${matches.length ? "ambiguous path" : "not found"})`,
      });
      continue;
    }
    const path = matches[0];
    if (path === undefined) continue;
    if (!selected.has(normalized(path)) && selected.size >= ASK_MAX_FILES) {
      unresolved.push({
        reference,
        reason: `${reference} is cited but missing from state (ASK_MAX_FILES limit: ${ASK_MAX_FILES})`,
      });
      continue;
    }
    selected.add(normalized(path));
    additions.push({ reference, path });
  }
  return { additions, unresolved };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function unpack(value: unknown): unknown {
  if (typeof value !== "string" || !/^[\s]*[[{]/.test(value)) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function empty(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (object(value) && Object.keys(value).length === 0)
  );
}

function emptyReference(text: string, state: State): string | undefined {
  // File references can be plain paths, not just selectors.
  const files = state.files;
  if (object(files)) {
    for (const reference of citedPaths(text)) {
      if (Object.hasOwn(files, reference) && empty(files[reference]))
        return reference;
    }
  }
  for (const match of text.matchAll(selector)) {
    const parts = [
      ...match[0].matchAll(
        /[A-Za-z_$][\w$]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\d+/g,
      ),
    ].map(([part]) => (/^["']/.test(part) ? unquote(part) : part));
    const root = parts[0];
    if (root === undefined) continue;
    let value: unknown;
    let offset: number;
    if (root === "state") {
      value = state;
      offset = 1;
    } else if (Object.hasOwn(state, root)) {
      value = state[root];
      offset = 1;
    } else continue;
    let present = true;
    for (const part of parts.slice(offset)) {
      value = unpack(value);
      if (!object(value) || !Object.hasOwn(value, part)) {
        present = false;
        break;
      }
      value = value[part];
    }
    // A file absent from the base proves creation; it is not empty evidence.
    if (root === "files_before" && value === null) continue;
    if (present && empty(unpack(value))) return match[0].trim();
  }
  return undefined;
}

export function blockedAskReadings(
  plan: CompiledAsks,
  state: State,
  unresolved: readonly UnresolvedAskReference[],
  note?: string,
): ReadonlyMap<string, string> {
  const blocked = new Map<string, string>();
  const notePaths = new Set(citedPaths(note ?? ""));
  const noteEmpty = emptyReference(note ?? "", state);
  for (const { id, text } of readingTexts(plan)) {
    const paths = new Set(citedPaths(text));
    const missing = unresolved.find(
      ({ reference }) => paths.has(reference) || notePaths.has(reference),
    );
    if (missing) {
      blocked.set(id, missing.reason);
      continue;
    }
    const reference = noteEmpty ?? emptyReference(text, state);
    if (reference) blocked.set(id, `${reference} is empty`);
  }
  return blocked;
}
