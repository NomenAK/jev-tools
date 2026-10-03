import {
  OUTPUT_CHUNK_CHARS,
  OUTPUT_FAILURE_WINDOW_LINES,
  OUTPUT_HEAD_SHARE,
  OUTPUT_REPEAT_MIN,
  OUTPUT_TAIL_SHARE,
} from "../constants.ts";

const terminalSequences =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping deliberately matches terminal control sequences.
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
export function cleanOutput(text: string): string {
  return text.replace(terminalSequences, "").replace(/\r\n?/g, "\n");
}
export function lineShape(line: string): string {
  return line
    .replace(/\d+/g, "0")
    .replace(/[\p{L}_][\p{L}\p{N}_]*/gu, (word) =>
      /^[A-Z_]+$/.test(word) ? word : "x",
    );
}
export function createRarityCompressor(
  frequencies: ReadonlyMap<string, number>,
  emit: (text: string) => void,
) {
  const markerFor = (hidden: number) => `[… ${hidden} repetitive lines …]`;
  let first = "";
  let last = "";
  let count = 0;
  // Length of the buffered run joined with newlines, without building it.
  let length = 0;
  let buffer: string[] = [];
  let folding = false;
  const flush = () => {
    if (!count) return;
    if (folding) {
      emit(first);
      if (count > 2) emit(markerFor(count - 2));
      if (count > 1) emit(last);
    } else {
      for (const line of buffer) emit(line);
    }
    first = "";
    last = "";
    count = 0;
    length = 0;
    buffer = [];
    folding = false;
  };
  return {
    line(line: string) {
      if ((frequencies.get(lineShape(line)) ?? 0) >= OUTPUT_REPEAT_MIN) {
        if (folding) {
          last = line;
          count++;
        } else {
          if (!count) first = line;
          last = line;
          count++;
          buffer.push(line);
          length += line.length + (count > 1 ? 1 : 0);
          // The fold decision is monotonic: once the folded text is shorter,
          // later lines keep it shorter, so switching once is safe.
          if (count > 2) {
            const marker = markerFor(count - 2);
            if (length > first.length + 1 + marker.length + 1 + last.length) {
              folding = true;
              buffer = [];
            }
          }
        }
      } else {
        flush();
        emit(line);
      }
    },
    finish: flush,
  };
}
export interface OutputChunk {
  start: number;
  end: number;
  text: string;
}
export function outputChunks(text: string): OutputChunk[] {
  const chunks: OutputChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + OUTPUT_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline >= start) end = newline + 1;
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? ""))
        end--;
    }
    chunks.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return chunks;
}
export function selectOutput(
  text: string,
  chunks: readonly OutputChunk[],
  scores: readonly number[],
  budget: number,
): string {
  if (JSON.stringify(text).length <= budget) return text;
  const ranges: { start: number; end: number }[] = [];
  const head = Math.floor(budget * OUTPUT_HEAD_SHARE);
  const tail = Math.floor(budget * OUTPUT_TAIL_SHARE);
  if (head) ranges.push({ start: 0, end: head });
  if (tail)
    ranges.push({ start: Math.max(0, text.length - tail), end: text.length });
  const render = () => {
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    let end = 0;
    let result = "";
    for (const range of sorted) {
      if (range.start > end)
        result += `[… ${range.start - end} chars omitted …]\n`;
      if (range.end > end)
        result += text.slice(Math.max(end, range.start), range.end);
      end = Math.max(end, range.end);
    }
    if (end < text.length)
      result += `\n[… ${text.length - end} chars omitted …]`;
    return result;
  };
  for (const candidate of chunks
    .map((chunk, index) => ({ chunk, score: scores[index] ?? 0 }))
    .filter(({ score }) => score >= 0.5)
    .sort((a, b) => b.score - a.score || a.chunk.start - b.chunk.start)) {
    ranges.push(candidate.chunk);
    if (JSON.stringify(render()).length > budget) ranges.pop();
  }
  return render();
}
export interface FailureTarget {
  path: string;
  nodeId?: string;
  testName?: string;
  assertion: boolean;
}
export function failureTargets(text: string): {
  assertion: boolean;
  signature?: "assertion" | "environment";
  targets: FailureTarget[];
} {
  const targets: FailureTarget[] = [];
  let signature: "assertion" | "environment" | undefined;
  const lines = text.split("\n");
  const firstFailure = lines.findIndex((line) =>
    /^\S+\.py:\d+: \w*(?:Assertion)?Error$|^E\s+assert\b|^\s*(?:AssertionError\b|E\s+AssertionError\b)|_test\.go:\d+:.*\b(?:want|expected)\b|--- FAIL|^FAILED |^ERROR |^\s*(?:FAIL|❯|×|✖)\s|no such file or directory|ECONNREFUSED|permission denied|error TS\d+|undefined:|ModuleNotFoundError/i.test(
      line,
    ),
  );
  if (firstFailure < 0) return { assertion: false, targets };
  // node:test prints its failing-test block ("✖ failing tests:" then
  // "test at <file>:<line>:<col>") after one summary line per test, so the
  // location can sit more than one window past the first anchor. Only the
  // header re-anchors: a bare "test at" line can also be printed by a
  // passing test and must not open a window on its own.
  const secondAnchor = lines.findIndex(
    (line, index) =>
      index > firstFailure && /^\s*(?:✖\s+)?failing tests:?\s*$/.test(line),
  );
  for (const [position, line] of lines.entries()) {
    const inSecondWindow =
      secondAnchor >= 0 &&
      position >= secondAnchor &&
      position <= secondAnchor + OUTPUT_FAILURE_WINDOW_LINES;
    if (
      (position < firstFailure - OUTPUT_FAILURE_WINDOW_LINES ||
        position > firstFailure + OUTPUT_FAILURE_WINDOW_LINES) &&
      !inSecondWindow
    )
      continue;
    if (/^\s*(?:--- PASS|=== RUN|.*\bPASSED\b)/.test(line)) continue;
    if (
      (position >= firstFailure || inSecondWindow) &&
      !signature &&
      /no such file or directory|ECONNREFUSED|permission denied|refusing to allow|error TS\d+|undefined:|ModuleNotFoundError/i.test(
        line,
      )
    )
      signature = "environment";
    if (
      (position >= firstFailure || inSecondWindow) &&
      !signature &&
      /^\S+\.py:\d+: \w*(?:Assertion)?Error$|^E\s+assert\b|^\s*(?:AssertionError\b|E\s+AssertionError\b)|_test\.go:\d+:.*\b(?:want|expected)\b|--- FAIL|^FAILED |^\s*(?:FAIL|❯|×|✖)\s|^\s*test at .+?:\d+:\d+\s*$/.test(
        line,
      )
    )
      signature = "assertion";
    const inFirstWindow =
      position >= firstFailure - OUTPUT_FAILURE_WINDOW_LINES &&
      position <= firstFailure + OUTPUT_FAILURE_WINDOW_LINES;
    const pytest = /^(FAILED|ERROR)\s+(.+?)(?: - |$)/.exec(line);
    if (pytest) {
      const nodeId = pytest[2]?.trim() ?? "";
      targets.push({
        path: nodeId.split("::")[0] ?? "",
        nodeId,
        assertion: pytest[1] === "FAILED",
      });
    }
    if (firstFailure >= 0) {
      const go = lines
        .slice(firstFailure, firstFailure + OUTPUT_FAILURE_WINDOW_LINES + 1)
        .join("\n")
        .match(/--- FAIL:\s+(\S+)/);
      const run = go
        ? lines.findLastIndex((item) => item.startsWith(`=== RUN   ${go[1]}`))
        : -1;
      const failLine = go
        ? lines.findIndex(
            (item, index) =>
              index >= firstFailure && item.includes(`--- FAIL: ${go[1]}`),
          )
        : -1;
      if (
        go &&
        position >= Math.max(run, firstFailure - 1) &&
        position <= failLine
      ) {
        for (const match of line.matchAll(
          /(?:^|\s|\()([^\s():]+_test\.go):\d+/g,
        ))
          targets.push({
            path: match[1] ?? "",
            testName: go[1]?.split("/")[0],
            assertion: true,
          });
      }
    }
    const js = /^\s*(?:FAIL|❯|×)\s+(.+?\.[cm]?[jt]sx?)(?:\s|$)/.exec(line);
    if (js) targets.push({ path: js[1] ?? "", assertion: true });
    const node = /^\s*test at (.+?):\d+:\d+\s*$/.exec(line);
    // A passing node:test can print "test at ..." as ordinary output; it
    // only counts inside the failing-tests block, or inside the first
    // window when no failing-tests block exists (short outputs).
    if (node && (inSecondWindow || (secondAnchor < 0 && inFirstWindow)))
      targets.push({
        path: nodeTestPath(node[1] ?? ""),
        assertion: true,
      });
  }
  return { assertion: signature === "assertion", signature, targets };
}

/**
 * node:test reports absolute locations as file URLs: file:///repo/a.mjs on
 * POSIX and file:///C:/repo/a%20b.mjs on Windows. Convert them to plain,
 * decoded paths; other locations are returned unchanged.
 */
export function nodeTestPath(location: string): string {
  if (!location.startsWith("file://")) return location;
  let path = location.slice("file://".length);
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
