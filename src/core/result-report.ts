import type {
  Accounting,
  Action,
  Context,
  Diagnostic,
  Inventory,
  Item,
  ItemCommon,
  Knowledge,
  ResultReportV1,
  Scope,
  Tool,
} from "../result-types.ts";
import { type AnswerInput, askBand, type Yield } from "./output.ts";

export type {
  Accounting,
  Action,
  Cause,
  Context,
  Diagnostic,
  Execution,
  Inventory,
  Item,
  ItemCommon,
  Knowledge,
  McpStructuredResultV1,
  RawValue,
  ResultReportV1,
  Scope,
  Tool,
} from "../result-types.ts";
/** Structural input prevents the pure core from depending on adapters. */
export interface EvidenceContextInput {
  authority?: { path: string; origin: "host" | "server" };
  authorityReason?: string;
  requestedRoot?: string;
  effectiveRoot?: {
    path: string;
    origin: "host" | "server" | "override";
    commonDir?: string;
  };
  requestedBase?: string;
  resolvedBase?: string;
}

export const known = <T>(value: T): Knowledge<T> => ({
  status: "known",
  value,
});
export const unknown = (reason: string): Knowledge<never> => ({
  status: "unknown",
  reason,
});
export const notApplicable = (reason: string): Knowledge<never> => ({
  status: "not_applicable",
  reason,
});
export const notCollected = (reason: string): Knowledge<never> => ({
  status: "not_collected",
  reason,
});

export function uncollectedContext(input: {
  authority: Context["authority"];
  requestedRoot?: Knowledge<string>;
  requestedBase?: Knowledge<string>;
  command?: Context["command"];
}): Context {
  return {
    authority: input.authority,
    requestedRoot:
      input.requestedRoot ?? notApplicable("no override requested"),
    effectiveRoot: unknown("effective root not established"),
    requestedBase: input.requestedBase ?? notApplicable("no base requested"),
    resolvedBase: input.requestedBase
      ? notCollected("base resolution not performed")
      : notApplicable("no base requested"),
    inventories: [],
    command: input.command ?? {
      execution: "not_requested",
      cwd: notApplicable("no command"),
      exitCode: notApplicable("no command"),
      timedOut: notApplicable("no command"),
    },
  };
}

export function contextFromEvidence(
  evidence: EvidenceContextInput | undefined,
  options: {
    inventories?: Inventory[];
    command?: Context["command"];
  } = {},
): Context {
  const context = uncollectedContext({
    authority: evidence?.authorityReason
      ? unknown(evidence.authorityReason)
      : evidence?.authority
        ? known(evidence.authority)
        : unknown("canonical authority not established"),
    ...(evidence?.requestedRoot !== undefined
      ? { requestedRoot: known(evidence.requestedRoot) }
      : {}),
    ...(evidence?.requestedBase !== undefined
      ? { requestedBase: known(evidence.requestedBase) }
      : {}),
    ...(options.command ? { command: options.command } : {}),
  });
  if (evidence?.effectiveRoot)
    context.effectiveRoot = known({
      path: evidence.effectiveRoot.path,
      origin: evidence.effectiveRoot.origin,
      commonDir:
        evidence.effectiveRoot.commonDir === undefined
          ? unknown("Git common directory not collected")
          : known(evidence.effectiveRoot.commonDir),
    });
  if (evidence?.resolvedBase !== undefined)
    context.resolvedBase = known(evidence.resolvedBase);
  else if (evidence?.requestedBase !== undefined)
    context.resolvedBase = unknown("requested base not resolved");
  context.inventories = options.inventories ?? [];
  return context;
}

export interface ReportInput {
  tool: Tool;
  context: Context;
  items: Item[];
  diagnostics: Diagnostic[];
  actions: Action[];
  metrics: Yield;
  auxiliary: Accounting["auxiliary"];
  total: Knowledge<number>;
  /** Call-wide input/admission refusal, not a refusal of one group. */
  refused?: boolean;
  /** Explicit missing requested/candidate work outside enumerated items. */
  missingWork?: boolean;
}

