import type { State } from "../jev/types.ts";
import type { Ask } from "./asks.ts";
import type { Limitation } from "./output.ts";
export interface FileIdentity {
  requestedPath: string;
  resolvedPath: string;
  insertedPath: string;
  readSha256: string;
  insertedSha256: string;
  content: string;
}
export function checkIntegrity(
  state: State,
  asks: readonly Ask[],
  files: readonly FileIdentity[] = [],
  output?: { text: string; truncated: boolean; omittedChars: number },
): { controls: Limitation[]; notes: Limitation[] } {
  const controls: Limitation[] = [];
  const notes: Limitation[] = [];
  for (const file of files) {
    if (file.resolvedPath !== file.insertedPath || !file.content.length)
      controls.push({
        fact: `integrity: wrong identity or empty file ${file.requestedPath}`,
        next: `add the complete file to paths: ${file.requestedPath}`,
      });
    if (file.readSha256 !== file.insertedSha256)
      controls.push({
        fact: `integrity: fingerprint mismatch ${file.requestedPath}`,
        next: `read the complete file again: ${file.requestedPath}`,
      });
  }
  const out =
    output?.text ??
    (typeof state.output === "string" ? state.output : undefined);
  if (out !== undefined)
    for (const ask of asks) {
      if (ask.about !== undefined && ask.about !== "output") continue;
      const statements =
        ask.intent === "verify"
          ? Object.values(ask.claims)
          : ask.intent === "decide"
            ? Object.values(ask.hypotheses)
            : ask.intent === "classify"
              ? Object.values(ask.categories)
              : [];
      for (const statement of statements)
        for (const match of statement.matchAll(
          /`([^`]{4,})`|"([^"\n]{4,})"/g,
        )) {
          const literal = match[1] ?? match[2] ?? "";
          if (!out.includes(literal))
            controls.push({
              fact: `integrity: cited line not in state: ${literal}`,
              next: "add the cited output through command or state",
            });
        }
    }
  if (output?.truncated)
    notes.push({
      fact: `output truncated, ${output.omittedChars} chars omitted`,
      next: "narrow command to retain decisive lines",
    });
  return { controls, notes };
}
