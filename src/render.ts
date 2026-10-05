import type { Envelope, OutputLine } from "./core/output.ts";
import type { Knowledge, ResultReportV1, Scope } from "./core/result-report.ts";

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

function knowledge<T>(
  value: Knowledge<T>,
  format: (value: T) => string = String,
): string {
  return value.status === "known"
    ? format(value.value)
    : `${value.status} (${value.reason})`;
}
function scopeLabel(scope: Scope): string {
  return scope.kind === "call"
    ? "call"
    : scope.kind === "item"
      ? `items ${scope.itemIds.join(", ")}`
      : scope.kind === "group"
        ? `groups ${scope.groupIds.join(", ")}`
        : `inventory ${scope.inventoryIds.join(", ")}`;
}

/** Human projection uses the same typed facts as structured transport, never prose inference. */
export function renderResultReport(
  report: ResultReportV1,
  options: { details?: Envelope } = {},
): string {
  const { context: c, accounting: a } = report;
  const counts = a.requestedResults;
  const mode =
    counts.fresh + counts.cache
      ? `${counts.fresh} fresh / ${counts.cache} cache Jev results`
      : counts.static
        ? "static selection; no Jev judgment"
        : report.items.some((item) => item.selection?.selected)
          ? "conservative fallback selection; no Jev judgment"
          : "no admissible judgment";
  const lines = [
    `${report.execution} — ${mode}${counts.notJudged ? `; ${counts.notJudged} not judged` : ""}`,
    `context: authority ${knowledge(c.authority, (v) => `${v.path} (${v.origin})`)} · requested root ${knowledge(c.requestedRoot)} · effective root ${knowledge(c.effectiveRoot, (v) => `${v.path} (${v.origin}); common-dir ${knowledge(v.commonDir)}`)} · base ${knowledge(c.requestedBase)} → ${knowledge(c.resolvedBase)}`,
  ];
  for (const inv of c.inventories) {
    lines.push(
      `inventory ${inv.id} (${inv.kind}): discovered ${knowledge(inv.discovered)} · considered ${knowledge(inv.considered)} · scopeRestricted ${inv.scopeRestricted} · rules ${inv.rules.join("; ")} · restrictions ${inv.restrictions.join("; ") || "none"}`,
    );
    for (const criterion of inv.criteria)
      lines.push(
        `criterion ${JSON.stringify(criterion.criterion)}: ${criterion.outcome}; matches ${knowledge(criterion.matches)}`,
      );
  }
  if (c.command.execution !== "not_requested")
    lines.push(
      `command: ${c.command.execution} · cwd ${knowledge(c.command.cwd)} · exit ${knowledge(c.command.exitCode)} · timedOut ${knowledge(c.command.timedOut)}`,
    );
  for (const item of report.items) {
    if (item.treatment === "judged") {
      const j = item.judgment;
      lines.push(
        `${j.band === "verdict" ? "" : `${j.band}  `}${j.uncalibrated ? "uncalibrated  " : ""}${item.label} = ${String(j.result)} (${j.measure.kind} ${knowledge(j.measure.value)}) [${item.source}]${j.reason ? ` — ${j.reason}` : ""}`,
      );
      for (const raw of j.rawValues)
        lines.push(
          `  raw ${raw.label} = ${String(raw.value)}; probability ${knowledge(raw.probability)}`,
        );
      for (const control of j.controls) {
        lines.push(
          `  control ${control.id} (${control.kind}, ${control.source}): ${control.outcome}`,
        );
        for (const raw of control.rawValues)
          lines.push(
            `    raw ${raw.label} = ${String(raw.value)}; probability ${knowledge(raw.probability)}`,
          );
      }
    } else
      lines.push(
        `${item.treatment === "static" ? "static" : "unjudged"}  ${item.label}${item.treatment === "static" ? ` — ${item.staticReason}` : ""}`,
      );
    for (const evidence of item.evidence)
      lines.push(
        `  evidence ${evidence.target} (${evidence.side}): ${knowledge(evidence.canonicalPath)} · aliases ${evidence.aliases.join(", ") || "none"} · revision ${knowledge(evidence.revision)}`,
      );
    if (item.selection)
      lines.push(
        `  selection: ${item.selection.selected ? "selected" : "not selected"} — ${item.selection.reason}`,
      );
    if (item.diagnosticIds.length)
      lines.push(`  diagnostics ${item.diagnosticIds.join(", ")}`);
    if (item.actionIds.length)
      lines.push(`  actions ${item.actionIds.join(", ")}`);
  }
  // Complete diagnostic lists keep legacy text-only clients self-contained.
  for (const d of report.diagnostics)
    lines.push(
      `${d.material ? "material " : ""}${d.effect} ${d.id} — ${d.cause}: ${d.fact} · target ${knowledge(d.target)} · origin ${d.origin} · scope ${scopeLabel(d.scope)} · members ${knowledge(d.memberCount)}${d.omittedMembers.length ? ` · omitted ${d.omittedMembers.join(", ")}` : ""} · actions ${d.actionIds.join(", ") || "none"}`,
    );
  for (const action of report.actions)
    lines.push(
      `next ${action.id} (${action.code}; ${scopeLabel(action.scope)}; target ${knowledge(action.target)}): ${action.condition} — ${action.instruction}`,
    );
  if (options.details) {
    const detailLines = options.details.lines.filter(
      (line) => line.type === "command" || line.type === "list",
    );
    if (detailLines.length)
      lines.push("details:", renderEnvelope({ lines: detailLines }));
  }
  lines.push(
    `HTTP attempts ${a.httpAttempts} · questions sent ${a.questionsSent} · requested results total ${knowledge(counts.total)} / fresh ${counts.fresh} / cache ${counts.cache} / not judged ${counts.notJudged} / static ${counts.static} · cache probes ${a.cacheHits}/${a.cacheRequests} · auxiliary controls fresh ${a.auxiliary.controls.fresh} / cache ${a.auxiliary.controls.cache} / not judged ${a.auxiliary.controls.notJudged} / static ${a.auxiliary.controls.static} · passages fresh ${a.auxiliary.passages.fresh} / cache ${a.auxiliary.passages.cache} / not judged ${a.auxiliary.passages.notJudged} · current cost USD ${knowledge(a.costUsd)} · elapsed ${a.elapsedMs} ms`,
  );
  return lines.join("\n");
}
