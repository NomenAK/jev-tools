import { createReadStream } from "node:fs";
import { OUTPUT_LINE_MAX_CHARS } from "../constants.ts";

/** Retains only a bounded prefix per physical line, discarding the remainder in chunks. */
export async function* outputLines(
  path: string,
  signal?: AbortSignal,
  onOmitted?: (chars: number) => void,
): AsyncGenerator<string> {
  let prefix = "";
  let clipped = false;
  const stream = createReadStream(path, {
    encoding: "utf8",
    highWaterMark: 16_384,
    signal,
  });
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const text = String(chunk);
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const end = newline < 0 ? text.length : newline;
      const remaining = OUTPUT_LINE_MAX_CHARS - prefix.length;
      if (remaining > 0)
        prefix += text.slice(offset, Math.min(end, offset + remaining));
      if (end - offset > remaining) {
        clipped = true;
        onOmitted?.(end - offset - Math.max(0, remaining));
      }
      if (newline < 0) break;
      if (clipped && /[\uD800-\uDBFF]$/.test(prefix)) {
        prefix = prefix.slice(0, -1);
        onOmitted?.(1);
      }
      yield prefix.replace(/\r$/, "") +
        (clipped ? `…[line truncated at ${OUTPUT_LINE_MAX_CHARS} chars]` : "");
      prefix = "";
      clipped = false;
      offset = newline + 1;
    }
  }
  if (clipped && /[\uD800-\uDBFF]$/.test(prefix)) {
    prefix = prefix.slice(0, -1);
    onOmitted?.(1);
  }
  if (prefix || clipped)
    yield prefix +
      (clipped ? `…[line truncated at ${OUTPUT_LINE_MAX_CHARS} chars]` : "");
}
