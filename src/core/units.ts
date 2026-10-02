import { UNIT_CONTEXT_LINES, UNIT_MAX_CHARS } from "../constants.ts";
import { type DiffFile, isTestFile } from "./diff.ts";
import { truncate } from "./truncate.ts";

export interface SourceFile extends DiffFile {
  before: string | null;
  after: string | null;
  limitation?: "too_large" | "unreadable" | "not UTF-8 text";
}
export interface Declaration {
  kind: "function" | "declaration";
  name: string;
  exported: boolean;
  start: number;
  end: number;
  /** Syntax type disambiguates declarations sharing a qualified name. */
  type?: string;
  signatureEnd?: number;
  /** Token-normalized body; literal contents are preserved. */
  body?: string;
}
export interface DeclarationResult {
  declarations: Declaration[];
  limits: (
    | { kind: "parse_failed" }
    | { kind: "parse_partial"; declaration?: string }
  )[];
}
export interface SyntaxParser {
  declarations(
    path: string,
    text: string,
    options?: { descendAbove?: number },
  ): DeclarationResult;
  supports(path: string): boolean;
}
export type UnitLimit =
  | { kind: "grammar_absent"; file: string; language: string }
  | {
      kind:
        | "parse_failed"
        | "binary_ignored"
        | "too_large"
        | "unreadable"
        | "not UTF-8 text"
        | "rename_unpaired";
      file: string;
    }
  | { kind: "truncated"; file: string; unit: string }
  | { kind: "parse_partial"; file: string; declaration?: string };
export interface EvidenceUnit {
  id: string;
  kind: "function" | "slice" | "declaration" | "file" | "hunk";
  file: string;
  name: string;
  exported: boolean;
  before: string | null;
  after: string | null;
  beforeRange: { start: number; end: number } | null;
  afterRange: { start: number; end: number } | null;
}
const code = /\.(?:[cm]?[jt]sx?|py)$/;
function lines(text: string | null): string[] {
  return text === null ? [] : text.split("\n");
}
function overlaps(
  start: number,
  end: number,
  point: number,
  count: number,
): boolean {
  return count
    ? point <= end && point + count - 1 >= start
    : point > start && point <= end;
}
/** Conservative fallback: unknown regions remain hunks, never disappear. */
export function heuristicDeclarations(
  path: string,
  text: string,
): Declaration[] {
  const source = lines(text);
  const result: Declaration[] = [];
  const python = path.endsWith(".py");
  for (let i = 0; i < source.length; i++) {
    const line = source[i] ?? "";
    const match = python
      ? /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(line)
      : /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)/.exec(
          line,
        );
    const declaration = python
      ? /^(\w+)\s*(?::[^=]+)?=/.exec(line)
      : /^\s*(?:export\s+)?(?:const|let|var|type|interface|enum)\s+(\w+)/.exec(
          line,
        );
    if (!match && !declaration) continue;
    let start = i;
    let end = i;
    if (python && match) {
      const indent = (match[1] ?? "").length;
      while (start > 0 && (source[start - 1] ?? "").trim().startsWith("@"))
        start--;
      while (
        end + 1 < source.length &&
        (!(source[end + 1] ?? "").trim() ||
          (source[end + 1] ?? "").search(/\S/) > indent)
      )
        end++;
    } else if (!python) {
      let depth = 0;
      let opened = false;
      for (let j = i; j < source.length; j++) {
        for (const char of source[j] ?? "") {
          if (char === "{") {
            depth++;
            opened = true;
          } else if (char === "}") depth--;
        }
        end = j;
        if (
          (opened && depth <= 0) ||
          (!opened && /;\s*$/.test(source[j] ?? ""))
        )
          break;
        if (!opened && j === i && !match) break;
      }
    }
    result.push({
      kind: match ? "function" : "declaration",
      name: match
        ? (match[python ? 2 : 1] ?? "function")
        : (declaration?.[1] ?? "declaration"),
      exported: python
        ? !line.trim().startsWith("def _")
        : /\bexport\b/.test(line),
      start: start + 1,
      end: end + 1,
    });
    i = end;
  }
  return result;
}

