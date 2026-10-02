import type { DocsFinding } from "../presets/docs.ts";

/** Only flagged, designated sentences are supplied by the hook. */
export function runEndMessage(findings: readonly DocsFinding[]): string {
  return [
    "jev_check_diff (docs) flagged documentation that may no longer match your changes:",
    ...findings.map(
      (finding) =>
        `- ${finding.section.path} § ${finding.section.heading} — ${JSON.stringify(finding.sentence?.text)} no longer true after ${finding.units.map((unit) => `${unit.name} in ${unit.file}`).join(", ")}`,
    ),
    "Update them, or say why they are still correct.",
  ].join("\n");
}
