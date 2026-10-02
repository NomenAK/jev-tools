import {
  DOCS_ANCHOR_MAX_FILES,
  DOCS_MAX_SECTIONS,
  DOCS_NAME_MAX_FILES,
} from "../constants.ts";
import {
  createImportGraphBuilder,
  type ImportGraph,
  type ImportSource,
  importClosureLazy,
} from "./imports.ts";
import type { LexicalSource } from "./lexical.ts";
import { markdownSections } from "./sections.ts";
import type { EvidenceUnit, SourceFile } from "./units.ts";

export interface DocSentence {
  id: string;
  text: string;
}
export interface DocsCandidate {
  path: string;
  heading: string;
  start: number;
  end: number;
  sentences: readonly DocSentence[];
  units: readonly EvidenceUnit[];
}

export interface DocsCandidates {
  candidates: DocsCandidate[];
  omitted: DocsCandidate[];
  limits: {
    path: string;
    reason: string;
    kind?: "collection_budget";
    sections?: string[];
  }[];
}
/** Sentences retain verbatim text, including Markdown and code; no paraphrase enters a pointer. */
export function docSentences(text: string): DocSentence[] {
  const result: DocSentence[] = [];
  let fence: { marker: string; length: number } | undefined;
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence)
        fence = {
          marker: marker[1]?.[0] ?? "`",
          length: marker[1]?.length ?? 3,
        };
      else if (
        marker[1]?.[0] === fence.marker &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      )
        fence = undefined;
      current.push(line);
      continue;
    }
    if (!fence && !line.trim()) {
      if (current.length) paragraphs.push(current.join("\n"));
      current = [];
    } else current.push(line);
  }
  if (current.length) paragraphs.push(current.join("\n"));
  for (const paragraph of paragraphs) {
    // A fenced block remains one exact piece; punctuation in code is never a sentence boundary.
    const pieces = /^ {0,3}(?:`{3,}|~{3,})/m.test(paragraph)
      ? [paragraph]
      : paragraph.split(/(?<=[.!?])(?:[\t ]+|\n)(?=[A-ZÀ-ÖØ-Þ`*])/u);
    for (const text of pieces)
      if (text.trim()) result.push({ id: `s${result.length + 1}`, text });
  }
  return result;
}
export function inlineDocIdentifiers(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/(?<!`)`([A-Za-z_$][\w$]{2,})`(?!`)/g)].map(
        (match) => match[1] ?? "",
      ),
    ),
  ];
}

export function docsDeclarationPattern(
  name: string | readonly string[],
): string {
  const names = typeof name === "string" ? [name] : name;
  const escaped = names
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return `(?:\\b(?:export|const|let|var|function|class|type|interface|enum|def)\\s+(?:(?:default|async|function|const|class)\\s+)*(${escaped})(?:[^\\w$]|$)|^\\s*(?:(?:public|private|protected|static|async)\\s+)*(${escaped})\\s*\\([^;]*\\)\\s*(?::[^={]+)?\\s*[{])`;
}

export function attributeDocsDeclarations(
  names: readonly string[],
  rows: readonly { path: string; text: string }[],
): ReadonlyMap<string, readonly string[]> {
  const owners = new Map(names.map((name) => [name, new Set<string>()]));
  if (!names.length) return new Map();
  const pattern = new RegExp(docsDeclarationPattern(names), "gm");
  for (const row of rows)
    for (const match of row.text.matchAll(pattern)) {
      const paths = owners.get(match[1] ?? match[2] ?? "");
      if (paths && paths.size <= DOCS_NAME_MAX_FILES) paths.add(row.path);
    }
  const result = new Map<string, readonly string[]>(
    [...owners].map(([name, paths]) => [name, [...paths]]),
  );
  return result;
}