export function buildUnits(
  files: readonly SourceFile[],
  parser?: SyntaxParser,
): { units: EvidenceUnit[]; limits: UnitLimit[] } {
  const units: EvidenceUnit[] = [];
  const limits: UnitLimit[] = [];
  for (const file of files) {
    if (isTestFile(file.path)) continue;
    if (file.binary) {
      limits.push({ kind: "binary_ignored", file: file.path });
      continue;
    }
    if (file.limitation) {
      limits.push({ kind: file.limitation, file: file.path });
      if (
        file.limitation === "too_large" ||
        file.limitation === "not UTF-8 text"
      ) {
        for (const hunk of file.hunks) {
          const id = `u${String(units.length + 1).padStart(3, "0")}`;
          const before = /^[A?]/.test(file.status)
            ? null
            : (hunk.beforeText ?? null);
          const after = file.status === "D" ? null : (hunk.afterText ?? null);
          const budget =
            before === null
              ? 0
              : after === null
                ? UNIT_MAX_CHARS
                : Math.floor(UNIT_MAX_CHARS / 2);
          units.push({
            id,
            kind: "hunk",
            file: file.path,
            name: `${file.path}:${hunk.afterStart}`,
            exported: false,
            before: before === null ? null : truncate(before, budget),
            after:
              after === null
                ? null
                : truncate(
                    after,
                    UNIT_MAX_CHARS - Math.min(before?.length ?? 0, budget),
                  ),
            beforeRange:
              before === null
                ? null
                : {
                    start: hunk.beforeStart,
                    end: hunk.beforeStart + hunk.beforeCount - 1,
                  },
            afterRange:
              after === null
                ? null
                : {
                    start: hunk.afterStart,
                    end: hunk.afterStart + hunk.afterCount - 1,
                  },
          });
          if (
            hunk.truncated ||
            (before?.length ?? 0) + (after?.length ?? 0) > UNIT_MAX_CHARS
          )
            limits.push({ kind: "truncated", file: file.path, unit: id });
        }
      }
      continue;
    }
    const oldLines = lines(file.before);
    const newLines = lines(file.after);
    const changes = file.hunks.flatMap((hunk) => hunk.changes);
    if (
      !changes.length &&
      (file.before !== file.after || /^[RC]/.test(file.status))
    )
      changes.push({
        beforeStart: 1,
        beforeCount: oldLines.length,
        afterStart: 1,
        afterCount: newLines.length,
      });
    if (!changes.length) continue;
    const add = (
      kind: EvidenceUnit["kind"],
      name: string,
      exported: boolean,
      oldRange: EvidenceUnit["beforeRange"],
      newRange: EvidenceUnit["afterRange"],
    ) => {
      const excerpt = (
        source: string[],
        range: EvidenceUnit["beforeRange"],
      ): string | null => {
        if (!range) return null;
        return source.slice(range.start - 1, range.end).join("\n");
      };
      let before = excerpt(oldLines, oldRange);
      let after = excerpt(newLines, newRange);
      const id = `u${String(units.length + 1).padStart(3, "0")}`;
      const total = (before?.length ?? 0) + (after?.length ?? 0);
      if (total > UNIT_MAX_CHARS) {
        const beforeBudget =
          before === null
            ? 0
            : after === null
              ? UNIT_MAX_CHARS
              : Math.floor(UNIT_MAX_CHARS / 2);
        if (before !== null) before = truncate(before, beforeBudget);
        if (after !== null)
          after = truncate(after, UNIT_MAX_CHARS - (before?.length ?? 0));
        limits.push({ kind: "truncated", file: file.path, unit: id });
      }
      units.push({
        id,
        kind,
        file: file.path,
        name,
        exported,
        before,
        after,
        beforeRange: oldRange,
        afterRange: newRange,
      });
    };
    if (
      !code.test(file.path) &&
      (file.before?.length ?? 0) + (file.after?.length ?? 0) <= UNIT_MAX_CHARS
    ) {
      add(
        "file",
        file.path,
        false,
        file.before === null ? null : { start: 1, end: oldLines.length },
        file.after === null ? null : { start: 1, end: newLines.length },
      );
      continue;
    }
    const declarations = (text: string | null, path: string) => {
      if (text === null || !code.test(path)) return [];
      if (parser?.supports(path)) {
        const result = parser.declarations(path, text);
        for (const limit of result.limits) {
          if (
            !limits.some(
              (existing) =>
                existing.kind === limit.kind &&
                existing.file === path &&
                (limit.kind !== "parse_partial" ||
                  (existing.kind === "parse_partial" &&
                    existing.declaration === limit.declaration)),
            )
          )
            limits.push({ ...limit, file: path });
        }
        if (!result.limits.some((limit) => limit.kind === "parse_failed"))
          return result.declarations;
      } else if (
        !limits.some(
          (limit) =>
            limit.kind === "grammar_absent" && limit.file === file.path,
        )
      )
        limits.push({
          kind: "grammar_absent",
          file: file.path,
          language: path.endsWith(".py") ? "Python" : "JavaScript/TypeScript",
        });
      return heuristicDeclarations(path, text);
    };
    const beforeDeclarations = declarations(file.before, file.oldPath);
    const afterDeclarations = declarations(file.after, file.path);
    const key = (d: Declaration) => `${d.type ?? d.kind}:${d.name}`;
    const pairedAfter = new Set<Declaration>();
    const selected: { before?: Declaration; after?: Declaration }[] = [];
    for (const before of beforeDeclarations) {
      const after = afterDeclarations.find(
        (d) => !pairedAfter.has(d) && key(d) === key(before),
      );
      if (after) pairedAfter.add(after);
      selected.push({ before, after });
    }
    for (const pair of selected) {
      const before = pair.before;
      if (
        pair.after ||
        before?.kind !== "function" ||
        before.body === undefined
      )
        continue;
      const after = afterDeclarations.find(
        (d) =>
          !pairedAfter.has(d) &&
          d.kind === "function" &&
          d.type === before.type &&
          d.body === before.body,
      );
      if (after) {
        pair.after = after;
        pairedAfter.add(after);
      }
    }
    for (const after of afterDeclarations)
      if (!pairedAfter.has(after)) selected.push({ after });
    const touched = (d: Declaration | undefined, side: "before" | "after") =>
      d !== undefined &&
      changes.some((c) =>
        overlaps(d.start, d.end, c[`${side}Start`], c[`${side}Count`]),
      );
    const changed = selected.filter(
      (pair) => touched(pair.before, "before") || touched(pair.after, "after"),
    );
    if (
      changed.some((p) => p.before?.kind === "function" && !p.after) &&
      changed.some((p) => p.after?.kind === "function" && !p.before)
    )
      limits.push({ kind: "rename_unpaired", file: file.path });
    for (const pair of changed) {
      const declaration = pair.after ?? pair.before;
      if (!declaration) continue;
      const name = declaration.name;
      const size =
        (pair.before
          ? oldLines.slice(pair.before.start - 1, pair.before.end).join("\n")
              .length
          : 0) +
        (pair.after
          ? newLines.slice(pair.after.start - 1, pair.after.end).join("\n")
              .length
          : 0);
      const large = size > UNIT_MAX_CHARS;
      const relevant = changes.filter(
        (c) =>
          (pair.before &&
            overlaps(
              pair.before.start,
              pair.before.end,
              c.beforeStart,
              c.beforeCount,
            )) ||
          (pair.after &&
            overlaps(
              pair.after.start,
              pair.after.end,
              c.afterStart,
              c.afterCount,
            )),
      );
      const zones: (typeof changes)[] = [];
      for (const change of relevant) {
        const previous = zones[zones.length - 1];
        const last = previous?.[previous.length - 1];
        if (
          last &&
          change.beforeStart <=
            last.beforeStart + last.beforeCount + 2 * UNIT_CONTEXT_LINES &&
          change.afterStart <=
            last.afterStart + last.afterCount + 2 * UNIT_CONTEXT_LINES
        )
          previous?.push(change);
        else zones.push([change]);
      }
      for (const zone of large ? zones : [relevant]) {
        const range = (
          d: Declaration | undefined,
          side: "before" | "after",
        ) => {
          if (!d) return null;
          if (!large) return { start: d.start, end: d.end };
          return {
            start: Math.max(
              d.start,
              Math.min(...zone.map((c) => c[`${side}Start`])) -
                UNIT_CONTEXT_LINES,
            ),
            end: Math.min(
              d.end,
              Math.max(
                ...zone.map(
                  (c) => c[`${side}Start`] + Math.max(1, c[`${side}Count`]) - 1,
                ),
              ) + UNIT_CONTEXT_LINES,
            ),
          };
        };
        add(
          large ? "slice" : declaration.kind,
          name,
          declaration.exported,
          range(pair.before, "before"),
          range(pair.after, "after"),
        );
        if (!large) continue;
        const unit = units[units.length - 1];
        if (!unit) continue;
        const omission = file.path.endsWith(".py")
          ? "# … omitted …"
          : "// … omitted …";
        for (const side of ["before", "after"] as const) {
          const d = pair[side];
          const r = unit[`${side}Range`];
          const source = side === "before" ? oldLines : newLines;
          if (!d || !r || unit[side] === null) continue;
          const signatureEnd = d.signatureEnd ?? d.start;
          if (r.start > d.start) {
            const signature = source
              .slice(d.start - 1, Math.min(signatureEnd, r.start - 1))
              .join("\n");
            unit[side] =
              `${signature}\n${r.start > signatureEnd + 1 ? `${omission}\n` : ""}${unit[side]}`;
          }
          if (r.end < d.end) unit[side] += `\n${omission}`;
        }
        if (
          (unit.before?.length ?? 0) + (unit.after?.length ?? 0) >
          UNIT_MAX_CHARS
        ) {
          const budget =
            unit.after === null
              ? UNIT_MAX_CHARS
              : unit.before === null
                ? 0
                : Math.floor(UNIT_MAX_CHARS / 2);
          if (unit.before !== null) unit.before = truncate(unit.before, budget);
          if (unit.after !== null)
            unit.after = truncate(
              unit.after,
              UNIT_MAX_CHARS - (unit.before?.length ?? 0),
            );
          if (!limits.some((l) => l.kind === "truncated" && l.unit === unit.id))
            limits.push({ kind: "truncated", file: file.path, unit: unit.id });
        }
      }
    }
    for (const change of changes) {
      const contains = (
        declarations: Declaration[],
        source: string[],
        start: number,
        count: number,
      ) =>
        count === 0 ||
        source
          .slice(Math.max(0, start - 1), start + count - 1)
          .every(
            (line, offset) =>
              !line.trim() ||
              declarations.some(
                (d) => d.start <= start + offset && d.end >= start + offset,
              ),
          );
      const covered =
        (file.before === null ||
          contains(
            beforeDeclarations,
            oldLines,
            change.beforeStart,
            change.beforeCount,
          )) &&
        (file.after === null ||
          contains(
            afterDeclarations,
            newLines,
            change.afterStart,
            change.afterCount,
          ));
      if (covered) continue;
      const range = (start: number, count: number, length: number) => ({
        start: Math.max(1, start - UNIT_CONTEXT_LINES),
        end: Math.min(
          length,
          start + Math.max(1, count) - 1 + UNIT_CONTEXT_LINES,
        ),
      });
      add(
        "hunk",
        `${file.path}:${change.afterStart}`,
        false,
        file.before === null
          ? null
          : range(change.beforeStart, change.beforeCount, oldLines.length),
        file.after === null
          ? null
          : range(change.afterStart, change.afterCount, newLines.length),
      );
    }
  }
  return { units, limits };
}
