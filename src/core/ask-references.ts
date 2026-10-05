import { ASK_MAX_FILES } from "../constants.ts";
import type { Question, State } from "../jev/types.ts";
import type { CompiledAsks } from "./asks.ts";

export interface UnresolvedAskReference {
  reference: string;
  reason: string;
  required?: boolean;
  origin?: "question" | "note";
  scope?: string;
  side?: "files" | "files_before";
}
export interface EvidenceIndex {
  files: Readonly<Record<string, string>>;
  files_before?: Readonly<Record<string, string | null>>;
  beforeInventory?: readonly string[];
  aliases?: Readonly<Record<string, string | readonly string[]>>;
}
export interface ReferenceResolution {
  additions: readonly {
    reference: string;
    path: string;
    required: boolean;
    origin: "question" | "note";
    scope: string;
    side: "files" | "files_before";
  }[];
  unresolved: readonly UnresolvedAskReference[];
  aliases: Readonly<Record<string, string>>;
  invalid: readonly UnresolvedAskReference[];
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
      /* retain the literal selector */
    }
  }
  return value.slice(1, -1).replace(/\\(['\\])/g, "$1");
}
function normalized(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}
function forbidden(path: string): boolean {
  return (
    /^(?:\/|[A-Za-z]:|[a-z][a-z\d+.-]*:\/\/)/i.test(path) ||
    path.split(/[\\/]/).some((part) => part === ".." || part === ".git")
  );
}
function explicitPaths(
  text: string,
): { reference: string; side: "files" | "files_before" }[] {
  const references = new Map<
    string,
    { reference: string; side: "files" | "files_before" }
  >();
  for (const match of text.matchAll(fileSelector)) {
    const reference = unquote(match[2] ?? "");
    const side = match[1] as "files" | "files_before";
    references.set(JSON.stringify([side, reference]), { reference, side });
  }
  return [...references.values()];
}
/** Lexical discovery hints, never requirements. Ordinary member expressions are excluded. */
export function citedPaths(text: string): string[] {
  const found = new Set(explicitPaths(text).map(({ reference }) => reference));
  const cleaned = text
    .replace(/\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>"'`]+/gi, " ")
    .replace(fileSelector, " ")
    .replace(selector, (value) =>
      value.includes("[") ||
      /^(?:state|output|docs?|files|files_before)\./.test(value)
        ? " "
        : value,
    );
  for (const match of cleaned.matchAll(
    /`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'/g,
  )) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (/^(?:[\w@+-]+\/)+[\w.@+-]+$/.test(value)) found.add(value);
  }
  for (const match of cleaned.matchAll(
    /\b(?:README|LICENSE|LICENCE|Makefile|Dockerfile|CHANGELOG|AGENTS|CLAUDE)(?:\.[\w-]+)?\b/g,
  ))
    found.add(match[0]);
  for (const match of cleaned.matchAll(
    /(?:\.?\.?\/)?[\w@+-]+(?:\/[\w.@+-]+)*\.(?:[cm]?[jt]sx?|py|jsonc?|ya?ml|toml|ini|cfg|conf|mdx?|txt|rst|html?|css|scss|sql|sh|bash|rs|go|java|rb|php|cpp|hpp|vue|svelte|xml|csv|lock)\b/g,
  )) {
    const start = match.index ?? 0;
    if (
      (start && /[\w.]/.test(cleaned[start - 1] ?? "")) ||
      /^(?:Node|Next|Vue)\.js$/i.test(match[0])
    )
      continue;
    found.add(match[0]);
  }
  return [...found];
}
function questionText(question: Question): string {
  return [
    question.instructions,
    ...Object.values(question.criteria ?? {}),
  ].join("\n");
}
function readingTexts(
  plan: CompiledAsks,
): { id: string; text: string; about?: string }[] {
  return plan.readings.map((reading) => ({
    id: reading.id,
    about: plan.asks[reading.askIndex]?.about,
    text: [reading.id, reading.twin, ...Object.values(reading.controls ?? {})]
      .flatMap((id) =>
        id && plan.questions[id] ? [questionText(plan.questions[id])] : [],
      )
      .join("\n"),
  }));
}
export function resolveAskReferences(
  plan: CompiledAsks,
  note: string | undefined,
  evidence: EvidenceIndex | Readonly<Record<string, string>>,
  inventory: readonly string[],
): ReferenceResolution {
  const index: EvidenceIndex =
    evidence.files !== null && typeof evidence.files === "object"
      ? (evidence as EvidenceIndex)
      : { files: evidence as Readonly<Record<string, string>> };
  const supplied = [
    ...new Set([
      ...Object.keys(index.files),
      ...Object.keys(index.files_before ?? {}),
    ]),
  ].sort();
  const currentKnown = [...new Set(inventory)].sort();
  const beforeKnown = [
    ...new Set([...inventory, ...(index.beforeInventory ?? [])]),
  ].sort();
  const selected = new Set(supplied.map(normalized));
  const versions = new Set([
    ...Object.keys(index.files).map((path) => `files:${normalized(path)}`),
    ...Object.keys(index.files_before ?? {}).map(
      (path) => `files_before:${normalized(path)}`,
    ),
  ]);
  const additions: ReferenceResolution["additions"][number][] = [];
  const unresolved: UnresolvedAskReference[] = [];
  const invalid: UnresolvedAskReference[] = [];
  const aliases: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const sources = [
    ...readingTexts(plan).map(({ id, text, about }) => ({
      text: `${about ?? ""}\n${text}`,
      scope: id,
      origin: "question" as const,
      output: about === "output",
    })),
    {
      text: note ?? "",
      scope: "global",
      origin: "note" as const,
      output: false,
    },
  ];
  for (const source of sources) {
    const explicit = explicitPaths(source.text);
    const explicitNames = new Set(explicit.map(({ reference }) => reference));
    const references = [
      ...explicit.map((ref) => ({ ...ref, required: true })),
      ...(source.output
        ? []
        : citedPaths(source.text)
            .filter((reference) => !explicitNames.has(reference))
            .map((reference) => ({
              reference,
              side: "files" as const,
              required: false,
            }))),
    ];
    for (const ref of references) {
      const { reference, required, side } = ref;
      const known = side === "files_before" ? beforeKnown : currentKnown;
      const facts = {
        reference,
        required,
        side,
        origin: source.origin,
        scope: source.scope,
      };
      if (forbidden(reference)) {
        if (required)
          invalid.push({
            ...facts,
            reason: `Path not permitted: ${reference}`,
          });
        continue;
      }
      const key = normalized(reference);
      // Directory-bearing explicit paths are exact, never suffix fallbacks.
      const exact = supplied.find((path) => normalized(path) === key);
      const abbreviated = !key.includes("/");
      let matches: string[] = exact ? [exact] : [];
      if (!matches.length && abbreviated) {
        const alias =
          index.aliases && Object.hasOwn(index.aliases, reference)
            ? index.aliases[reference]
            : undefined;
        if (alias !== undefined)
          matches = (typeof alias === "string" ? [alias] : [...alias]).filter(
            (path) => supplied.includes(path),
          );
        if (!matches.length)
          matches = supplied.filter((path) =>
            normalized(path).endsWith(`/${key}`),
          );
      }
      if (!matches.length)
        matches = known.filter((path) => normalized(path) === key);
      if (!matches.length && abbreviated)
        matches = known.filter((path) => normalized(path).endsWith(`/${key}`));
      if (matches.length !== 1) {
        if (required)
          unresolved.push({
            ...facts,
            reason: `${reference} is required but missing from state (${matches.length ? "ambiguous path" : "not found"})`,
          });
        continue;
      }
      const path = matches[0];
      if (path === undefined) continue;
      aliases[reference] = path;
      const identity = normalized(path);
      const version = `${side}:${identity}`;
      if (versions.has(version)) continue;
      if (!selected.has(identity) && selected.size >= ASK_MAX_FILES) {
        unresolved.push({
          ...facts,
          reason: `${reference} omitted (ASK_MAX_FILES limit: ${ASK_MAX_FILES})`,
        });
        continue;
      }
      selected.add(identity);
      versions.add(version);
      additions.push({ ...facts, path });
    }
  }
  return { additions, unresolved, aliases, invalid };
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
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (object(value) && Object.keys(value).length === 0)
  );
}
function emptyReference(text: string, state: State): string | undefined {
  const metadata = object(state.evidence) ? state.evidence : {};
  const aliases = object(metadata.aliases) ? metadata.aliases : {};
  for (const match of text.matchAll(selector)) {
    const parts = [
      ...match[0].matchAll(
        /[A-Za-z_$][\w$]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\d+/g,
      ),
    ].map(([part]) => (/^["']/.test(part) ? unquote(part) : part));
    const root = parts[0];
    if (!root) continue;
    if (
      !["state", "output", "files", "files_before"].includes(root) &&
      !Object.hasOwn(state, root)
    )
      continue;
    if (!/[.[]/.test(match[0]) && text.trim() !== match[0].trim()) continue;
    let value: unknown =
      root === "state"
        ? Object.hasOwn(state, "state")
          ? state.state
          : state
        : state[root];
    const tail = parts.slice(1);
    if (
      (root === "files" || root === "files_before") &&
      tail[0] &&
      object(value) &&
      !Object.hasOwn(value, tail[0])
    ) {
      const alias = Object.hasOwn(aliases, tail[0])
        ? aliases[tail[0]]
        : undefined;
      if (typeof alias === "string") tail[0] = alias;
    }
    for (const part of tail) {
      value = unpack(value);
      value =
        object(value) && Object.hasOwn(value, part) ? value[part] : undefined;
    }
    // null before is admitted only by the base reader for a tracked-tree absence.
    if (
      root === "files_before" &&
      value === null &&
      typeof state.base_sha === "string" &&
      state.base_sha.length > 0
    )
      continue;
    if (
      empty(root === "files" || root === "files_before" ? value : unpack(value))
    )
      return match[0].trim();
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
  const noteEmpty = emptyReference(note ?? "", state);
  for (const { id, text, about } of readingTexts(plan)) {
    const explicit = new Set(
      explicitPaths(`${about ?? ""}\n${text}`).map(
        ({ reference }) => reference,
      ),
    );
    const missing = unresolved.find(
      (ref) =>
        ref.required !== false &&
        (ref.scope === "global" ||
          ref.scope === id ||
          (ref.scope === undefined && explicit.has(ref.reference))),
    );
    if (missing) {
      blocked.set(id, missing.reason);
      continue;
    }
    const reference =
      noteEmpty ??
      (about ? emptyReference(about, state) : undefined) ??
      emptyReference(text, state);
    if (reference) blocked.set(id, `${reference} is missing or empty`);
  }
  return blocked;
}
