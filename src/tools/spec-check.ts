import {
  type EvidenceContext,
  resolveEvidenceContext,
  withEvidenceContext,
} from "../adapters/evidence-context.ts";
import { collectFiles } from "../adapters/files.ts";
import { collectUnits } from "../adapters/git.ts";
import { resolveBase } from "../adapters/git-base.ts";
import {
  CHOICE_MAX_OPTIONS,
  STATE_MAX_CHARS,
  TIMEOUT_MS,
} from "../constants.ts";
import {
  type AnswerInput,
  type BudgetRefusal,
  buildEnvelope,
  type Envelope,
  type Limitation,
} from "../core/output.ts";
import {
  type Cause,
  known,
  type ResultReportV1,
} from "../core/result-report.ts";
import type { Judgment } from "../jev/types.ts";
import {
  prepareSpecCheck,
  readSpecJudgment,
  type SpecFinding,
} from "../presets/spec.ts";
import type { ToolDependencies } from "../runtime.ts";
import { NOT_CONFIGURED } from "../texts/configuration.ts";
import { ReviewReport, reportMetrics } from "./review-report.ts";

export interface SpecCheckResult {
  ok: boolean;
  envelope: Envelope;
  judgments: Judgment[];
  findings: SpecFinding[];
  result: ResultReportV1;
}
export async function runSpecCheck(
  deps: ToolDependencies,
  input: {
    cwd: string;
    base?: string;
    specPath?: string;
    maxCalls?: number;
    signal?: AbortSignal;
    evidenceContext?: EvidenceContext;
  },
): Promise<SpecCheckResult> {
  const started = performance.now();
  const report = new ReviewReport();
  const admission = input.evidenceContext
    ? undefined
    : await resolveEvidenceContext(input.cwd, undefined, {
        exec: deps.exec,
        signal: input.signal,
        origin: deps.evidenceOrigin,
      });
  const evidenceContext = input.evidenceContext ?? admission?.context;
  if (!evidenceContext) throw new Error("Evidence context was not established");
  evidenceContext.requestedBase = input.base ?? "HEAD";
  const judgments: Judgment[] = [];
  const findings: SpecFinding[] = [];
  const limitations: Limitation[] = [];
  const unchecked: string[] = [];
  let budget: BudgetRefusal | undefined;
  let sent = 0;
  let incomplete = false;
  let emptyBase: string | undefined;
  const finish = (
    refusal?: string,
    cause: Cause = "internal_error",
  ): SpecCheckResult => {
    const answers: AnswerInput[] = findings.map((finding) => ({
      label:
        finding.kind === "requirement"
          ? `${input.specPath}:${finding.requirement?.start}-${finding.requirement?.end} ${finding.label} — requirement violated`
          : `${finding.unit?.file}:${finding.unit?.afterRange?.start ?? finding.unit?.beforeRange?.start}-${finding.unit?.afterRange?.end ?? finding.unit?.beforeRange?.end} ${finding.label} — external behavior absent from the specification`,
      value: {
        head: finding.kind === "requirement" ? "violates" : finding.label,
        p: finding.probability,
      },
      band: incomplete ? "unsure" : "verdict",
      ...(incomplete
        ? { reason: "incomplete change evidence: read the omitted pieces" }
        : {}),
    }));
    const envelope = buildEnvelope({
      answers,
      limitations:
        emptyBase !== undefined && !refusal
          ? [
              ...limitations,
              {
                fact: `no changed units against ${emptyBase}`,
                next: "nothing judged; pass base= or check the working directory",
              },
            ]
          : limitations,
      unchecked,
      refusal,
      budget,
      ...(!refusal &&
      !budget &&
      !unchecked.length &&
      !findings.length &&
      emptyBase === undefined &&
      report.items.size > 0 &&
      [...report.items.values()].every((item) => item.treatment === "judged")
        ? {
            lines: [
              {
                type: "list" as const,
                title: "spec: no violations or drift reported",
                items: [],
              },
            ],
          }
        : {}),
      yield: {
        calls: judgments.reduce((n, j) => n + (j.calls ?? 0), 0),
        questions: judgments.reduce((n, j) => n + (j.questions ?? 0), 0),
        costUsd:
          judgments.length && judgments.every((j) => j.usage !== undefined)
            ? judgments.reduce((n, j) => n + (j.usage?.costUsd ?? 0), 0)
            : undefined,
        cacheHits: judgments.reduce((n, j) => n + (j.cacheHits ?? 0), 0),
        cacheRequests: judgments.reduce(
          (n, j) => n + (j.cacheRequests ?? 0),
          0,
        ),
        elapsedMs: performance.now() - started,
      },
    });
    if (emptyBase !== undefined)
      report.diagnose(
        "no_changed_units",
        `No changed units against ${emptyBase}`,
        emptyBase,
        [],
        false,
      );
    if (refusal) {
      report.refusal = cause !== "not_configured";
      report.diagnose(cause, refusal, input.specPath);
    }
    const result = report.build(
      "jev_check_diff",
      evidenceContext,
      reportMetrics(envelope),
    );
    return { ok: !refusal, envelope, judgments, findings, result };
  };
  if (!input.specPath)
    return finish(
      "spec_path required: no specification to check against.",
      "missing_required",
    );
  if (!deps.client) return finish(NOT_CONFIGURED, "not_configured");
  const comparison = await resolveBase(
    deps.exec,
    input.cwd,
    input.base,
    input.signal,
  );
  if (!comparison.ok)
    return finish(comparison.error, comparison.cause ?? "invalid_base");
  const base = comparison.base;
  evidenceContext.resolvedBase = base;
  const root = await deps.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd: input.cwd,
    timeout: TIMEOUT_MS,
    signal: input.signal,
  });
  if (root.code || root.killed)
    return finish(
      "Repository root not found.",
      root.killed ? "cancelled" : "git_failure",
    );
  const cwd = root.stdout.trim();
  if (evidenceContext.effectiveRoot) evidenceContext.effectiveRoot.path = cwd;
  const [collected, specification] = await Promise.all([
    collectUnits(deps.exec, { cwd, base, signal: input.signal }),
    collectFiles(cwd, [input.specPath], input.signal, { exec: deps.exec }),
  ]);
  if (!collected.ok)
    return finish(collected.error, collected.cause ?? "git_failure");
  if (!specification.ok)
    return finish(
      specification.error,
      specification.cause ?? "file_unavailable",
    );
  const text = Object.values(specification.files)[0];
  if (!text)
    return finish(
      "The specification is empty: nothing to check.",
      "empty_required",
    );
  for (const limit of collected.limits)
    limitations.push({
      fact: `${limit.file} : ${limit.kind}`,
      next: "Read the complete change before concluding.",
    });
  const unavailableUnits = collected.units.filter(
    (unit) => unit.before === null && unit.after === null,
  );
  const units = collected.units.filter(
    (unit) => unit.before !== null || unit.after !== null,
  );
  for (const unit of unavailableUnits)
    unchecked.push(`${unit.file} ${unit.name} (changed source unavailable)`);
  const prepared = prepareSpecCheck(text, units);
  for (const requirement of prepared.requirements)
    report.expect(`spec:${requirement.id}`, requirement.label, "requirement");
  report.expect("spec:drift", "Specification drift pointer", "pointer");
  report.inventories.push({
    id: "spec-requirements",
    kind: "sections",
    rules: ["### REQ- headings in the supplied specification"],
    restrictions: [input.specPath],
    discovered: known(prepared.requirements.length),
    considered: known(prepared.requirements.length),
    scopeRestricted: true,
    criteria: [],
  });
  report.inventories.push({
    id: "changed-units",
    kind: "units",
    rules: ["Changed source units against resolved base"],
    restrictions: [],
    discovered: known(collected.units.length),
    considered: known(units.length),
    scopeRestricted: false,
    criteria: [],
  });
  if (!collected.units.length && prepared.requirements.length)
    report.items.clear();
  const reportIds = [...report.items.keys()];
  for (const unit of unavailableUnits)
    report.diagnose(
      "binary_or_non_utf8",
      "Changed source unavailable",
      unit.file,
      reportIds,
      units.length === 0,
      [`${unit.file} ${unit.name}`],
    );
  for (const limit of collected.limits)
    report.diagnose(
      limit.kind === "secret_pattern" ? "secret_pattern" : "collection_omitted",
      limit.kind,
      limit.file,
      reportIds,
      units.length === 0,
      ["unit" in limit ? `${limit.file} ${limit.unit}` : limit.file],
    );
  report.missingWork =
    unavailableUnits.length > 0 || collected.limits.length > 0;
  if (!prepared.requirements.length)
    return finish(
      "No ### REQ-… requirements in the specification: nothing to check.",
      "missing_required",
    );
  if (!collected.units.length) {
    emptyBase = base;
    return finish();
  }
  if (unchecked.length) {
    unchecked.push(
      ...prepared.requirements.map(
        (requirement) => `${requirement.label} (changed source unavailable)`,
      ),
      "drift (changed source unavailable)",
    );
  }
  if (prepared.tableWarning) {
    report.diagnose(
      "unsupported_syntax",
      "Specification Markdown table interpretation is uncalibrated",
      input.specPath,
      [],
      false,
    );
    limitations.push({
      fact: "The specification contains a Markdown table.",
      next: "Read the table requirements: their interpretation is uncalibrated.",
    });
  }
  incomplete = report.missingWork;
  const state = withEvidenceContext(prepared.state, evidenceContext);
  if (
    units.length + 1 > CHOICE_MAX_OPTIONS ||
    JSON.stringify(state).length > STATE_MAX_CHARS
  )
    return finish(
      `State or spec pointer exceeds the limits; compare against a closer base (STATE_MAX_CHARS=${STATE_MAX_CHARS}).`,
      "evidence_too_large",
    );
  if (!units.length) return finish();
  const judgment = await deps.client.judge(state, prepared.questions, {
    signal: input.signal,
    ...deps.runtime.session.requestGate(),
    admissionCause: () =>
      budget?.kind === "session" ? "session_budget" : "call_budget",
    beforeRequest(questionCount) {
      if (input.maxCalls !== undefined && sent >= input.maxCalls) {
        budget = {
          kind: "max_calls",
          message: `max_calls=${input.maxCalls} reached`,
        };
        return { ok: false, error: budget.message };
      }
      const admitted = deps.runtime.session.admit(questionCount);
      if (!admitted.ok) budget = { kind: "session", message: admitted.error };
      else sent++;
      return admitted;
    },
    onUsage: (usage) => deps.runtime.session.recordUsage(usage),
  });
  judgments.push(judgment);
  if (!judgment.ok)
    report.failure(
      judgment,
      reportIds,
      budget
        ? budget.kind === "session"
          ? "session_budget"
          : "call_budget"
        : undefined,
    );
  else {
    for (const requirement of prepared.requirements)
      report.answer(
        `spec:${requirement.id}`,
        judgment.answers[requirement.id],
        { band: incomplete ? "unsure" : "verdict" },
      );
    const driftAnswer = judgment.answers.drift;
    const selectedUnit =
      driftAnswer?.type === "choice"
        ? units.find((unit) => unit.id === driftAnswer.choice)
        : undefined;
    const pointer = report.items.get("spec:drift");
    if (pointer && selectedUnit)
      report.items.set("spec:drift", {
        ...pointer,
        label: `${selectedUnit.file} ${selectedUnit.name} specification drift`,
      });
    const selectedProbability =
      driftAnswer?.type === "choice"
        ? driftAnswer.probabilities[driftAnswer.choice]
        : undefined;
    report.answer("spec:drift", driftAnswer, {
      band: incomplete ? "unsure" : "verdict",
      ...(driftAnswer?.type === "choice" && selectedProbability !== undefined
        ? {
            value: {
              head: driftAnswer.choice,
              p: selectedProbability,
            },
          }
        : {}),
    });
  }
  if (!judgment.ok) {
    unchecked.push(
      ...prepared.requirements.map((req) => `${req.label} (${judgment.error})`),
      `drift (${judgment.error})`,
    );
    return finish();
  }
  for (const requirement of prepared.requirements) {
    const answer = judgment.answers[requirement.id];
    if (!answer || answer.type === "unjudged")
      unchecked.push(requirement.label);
  }
  const drift = judgment.answers.drift;
  if (!drift || drift.type === "unjudged") unchecked.push("drift");
  findings.push(...readSpecJudgment(prepared, judgment.answers));
  return finish();
}
