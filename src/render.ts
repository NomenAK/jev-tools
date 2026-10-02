import type { Envelope, OutputLine } from "./core/output.ts";

function renderLine(line: OutputLine): string {
  switch (line.type) {
    case "state":
      return `state: ${line.files} files · integrity ${line.integrity}${line.warnings.length ? ` · ${line.warnings.length} warnings: ${line.warnings.join("; ")}` : ""}`;
    case "answer":
      return `${line.band === "verdict" ? "" : `${line.band}  `}${line.uncalibrated ? "uncalibrated  " : ""}${line.label} = ${line.value.head} (${line.value.p})${line.orderDependent ? " · order-dependent" : ""}${line.reason ? ` — ${line.reason}` : ""}${line.candidates?.map((candidate) => `\nalso: ${candidate.label} = ${candidate.value.head} (${candidate.value.p})`).join("") ?? ""}`;
    case "unjudged":
      return `unjudged  ${line.label} — ${line.reason}; ${line.next}`;
    case "entry": {
      const readable = [line.candidate, ...(line.candidates ?? [])]
        .map((candidate) => candidate.value.head)
        .filter((head) => typeof head === "string" && head !== "none");
      const action =
        readable.length > 1
          ? "read both"
          : readable.length === 1
            ? `read ${readable[0]}; rephrase goal or widen scope if needed`
            : "rephrase goal or widen scope";
      return `${line.band === "unsure" ? `unsure  entry — ${action}` : `${line.band === "verdict" ? "" : `${line.band}  `}entry: ${line.candidate.value.head} (${line.candidate.value.p.toFixed(2)})`}${line.band === "unsure" ? `\n  ${line.candidate.value.head} ${line.candidate.value.p.toFixed(2)}` : ""}${line.orderDependent && line.orderProbabilities ? ` (order-dependent: ${line.orderProbabilities.map((p) => p.toFixed(2)).join(" / ")})` : ""}${line.candidates?.map((candidate) => `\n  ${candidate.value.head} ${candidate.value.p.toFixed(2)}`).join("") ?? ""}${line.relevant?.length ? `\nrelevant:\n${line.relevant.map((candidate) => `  ${candidate.value.head} ${candidate.value.p.toFixed(2)}`).join("\n")}` : ""}${line.nextRead?.length ? `\nread ${line.nextRead.join(" · ")}` : ""}`;
    }
    case "list":
      return `${line.title}:\n${line.items.map((item) => `  - ${item}`).join("\n")}`;
    case "command":
      return `run: cwd: ${line.cwd} · framework: ${line.framework}${line.config ? ` · config: ${line.config}` : ""}${line.project ? ` · project: ${line.project}` : ""} · command: ${[line.executable, ...line.args].map((arg) => (/^[a-zA-Z0-9_./:@+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)).join(" ")}`;
    case "fact":
      return `[${line.fact}${line.next ? `; ${line.next}` : ""}]`;
    case "limit-group":
      return `[${line.cause}: ${line.count} limit${line.count === 1 ? "" : "s"} (${line.priority ? "selected tests / changed units" : "remaining inventory"}) — ${line.examples.join(" · ")}${line.remaining ? ` · +${line.remaining} more (bounded path list)` : ""}; ${line.next}]`;
    case "collection":
      return `[${line.title}: ${line.count} sections — ${line.items.join(" · ")}${line.count > line.items.length ? ` · +${line.count - line.items.length} more (bounded section list)` : ""}; ${line.next}]`;
    case "unchecked":
      return `unchecked: ${line.items.join(" · ")}`;
    case "refusal":
      return line.message;
    case "yield": {
      const value = line.value;
      return `${value.calls} calls · ${value.questions} questions · ${value.costUsd === undefined ? "cost unavailable" : `$${value.costUsd.toFixed(5)}`} · cache ${value.cacheHits}/${value.cacheRequests} · ${(value.elapsedMs / 1000).toFixed(1)} s`;
    }
  }
}
export function renderEnvelope(envelope: Envelope): string {
  return envelope.lines.map(renderLine).join("\n");
}