export function buildResultReport(input: ReportInput): ResultReportV1 {
  const counts = { fresh: 0, cache: 0, notJudged: 0, static: 0 };
  for (const item of input.items) {
    if (item.treatment === "judged") counts[item.source]++;
    else if (item.treatment === "static") counts.static++;
    else counts.notJudged++;
  }
  const admissible = counts.fresh + counts.cache + counts.static;
  const usefulFallback = input.items.some(
    (item) => item.treatment === "not_judged" && item.selection?.selected,
  );
  const missing =
    input.missingWork ||
    counts.notJudged > 0 ||
    input.diagnostics.some(
      (d) => d.cause === "criteria_no_match" || d.effect === "blocking",
    );
  const report: ResultReportV1 = {
    schemaVersion: 1,
    tool: input.tool,
    execution:
      !admissible && !usefulFallback
        ? input.refused
          ? "refused"
          : "not_judged"
        : missing
          ? "partial"
          : "complete",
    context: input.context,
    items: input.items,
    diagnostics: input.diagnostics,
    actions: input.actions,
    accounting: {
      toolInvocations: 1,
      httpAttempts: input.metrics.calls,
      questionsSent: input.metrics.questions,
      cacheHits: input.metrics.cacheHits,
      cacheRequests: input.metrics.cacheRequests,
      requestedResults: { total: input.total, ...counts },
      auxiliary: input.auxiliary,
      costUsd:
        input.metrics.costUsd === undefined
          ? unknown("current request cost not reported")
          : known(input.metrics.costUsd),
      elapsedMs: input.metrics.elapsedMs,
    },
  };
  const errors = validateResultReport(report);
  if (errors.length)
    throw new Error(`Invalid ResultReportV1: ${errors.join("; ")}`);
  return report;
}

/** Semantic checks complement, rather than replace, the public JSON Schema. */
export function validateResultReport(report: ResultReportV1): string[] {
  const errors: string[] = [];
  const counter = (value: number, label: string) => {
    if (!Number.isSafeInteger(value) || value < 0)
      errors.push(`invalid counter ${label}`);
  };
  const measurement = (
    value: Knowledge<number>,
    label: string,
    probability = false,
  ) => {
    if (
      value.status === "known" &&
      (!Number.isFinite(value.value) ||
        value.value < 0 ||
        (probability && value.value > 1))
    )
      errors.push(`invalid measure ${label}`);
  };
  const accounting = report.accounting;
  for (const key of [
    "httpAttempts",
    "questionsSent",
    "cacheHits",
    "cacheRequests",
  ] as const)
    counter(accounting[key], key);
  if (!Number.isFinite(accounting.elapsedMs) || accounting.elapsedMs < 0)
    errors.push("invalid elapsedMs");
  measurement(accounting.costUsd, "costUsd");
  for (const [kind, values] of Object.entries(accounting.auxiliary))
    for (const [source, value] of Object.entries(values))
      counter(value, `${kind}.${source}`);
  for (const inv of report.context.inventories) {
    for (const [name, value] of [
      ["discovered", inv.discovered],
      ["considered", inv.considered],
    ] as const)
      if (value.status === "known") counter(value.value, `${inv.id}.${name}`);
    for (const criterion of inv.criteria)
      if (criterion.matches.status === "known")
        counter(criterion.matches.value, `${inv.id}.matches`);
  }
  const ids = (values: { id: string }[], label: string) => {
    const set = new Set(values.map((v) => v.id));
    if (set.size !== values.length) errors.push(`duplicate ${label} IDs`);
    return set;
  };
  const items = ids(report.items, "item");
  const diagnostics = ids(report.diagnostics, "diagnostic");
  const actions = ids(report.actions, "action");
  const inventories = ids(report.context.inventories, "inventory");
  const groups = new Set(report.items.map((i) => i.groupId));
  const refs = (values: string[], set: Set<string>, label: string) => {
    for (const id of values)
      if (!set.has(id)) errors.push(`unknown ${label} ID ${id}`);
  };
  const scope = (s: Scope) => {
    if (s.kind === "item") refs(s.itemIds, items, "item");
    else if (s.kind === "group") refs(s.groupIds, groups, "group");
    else if (s.kind === "inventory")
      refs(s.inventoryIds, inventories, "inventory");
  };
  for (const item of report.items) {
    refs(item.diagnosticIds, diagnostics, "diagnostic");
    refs(item.actionIds, actions, "action");
    if (item.treatment === "judged") {
      ids(item.judgment.controls, `control in ${item.id}`);
      measurement(item.judgment.measure.value, `${item.id}.measure`, true);
      for (const raw of [
        ...item.judgment.rawValues,
        ...item.judgment.controls.flatMap((c) => c.rawValues),
      ])
        measurement(raw.probability, `${item.id}.${raw.label}`, true);
      if (
        typeof item.judgment.result === "number" &&
        !Number.isFinite(item.judgment.result)
      )
        errors.push(`invalid result ${item.id}`);
    }
  }
  for (const d of report.diagnostics) {
    scope(d.scope);
    refs(d.actionIds, actions, "action");
  }
  for (const a of report.actions) scope(a.scope);
  for (const inv of report.context.inventories)
    for (const criterion of inv.criteria)
      refs(criterion.diagnosticIds, diagnostics, "diagnostic");
  const c = report.accounting.requestedResults;
  for (const key of ["fresh", "cache", "static", "notJudged"] as const)
    counter(c[key], `requestedResults.${key}`);
  if (c.total.status === "known")
    counter(c.total.value, "requestedResults.total");
  const actual = { fresh: 0, cache: 0, static: 0, notJudged: 0 };
  for (const i of report.items) {
    if (i.treatment === "judged") actual[i.source]++;
    else if (i.treatment === "static") actual.static++;
    else actual.notJudged++;
  }
  for (const key of ["fresh", "cache", "static", "notJudged"] as const)
    if (c[key] !== actual[key])
      errors.push(`requestedResults.${key} does not match items`);
  if (c.total.status === "known" && c.total.value !== report.items.length)
    errors.push("known requested total does not match items");
  const admissible = actual.fresh + actual.cache + actual.static;
  const usefulFallback = report.items.some(
    (item) => item.treatment === "not_judged" && item.selection?.selected,
  );
  if (
    (report.execution === "refused" || report.execution === "not_judged") &&
    (admissible || usefulFallback)
  )
    errors.push("non-result execution has admissible items or useful fallback");
  if (
    (report.execution === "complete" || report.execution === "partial") &&
    !admissible &&
    !usefulFallback
  )
    errors.push("result execution has no admissible items or useful fallback");
  if (
    report.execution === "complete" &&
    (actual.notJudged ||
      report.diagnostics.some(
        (d) => d.effect === "blocking" || d.cause === "criteria_no_match",
      ))
  )
    errors.push("complete execution omits requested work");
  if (!admissible && !report.diagnostics.length)
    errors.push("absent judgment needs an explicit cause");
  return errors;
}

