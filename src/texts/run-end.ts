import type { DocsFinding } from "../presets/docs.ts";

/** Only flagged, designated sentences are supplied by the hook. */
export function runEndMessage(findings: readonly DocsFinding[]): string {
  return [
    "jev_check_diff (docs) flagged documentation that may no longer match your changes:",
    ...findings.map(
      (finding) =>
        `- ${finding.section.path} § ${finding.section.heading} — ${JSON.stringify(finding.sentence?.text)} may no longer match ${finding.units.map((unit) => `${unit.name} in ${unit.file}`).join(", ")}`,
    ),
    "Inspect each flagged sentence against the change; update it or explain with evidence why it remains correct. This limited automatic check does not certify documentation completeness and does not require another Jev call.",
  ].join("\n");
}
