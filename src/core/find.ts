import {
  FIND_CONTENT_MIN,
  FIND_EXCERPT_HEAD_CHARS,
  FIND_NAME_GUARD_MIN,
  FIND_NAME_GUARD_TOP,
  FIND_POINTER_MAX,
} from "../constants.ts";
import { truncate } from "./truncate.ts";

const stopWords: Record<string, true> = Object.fromEntries(
  "the and for with from that this into where what which when how does should could would file files code find implement implementation une les des dans pour avec sur est qui que quoi comment fichier fichiers chercher"
    .split(" ")
    .map((word) => [word, true]),
);
export function contentWords(goal: string): string[] {
  return (goal.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
    (word) => word.length >= 3 && !stopWords[word],
  );
}
export function findKeywords(
  goal: string,
  keywords: readonly string[] = [],
): string[] {
  return [
    ...new Set([
      ...contentWords(goal),
      ...keywords.map((word) => word.toLowerCase()).filter(Boolean),
    ]),
  ];
}
export interface RankedFile {
  path: string;
  p: number;
}
export function rankFiles(files: readonly RankedFile[]): RankedFile[] {
  return [...files].sort((a, b) => b.p - a.p || a.path.localeCompare(b.path));
}
export function retainFiles(
  content: readonly RankedFile[],
  names: readonly RankedFile[],
): RankedFile[] {
  const retained = rankFiles(
    content.filter((file) => file.p >= FIND_CONTENT_MIN),
  ).slice(0, FIND_POINTER_MAX);
  for (const name of names.slice(0, FIND_NAME_GUARD_TOP)) {
    const file = content.find((file) => file.path === name.path);
    if (
      name.p >= FIND_NAME_GUARD_MIN &&
      file &&
      !retained.some((item) => item.path === file.path)
    ) {
      if (retained.length === FIND_POINTER_MAX) retained.pop();
      retained.push(file);
      break;
    }
  }
  return retained;
}
export function pathAllowed(
  path: string,
  scope: string | readonly string[] | undefined,
  exclude: readonly string[] = [],
): boolean {
  const scopes = typeof scope === "string" ? [scope] : scope;
  if (
    scopes?.length &&
    !scopes.some((root) => {
      const normalized = root.replace(/^\.\//u, "").replace(/\/$/u, "");
      return (
        normalized === "." ||
        path === normalized ||
        path.startsWith(`${normalized}/`)
      );
    })
  )
    return false;
  return !exclude.some((glob) => {
    const pattern = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "<<<recursive>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/<<<recursive>>>\//g, "(?:.*/)?")
      .replace(/<<<recursive>>>/g, ".*");
    return new RegExp(`^${pattern}$`, "u").test(path);
  });
}

export function createExcerptCollector(
  keywords: readonly string[],
  limit: number,
) {
  let head = "",
    tail = "",
    best = "",
    bestScore = -1,
    total = 0,
    whole = "";
  const separator = "\n…\n";
  const room = limit - FIND_EXCERPT_HEAD_CHARS - separator.length;
  return {
    push(chunk: string): void {
      const previousTotal = total;
      total += chunk.length;
      if (total <= limit) whole += chunk;
      else whole = "";
      if (head.length < FIND_EXCERPT_HEAD_CHARS)
        head = truncate(head + chunk, FIND_EXCERPT_HEAD_CHARS);
      const consumedByHead = Math.max(
        0,
        Math.min(chunk.length, FIND_EXCERPT_HEAD_CHARS - previousTotal),
      );
      const buffer = tail + chunk.slice(consumedByHead);
      for (
        let start = 0;
        start < buffer.length;
        start += Math.max(1, Math.floor(room / 4))
      ) {
        const safeStart =
          start > 0 &&
          buffer.charCodeAt(start) >= 0xdc00 &&
          buffer.charCodeAt(start) <= 0xdfff
            ? start + 1
            : start;
        const window = truncate(buffer.slice(safeStart), room);
        const lower = window.toLowerCase();
        const score = keywords.reduce((sum, word) => {
          let count = 0,
            offset = 0;
          let match = lower.indexOf(word, offset);
          while (match !== -1) {
            count++;
            offset = match + word.length;
            match = lower.indexOf(word, offset);
          }
          return sum + count;
        }, 0);
        if (score > bestScore) {
          best = window;
          bestScore = score;
        }
      }
      let start = Math.max(0, buffer.length - room);
      if (
        start > 0 &&
        buffer.charCodeAt(start) >= 0xdc00 &&
        buffer.charCodeAt(start) <= 0xdfff
      )
        start++;
      tail = buffer.slice(start);
    },
    finish(): string {
      if (total <= limit) return whole;
      return truncate(head + separator + best, limit);
    },
  };
}