export async function collectDocsCandidates(
  files: readonly ImportSource[],
  units: readonly EvidenceUnit[],
  sources: {
    known: ReadonlySet<string>;
    read: (path: string) => Promise<ImportSource | undefined>;
    declarations?: (
      names: readonly string[],
    ) => Promise<ReadonlyMap<string, readonly string[]>>;
    changedFiles?: readonly SourceFile[];
    shouldStop?: () => boolean;
    lexical?: LexicalSource;
  },
): Promise<DocsCandidates> {
  const candidates: DocsCandidate[] = [];
  const omitted: DocsCandidate[] = [];
  const limits: DocsCandidates["limits"] = [];
  const sections = files
    .filter((file) => /\.(?:md|mdx|markdown)$/i.test(file.path))
    .flatMap((file) =>
      markdownSections(file.text).map((section) => ({
        file: file.path,
        identifiers: new Set(inlineDocIdentifiers(section.text)),
        ...section,
        paths: [
          ...new Set(
            (section.text.match(/[A-Za-z0-9_@./-]+/g) ?? [])
              .map((path) =>
                sources.known.has(path) ? path : path.replace(/\.+$/, ""),
              )
              .filter((path) => sources.known.has(path)),
          ),
        ],
      })),
    );
  const selectedSections = new Set<number>();
  const reachable = new Map<string, Set<EvidenceUnit>>();
  for (const unit of units) {
    const selected = reachable.get(unit.file) ?? new Set<EvidenceUnit>();
    selected.add(unit);
    reachable.set(unit.file, selected);
  }
  const match = (
    paths: ReadonlyMap<string, Set<EvidenceUnit>>,
    names: ReadonlyMap<string, Set<EvidenceUnit>>,
  ) => {
    // Paths outrank names within each proximity level; already selected sections never move.
    for (const anchors of [paths, names]) {
      if (!anchors.size) continue;
      for (let index = 0; index < sections.length; index++) {
        if (selectedSections.has(index)) continue;
        const section = sections[index];
        if (!section) continue;
        const selected = new Set<EvidenceUnit>();
        const identifiers = anchors === names ? section.identifiers : undefined;
        for (const [anchor, values] of anchors) {
          if (
            identifiers
              ? identifiers.has(anchor)
              : section.text.includes(anchor)
          )
            for (const unit of values) selected.add(unit);
        }
        if (!selected.size) continue;
        selectedSections.add(index);
        const candidate = {
          path: section.file,
          heading: section.label,
          start: section.start,
          end: section.end,
          sentences: docSentences(section.text),
          units: units.filter((unit) => selected.has(unit)),
        };
        (candidates.length < DOCS_MAX_SECTIONS ? candidates : omitted).push(
          candidate,
        );
      }
    }
  };
  const initialNames = new Map<string, Set<EvidenceUnit>>();
  for (const unit of units) {
    const selected = initialNames.get(unit.name) ?? new Set<EvidenceUnit>();
    selected.add(unit);
    initialNames.set(unit.name, selected);
  }
  for (const file of sources.changedFiles ?? []) {
    const changed = file.hunks
      .flatMap((hunk) =>
        hunk.changes.flatMap((change) => [
          ...(file.before
            ?.split("\n")
            .slice(
              change.beforeStart - 1,
              change.beforeStart - 1 + change.beforeCount,
            ) ?? []),
          ...(file.after
            ?.split("\n")
            .slice(
              change.afterStart - 1,
              change.afterStart - 1 + change.afterCount,
            ) ?? []),
        ]),
      )
      .join("\n");
    for (const section of sections)
      for (const literal of section.text.matchAll(
        /(?<!`)`([^`\n]{3,})`(?!`)/g,
      )) {
        const text = literal[1] ?? "";
        if (!/[^A-Za-z ]/.test(text) || !changed.includes(text)) continue;
        const matching = units.filter((unit) => unit.file === file.path);
        if (!matching.length) continue;
        const selected = initialNames.get(text) ?? new Set<EvidenceUnit>();
        for (const unit of matching) selected.add(unit);
        initialNames.set(text, selected);
        section.identifiers.add(text);
      }
  }
  match(reachable, initialNames);
  if (candidates.length >= DOCS_MAX_SECTIONS) {
    const unchecked = sections.filter(
      (section, index) =>
        !selectedSections.has(index) &&
        (section.paths.length || section.identifiers.size),
    );
    if (unchecked.length)
      limits.push({
        path: "documentation",
        kind: "collection_budget",
        reason: "Candidate limit reached: documentation anchors unexplored.",
        sections: unchecked.map(
          (section) => `${section.file} § ${section.label}`,
        ),
      });
    return { candidates, omitted, limits };
  }
  const configuration = files.filter((file) =>
    /(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(file.path),
  );
  const cache = new Map<string, Promise<ImportGraph>>();
  const build = createImportGraphBuilder(
    configuration,
    sources.known,
    sources.lexical,
  );
  const modified = new Map(reachable);
  const pending = sections.map((section, index) => ({ section, index }));
  pending.sort(
    (a, b) =>
      Number(b.section.paths.length > 0) - Number(a.section.paths.length > 0),
  );
  const names = [
    ...new Set(pending.flatMap(({ section }) => [...section.identifiers])),
  ];
  // The adapter performs one declarative search; no source is parsed to establish ownership.
  const owners = sources.declarations
    ? await sources.declarations(names)
    : new Map<string, readonly string[]>();
  const anchors = new Map<string, Set<number>>();
  for (const { section, index } of pending) {
    const paths = new Set(section.paths);
    for (const name of section.identifiers) {
      const pathsForName = owners.get(name) ?? [];
      if (
        pathsForName.length === 1 &&
        pathsForName.length <= DOCS_NAME_MAX_FILES
      )
        for (const path of pathsForName) paths.add(path);
    }
    for (const path of paths) {
      const indices = anchors.get(path) ?? new Set<number>();
      indices.add(index);
      anchors.set(path, indices);
    }
  }
  const directory = (path: string) =>
    path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const packageRoots = configuration
    .filter((file) => /(?:^|\/)package\.json$/.test(file.path))
    .map((file) => directory(file.path))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const packageRoot = (path: string) =>
    packageRoots.find((root) => path.startsWith(`${root}/`));
  const modifiedDirectories = new Set([...modified.keys()].map(directory));
  const modifiedPackages = new Set(
    [...modified.keys()].map(packageRoot).filter(Boolean),
  );
  const proximity = (path: string) =>
    modifiedDirectories.has(directory(path))
      ? 0
      : modifiedPackages.has(packageRoot(path))
        ? 1
        : 2;
  const orderedAnchors = [...anchors].sort(
    ([a], [b]) => proximity(a) - proximity(b),
  );
  let interrupted = false;
  const undecided = new Set<number>(
    [...anchors.values()].flatMap((indices) => [...indices]),
  );
  const remaining = new Map<number, number>();
  for (const indices of anchors.values())
    for (const index of indices)
      remaining.set(index, (remaining.get(index) ?? 0) + 1);
  for (const [anchor, indices] of orderedAnchors) {
    if (candidates.length >= DOCS_MAX_SECTIONS) {
      interrupted = true;
      break;
    }
    let visited = 0;
    let anchorLimited = false;
    const selected = new Set<EvidenceUnit>();
    const closure = await importClosureLazy(sources.read, anchor, {
      known: sources.known,
      configuration,
      cache,
      build,
      stop: (path) => {
        if (path !== anchor && modified.has(path)) return true;
        if (sources.shouldStop?.()) {
          interrupted = true;
          return true;
        }
        if (visited >= DOCS_ANCHOR_MAX_FILES) {
          anchorLimited = true;
          return true;
        }
        visited++;
        return false;
      },
    });
    for (const path of closure.paths)
      for (const unit of modified.get(path) ?? []) selected.add(unit);
    if (selected.size) {
      for (const index of indices) {
        const section = sections[index];
        if (!section) continue;
        if (selectedSections.has(index)) {
          const existing = [...candidates, ...omitted].find(
            (candidate) =>
              candidate.path === section.file &&
              candidate.start === section.start,
          );
          if (existing) {
            const combined = new Set([...existing.units, ...selected]);
            existing.units = units.filter((unit) => combined.has(unit));
          }
          continue;
        }
        selectedSections.add(index);
        const candidate = {
          path: section.file,
          heading: section.label,
          start: section.start,
          end: section.end,
          sentences: docSentences(section.text),
          units: units.filter((unit) => selected.has(unit)),
        };
        (candidates.length < DOCS_MAX_SECTIONS ? candidates : omitted).push(
          candidate,
        );
      }
    }
    if (!interrupted && !anchorLimited)
      for (const index of indices) {
        const count = (remaining.get(index) ?? 1) - 1;
        remaining.set(index, count);
        if (count === 0) undecided.delete(index);
      }
    if (interrupted) break;
  }
  if (interrupted || undecided.size)
    limits.push({
      path: "documentation",
      kind: "collection_budget",
      reason:
        "Dependency exploration incomplete: collection budget, candidate limit, or per-anchor bound reached.",
      sections: [...undecided]
        .filter((index) => !selectedSections.has(index))
        .map((index) => `${sections[index]?.file} § ${sections[index]?.label}`),
    });
  return { candidates, omitted, limits };
}
