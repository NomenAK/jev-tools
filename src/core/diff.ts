import { UNIT_MAX_CHARS } from "../constants.ts";
import { truncate } from "./truncate.ts";

export interface Hunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  beforeText?: string;
  afterText?: string;
  truncated?: boolean;
  /** Changed lines only, excluding patch context. Zero-count ranges mark insertions. */
  changes: {
    beforeStart: number;
    beforeCount: number;
    afterStart: number;
    afterCount: number;
  }[];
}
export interface DiffFile {
  path: string;
  oldPath: string;
  status: string;
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  added: number;
  deleted: number;
  hunks: Hunk[];
}
export interface DiffInput {
  raw: string;
  numstat: string;
  patch: string;
  untracked?: readonly string[];
  verifyPaths?: boolean;
}

function quotePath(path: string): string {
  if (
    !Array.from(path).some(
      (char) =>
        char.charCodeAt(0) <= 32 ||
        char.charCodeAt(0) >= 127 ||
        char === '"' ||
        char === "\\",
    )
  )
    return path;
  return `"${Array.from(Buffer.from(path))
    .map((byte) =>
      byte === 34
        ? '\\"'
        : byte === 92
          ? "\\\\"
          : byte === 9
            ? "\\t"
            : byte === 10
              ? "\\n"
              : byte === 13
                ? "\\r"
                : byte < 32 || byte >= 127
                  ? `\\${byte.toString(8).padStart(3, "0")}`
                  : String.fromCharCode(byte),
    )
    .join("")}"`;
}
function boundedAppend(text: string | undefined, line: string): string {
  const value = text === undefined ? line : `${text}\n${line}`;
  return truncate(value, UNIT_MAX_CHARS);
}

/** Paths come exclusively from NUL-delimited metadata, never patch headers. */
export function parseDiff(input: DiffInput): DiffFile[] {
  const fields = input.raw.split("\0");
  const files: DiffFile[] = [];
  for (let i = 0; i < fields.length && fields[i]; ) {
    const header = fields[i++] ?? "";
    const match = /^:[0-7]+ [0-7]+ [0-9a-f]+ [0-9a-f]+ ([A-Z][0-9]*)$/.exec(
      header,
    );
    if (!match || fields[i] === undefined)
      throw new Error("Invalid raw diff metadata");
    const oldPath = fields[i++] ?? "";
    const status = match[1] ?? "";
    const path = /^[RC]/.test(status) ? fields[i++] : oldPath;
    if (path === undefined) throw new Error("Missing rename destination");
    files.push({
      path,
      oldPath,
      status,
      oldMode: header.split(" ")[0]?.slice(1),
      newMode: header.split(" ")[1],
      binary: false,
      added: 0,
      deleted: 0,
      hunks: [],
    });
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const stats = input.numstat.split("\0");
  for (let i = 0; i < stats.length && stats[i]; ) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(stats[i++] ?? "");
    if (!match) throw new Error("Invalid numstat metadata");
    let path = match[3] ?? "";
    if (!path) {
      i++;
      path = stats[i++] ?? "";
    }
    const file = byPath.get(path);
    if (!file) throw new Error("Numstat path absent from raw metadata");
    file.binary = match[1] === "-" || match[2] === "-";
    file.added = file.binary ? 0 : Number(match[1]);
    file.deleted = file.binary ? 0 : Number(match[2]);
  }
  let fileIndex = -1;
  let hunk: Hunk | undefined;
  let before = 0;
  let after = 0;
  let change: Hunk["changes"][number] | undefined;
  for (const line of input.patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const header = line.slice("diff --git ".length);
      const verifies = (file: DiffFile) =>
        header === `a/${file.oldPath} b/${file.path}` ||
        header ===
          `${quotePath(`a/${file.oldPath}`)} ${quotePath(`b/${file.path}`)}`;
      const current = files[fileIndex];
      if (!current || !verifies(current)) fileIndex++;
      const next = files[fileIndex];
      if (next && !verifies(next)) {
        const verified = files.findIndex(verifies);
        if (verified >= 0) fileIndex = verified;
      }
      if (
        input.verifyPaths &&
        (!files[fileIndex] || !verifies(files[fileIndex] as DiffFile))
      )
        throw new Error("Patch path absent from raw metadata");
      hunk = undefined;
      change = undefined;
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      hunk = {
        beforeStart: Number(match[1]),
        beforeCount: Number(match[2] ?? 1),
        afterStart: Number(match[3]),
        afterCount: Number(match[4] ?? 1),
        changes: [],
      };
      files[fileIndex]?.hunks.push(hunk);
      before = hunk.beforeStart;
      after = hunk.afterStart;
      change = undefined;
    } else if (
      hunk &&
      (before < hunk.beforeStart + hunk.beforeCount ||
        after < hunk.afterStart + hunk.afterCount) &&
      (line === "" || /^[ +-]/.test(line))
    ) {
      const active = hunk;
      const append = (side: "beforeText" | "afterText") => {
        const text = active[side];
        if (
          (text?.length ?? 0) +
            (text === undefined ? 0 : 1) +
            Math.max(0, line.length - 1) >
          UNIT_MAX_CHARS
        )
          active.truncated = true;
        active[side] = boundedAppend(text, line.slice(1));
      };
      if (line === "" || line[0] === " ") {
        append("beforeText");
        append("afterText");
        before++;
        after++;
        change = undefined;
      } else {
        if (!change) {
          change = {
            beforeStart: before,
            beforeCount: 0,
            afterStart: after,
            afterCount: 0,
          };
          hunk.changes.push(change);
        }
        if (line[0] === "-") {
          append("beforeText");
          change.beforeCount++;
          before++;
        } else {
          append("afterText");
          change.afterCount++;
          after++;
        }
      }
    }
  }
  for (const path of input.untracked ?? [])
    if (!byPath.has(path))
      files.push({
        path,
        oldPath: path,
        status: "?",
        binary: false,
        added: 0,
        deleted: 0,
        hunks: [],
      });
  return files;
}

/** Test evidence classification, deliberately independent from runner discovery. */
export function isTestFile(path: string): boolean {
  return (
    /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(path) ||
    /\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/.test(path) ||
    /\.(?:test|spec)-d\.[cm]?tsx?$/.test(path) ||
    /(?:^|\/)conftest\.py$/.test(path) ||
    /(?:^|\/)(?:test_[^/]*\.py|[^/]*_test\.(?:py|go))$/.test(path)
  );
}
