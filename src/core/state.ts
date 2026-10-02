import { ASK_NOTE_MAX_CHARS, STATE_MAX_CHARS } from "../constants.ts";
import type { State } from "../jev/types.ts";
import { isRecord, type Result } from "../result.ts";

const reservedKeys = ["files", "files_before", "base_sha", "closure"] as const;

export function assembleState(
  note: string | undefined,
  files: Record<string, string>,
): Result<{ state: State }> {
  if (note !== undefined && note.length > ASK_NOTE_MAX_CHARS)
    return {
      ok: false,
      error: `state exceeds ${ASK_NOTE_MAX_CHARS} chars (${note.length}); shorten the note.`,
    };
  let state: State = {};
  if (note !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(note);
    } catch {
      parsed = note;
    }
    const reserved = isRecord(parsed)
      ? reservedKeys.find((key) => Object.hasOwn(parsed, key))
      : undefined;
    if (reserved)
      return {
        ok: false,
        error: `state contains reserved key ${reserved}; rename it in your note and use paths for files read by code.`,
      };
    if (isRecord(parsed)) state = parsed as State;
    else state.state = parsed as State[string];
  }
  const noteSize = JSON.stringify(state).length;
  if (Object.keys(files).length) state.files = files;
  const size = JSON.stringify(state).length;
  if (size > STATE_MAX_CHARS)
    return {
      ok: false,
      error: `serialized state exceeds ${STATE_MAX_CHARS} chars (${size}); serialized parts: note ${noteSize}, ${Object.entries(
        files,
      )
        .map(
          ([path, text]) =>
            `${path} ${JSON.stringify({ [path]: text }).length}`,
        )
        .join(
          ", ",
        )}. Split the situation into smaller states or provide smaller source files; files are never truncated.`,
    };
  return { ok: true, state };
}
