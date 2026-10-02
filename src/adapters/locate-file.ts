import {
  LOCATE_LABEL_MAX_CHARS,
  LOCATE_READ_BUFFER_BYTES,
  LOCATE_WHOLE_MAX_BYTES,
  LOCATE_WHOLE_MAX_CHARS,
  LOCATE_WINDOW_LINES,
  LOCATE_WINDOW_MAX_SERIALIZED_CHARS,
  STATE_MAX_CHARS,
} from "../constants.ts";
import type { GitExec } from "../core/git.ts";
import { truncate } from "../core/truncate.ts";
import type { Result } from "../result.ts";
import { openRepoFile } from "./files.ts";
import { createUtf8Decoder, decodeUtf8 } from "./utf8.ts";

type Window = {
  start: number;
  end: number;
  label: string;
  text: string;
  serializedTextChars: number;
};
type FileOutline =
  | { kind: "whole"; bytes: number; lines: number; text: string }
  | { kind: "outline"; bytes: number; lines: number; windows: Window[] };
type Scan = { bytes: number; lines: number; windows: Window[]; text: string };
/** The initial read is bounded; large-file outlines retain labels rather than source. */
export async function readLocateFile(
  cwd: string,
  path: string,
  signal?: AbortSignal,
  exec?: GitExec,
): Promise<Result<FileOutline>> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path))
    return {
      ok: false,
      error: `Internal URLs are not files; use read for ${path}.`,
    };
  const opened = await openRepoFile(cwd, path, { exec, signal });
  if (!opened.ok) return opened;
  const handle = opened.handle;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, error: `Not a file: ${path}.` };
    const buffer = Buffer.alloc(
      Math.min(stat.size + 1, LOCATE_WHOLE_MAX_BYTES + 1),
    );
    let count = 0;
    while (count < buffer.length) {
      signal?.throwIfAborted();
      const read = await handle.read(
        buffer,
        count,
        buffer.length - count,
        null,
      );
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (buffer.subarray(0, count).includes(0))
      return { ok: false, error: `Not a text file: ${path}.` };
    if (count < buffer.length) {
      const decoded = decodeUtf8(buffer.subarray(0, count));
      if (!decoded.ok) return { ok: false, error: `${path}: ${decoded.error}` };
      const text = decoded.text;
      if (text.length <= LOCATE_WHOLE_MAX_CHARS)
        return {
          ok: true,
          kind: "whole",
          bytes: count,
          lines: text
            ? text.split("\n").length - Number(text.endsWith("\n"))
            : 0,
          text,
        };
    }
    const scan = await scanRange(cwd, path, undefined, signal, exec);
    return scan.ok
      ? {
          ok: true,
          kind: "outline",
          bytes: stat.size,
          lines: scan.lines,
          windows: scan.windows,
        }
      : scan;
  } catch (error) {
    return { ok: false, error: `Cannot read ${path}: ${String(error)}` };
  } finally {
    await handle.close();
  }
}

export async function scanRange(
  cwd: string,
  path: string,
  range?: { start: number; end: number },
  signal?: AbortSignal,
  exec?: GitExec,
): Promise<Result<Scan>> {
  const opened = await openRepoFile(cwd, path, { exec, signal });
  if (!opened.ok) return opened;
  const handle = opened.handle;
  const decode = createUtf8Decoder();
  const buffer = Buffer.alloc(LOCATE_READ_BUFFER_BYTES);
  let reachedEof = false;
  let line = 1,
    label = "",
    pending = false,
    text = "",
    bytes = 0;
  const windows: Window[] = [];
  let windowStart = 1,
    head = "",
    tail = "",
    serializedTextChars = 2;
  const finishWindow = (end: number) => {
    windows.push({
      start: windowStart,
      end,
      label: label || `lines ${windowStart}-${end}`,
      text: `${head}\n…\n${tail}`,
      serializedTextChars,
    });
    windowStart = end + 1;
    label = "";
    head = "";
    tail = "";
    serializedTextChars = 2;
  };
  const consume = (chunk: string) => {
    for (const piece of chunk.split(/(?<=\n)/)) {
      if (!piece) continue;
      pending = true;
      const excerptLimit = LOCATE_WINDOW_MAX_SERIALIZED_CHARS;
      serializedTextChars += JSON.stringify(piece).length - 2;
      head = truncate(head + piece, excerptLimit);
      const combined = tail + piece;
      const tailStart = Math.max(0, combined.length - excerptLimit);
      tail = combined.slice(
        tailStart +
          (tailStart > 0 && /[\uDC00-\uDFFF]/.test(combined[tailStart] ?? "")
            ? 1
            : 0),
      );
      if (
        (line - 1) % LOCATE_WINDOW_LINES === 0 &&
        label.length < LOCATE_LABEL_MAX_CHARS
      )
        label = truncate(label + piece.trim(), LOCATE_LABEL_MAX_CHARS);
      if (range && line >= range.start && line <= range.end) text += piece;
      if (text.length > STATE_MAX_CHARS) return false;
      if (piece.endsWith("\n")) {
        if (
          line - windowStart + 1 >= LOCATE_WINDOW_LINES ||
          serializedTextChars >= LOCATE_WINDOW_MAX_SERIALIZED_CHARS
        )
          finishWindow(line);
        line++;
        pending = false;
      }
    }
    return true;
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) {
        reachedEof = true;
        break;
      }
      if (buffer.subarray(0, read.bytesRead).includes(0))
        return { ok: false, error: `Not a text file: ${path}.` };
      bytes += read.bytesRead;
      const decoded = decode(buffer.subarray(0, read.bytesRead));
      if (!decoded.ok) return { ok: false, error: `${path}: ${decoded.error}` };
      if (!consume(decoded.text))
        return {
          ok: false,
          error: `Selected range exceeds ${STATE_MAX_CHARS} chars; read a narrower range directly.`,
        };
      if (range && line > range.end) break;
    }
    const end = reachedEof ? decode() : { ok: true as const, text: "" };
    if (!end.ok) return { ok: false, error: `${path}: ${end.error}` };
    if (!consume(end.text))
      return { ok: false, error: "Selected range too large." };
    const lines = line - Number(!pending);
    if (lines > 0 && (windows.at(-1)?.end ?? 0) < lines) finishWindow(lines);
    return { ok: true, bytes, lines, windows, text };
  } catch (error) {
    return { ok: false, error: `Cannot read ${path}: ${String(error)}` };
  } finally {
    await handle.close();
  }
}