export function resultIsError(report: ResultReportV1): boolean {
  if (report.execution === "refused") return true;
  if (
    report.items.some(
      (i) => i.treatment !== "not_judged" || i.selection?.selected,
    )
  )
    return false;
  return report.diagnostics.some(
    (d) =>
      d.effect === "blocking" &&
      [
        "provider_context_refusal",
        "not_configured",
        "service_unavailable",
        "transport_failure",
        "invalid_response",
        "internal_error",
      ].includes(d.cause),
  );
}

/** Source must be established by the client, never guessed from footer totals. */
export function answerItemFromInput(
  common: ItemCommon,
  input: AnswerInput,
): Item {
  if (input.unjudged)
    return { ...common, treatment: "not_judged", source: "none" };
  const source = input.source ?? input.answer?.source;
  if (source !== "fresh" && source !== "cache")
    throw new Error(`Answer source not established: ${common.id}`);
  const value = input.value;
  const answer = input.answer;
  if (!value && !answer)
    throw new Error(`Answer value not established: ${common.id}`);
  const result =
    input.publicResult ??
    (answer?.type === "bool"
      ? answer.p >= 0.5
      : (value?.head ??
        (answer?.type === "choice" ? answer.choice : answer?.score)));
  if (result === undefined)
    throw new Error(`Answer result not established: ${common.id}`);
  const p =
    value?.p ??
    (answer?.type === "bool"
      ? answer.p
      : answer
        ? Math.max(...Object.values(answer.probabilities))
        : undefined);
  return {
    ...common,
    treatment: "judged",
    source,
    judgment: {
      band:
        input.band ??
        (p === undefined
          ? "unsure"
          : askBand(
              {
                head: typeof result === "boolean" ? String(result) : result,
                p,
              },
              input,
            )),
      result,
      measure: {
        kind: "probability",
        value:
          p === undefined
            ? unknown("leading probability not collected")
            : known(p),
      },
      reason: input.reason ?? "",
      uncalibrated: input.uncalibrated ?? false,
      rawValues: input.rawValues ?? [],
      controls: input.reportControls ?? [],
    },
  };
}
