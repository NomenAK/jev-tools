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
import type { Judgment } from "../jev/types.ts";
import {
  prepareSpecCheck,
  readSpecJudgment,
  type SpecFinding,
} from "../presets/spec.ts";
import type { ToolDependencies } from "../runtime.ts";
import { NOT_CONFIGURED } from "../texts/configuration.ts";

export interface SpecCheckResult {
  ok: boolean;
  envelope: Envelope;
  judgments: Judgment[];
  findings: SpecFinding[];
}
export async function runSpecCheck(
  deps: ToolDependencies,
  input: {
    cwd: string;
    base?: string;
    specPath?: string;
    maxCalls?: number;
    signal?: AbortSignal;
  },
): Promise<SpecCheckResult> {
  const started = performance.now();
  const judgments: Judgment[] = [];
  const findings: SpecFinding[] = [];
  const limitations: Limitation[] = [];
  const unchecked: string[] = [];
  let budget: BudgetRefusal | undefined;
  let sent = 0;
  let incomplete = false;
  let emptyBase: string | undefined;
  const finish = (refusal?: string): SpecCheckResult => {
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
      emptyBase === undefined
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
        costUsd: judgments.reduce((n, j) => n + (j.usage?.costUsd ?? 0), 0),
        cacheHits: judgments.reduce((n, j) => n + (j.cacheHits ?? 0), 0),
        cacheRequests: judgments.reduce(
          (n, j) => n + (j.cacheRequests ?? 0),
          0,
        ),
        elapsedMs: performance.now() - started,
      },
    });
    return { ok: !refusal, envelope, judgments, findings };
  };
  if (!input.specPath)
    return finish("spec_path required: no specification to check against.");
  if (!deps.client) return finish(NOT_CONFIGURED);
  const comparison = await resolveBase(
    deps.exec,
    input.cwd,
    input.base,
    input.signal,
  );
  if (!comparison.ok) return finish(comparison.error);
  const base = comparison.base;
  const root = await deps.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd: input.cwd,
    timeout: TIMEOUT_MS,
    signal: input.signal,
  });
  if (root.code || root.killed) return finish("Repository root not found.");
  const cwd = root.stdout.trim();
  const [collected, specification] = await Promise.all([
    collectUnits(deps.exec, { cwd, base, signal: input.signal }),
    collectFiles(cwd, [input.specPath], input.signal, { exec: deps.exec }),
  ]);
  if (!collected.ok) return finish(collected.error);
  if (!specification.ok) return finish(specification.error);
  const text = Object.values(specification.files)[0];
  if (!text) return finish("The specification is empty: nothing to check.");
  for (const limit of collected.limits)
    limitations.push({
      fact: `${limit.file} : ${limit.kind}`,
      next: "Read the complete change before concluding.",
    });
  const units = collected.units.filter((unit) => {
    if (unit.before !== null || unit.after !== null) return true;
    unchecked.push(`${unit.file} ${unit.name} (changed source unavailable)`);
    return false;
  });
  const prepared = prepareSpecCheck(text, units);
  if (!prepared.requirements.length)
    return finish(
      "No ### REQ-… requirements in the specification: nothing to check.",
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
  if (prepared.tableWarning)
    limitations.push({
      fact: "The specification contains a Markdown table.",
      next: "Read the table requirements: their interpretation is uncalibrated.",
    });
  incomplete = collected.limits.length > 0;
  if (
    units.length + 1 > CHOICE_MAX_OPTIONS ||
    JSON.stringify(prepared.state).length > STATE_MAX_CHARS
  )
    return finish(
      `State or spec pointer exceeds the limits; compare against a closer base (STATE_MAX_CHARS=${STATE_MAX_CHARS}).`,
    );
  if (!units.length) return finish();
  const judgment = await deps.client.judge(prepared.state, prepared.questions, {
    signal: input.signal,
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
