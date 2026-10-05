import { createHash } from "node:crypto";
import { type Static, Type } from "@sinclair/typebox";
import { createAnalysisContext } from "../adapters/analysis-context.ts";
import {
  type EvidenceContext,
  resolveEvidenceContext,
  withEvidenceContext,
} from "../adapters/evidence-context.ts";
import { collectUnits } from "../adapters/git.ts";
import { resolveBase } from "../adapters/git-base.ts";
import { shareGitInventory, shareGitTree } from "../adapters/git-inventory.ts";
import { collectRiskCallers } from "../adapters/risk-callers.ts";
import { hostUsage } from "../adapters/usage.ts";
import {
  BAND_BOOL_GRAY_A,
  CALLER_DISPLAY_MAX_SPANS,
  CANNOT_TELL_MIN,
  FLAG_MIN,
  STATE_MAX_CHARS,
  TIMEOUT_MS,
} from "../constants.ts";
import { prepareBatches } from "../core/batches.ts";
import { isTestFile } from "../core/diff.ts";
import {
  type AnswerInput,
  buildEnvelope,
  type Envelope,
  type Limitation,
} from "../core/output.ts";
import {
  type Cause,
  known,
  type ResultReportV1,
} from "../core/result-report.ts";
import type { CallerProof, EvidenceSpan } from "../core/risk-callers.ts";
import type { EvidenceUnit } from "../core/units.ts";
import type { GuideContext } from "../guide.ts";
import type {
  Judgment,
  JudgmentOptions,
  Question,
  State,
} from "../jev/types.ts";
import {
  type BuiltinRiskDimension,
  evaluateWitnessHealth,
  prepareRiskMatrix,
  prepareSeverityBatch,
} from "../presets/risk.ts";
import { renderResultReport } from "../render.ts";
import type { ToolDependencies } from "../runtime.ts";
import { CHECK_DIFF_DESCRIPTION } from "../texts/check-diff.ts";
import { NOT_CONFIGURED } from "../texts/configuration.ts";
import { CHECK_DIFF_GUIDELINE } from "../texts/instructions.ts";
import { runDocsCheck } from "./docs-check.ts";
import { createJudgeOptions } from "./judge-options.ts";
import { controlsFor, ReviewReport, reportMetrics } from "./review-report.ts";
import { runSpecCheck } from "./spec-check.ts";

export const checkDiffParameters = Type.Object(
  {
    root: Type.Optional(Type.String()),
    check: Type.Union([
      Type.Literal("risk"),
      Type.Literal("docs"),
      Type.Literal("spec"),
    ]),
    base: Type.Optional(Type.String({ minLength: 1 })),
    spec_path: Type.Optional(Type.String({ minLength: 1 })),
    witnesses: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("auto"),
        Type.Literal("on"),
      ]),
    ),
    dimensions: Type.Optional(
      Type.Record(Type.String(), Type.String({ minLength: 1 })),
    ),
    only: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    max_calls: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type CheckDiffArgs = Static<typeof checkDiffParameters>;
export interface RiskDetails {
  ok: boolean;
  evidenceContext: EvidenceContext;
  result: ResultReportV1;
  envelope: Envelope;
  judgments: Judgment[];
  callerProofs: CallerProof[];
}
function unitLabel(unit: EvidenceUnit): string {
  const range = unit.afterRange ?? unit.beforeRange;
  // Display width only, not a policy or an identity: the first 8 hex chars
  // just make the label short while still distinguishing changed units by eye.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([unit.file, unit.name, unit.before, unit.after]))
    .digest("hex")
    .slice(0, 8);
  return `${unit.file}${range ? `:${range.start}-${range.end}` : ""} ${unit.name} [${fingerprint}]`;
}
export function createCheckDiffTool(dependencies: ToolDependencies) {
  const { host, runtime, exec: execute } = dependencies;
  return {
    name: "jev_check_diff",
    label: "Jev check diff",
    description: CHECK_DIFF_DESCRIPTION,
    parameters: checkDiffParameters,
    ...(host.isOmp
      ? { approval: "read" as const, loadMode: "essential" as const }
      : {
          promptSnippet:
            "Check the uncommitted diff for risky changes, stale docs or spec drift",
          promptGuidelines: [CHECK_DIFF_GUIDELINE],
        }),
    async execute(
      _id: string,
      args: CheckDiffArgs,
      signal: AbortSignal | undefined,
      _update: unknown,
      ctx: { cwd: string } & GuideContext,
    ) {
      const client = dependencies.client;
      const evidence = await resolveEvidenceContext(ctx.cwd, args.root, {
        exec: execute,
        signal,
        origin: dependencies.evidenceOrigin,
      });
      const evidenceContext = evidence.context;
      const report = new ReviewReport();
      const cwd = evidence.ok ? evidence.cwd : evidenceContext.authority.path;
      // collectUnits and collectRiskCallers both ask git for the repository
      // root and the base tree over the same cwd and ref.
      const exec = shareGitTree(shareGitInventory(execute));
      if (!evidence.ok) {
        const envelope = buildEnvelope({
          refusal: evidence.error,
          yield: {
            calls: 0,
            questions: 0,
            cacheHits: 0,
            cacheRequests: 0,
            elapsedMs: 0,
          },
        });
        runtime.session.record(envelope);
        runtime.guide.deliver(ctx);
        report.refusal = true;
        report.diagnose(evidence.cause, evidence.error, args.root);
        const result = report.build(
          "jev_check_diff",
          evidenceContext,
          reportMetrics(envelope),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: renderResultReport(result, { details: envelope }),
            },
          ],
          details: {
            ok: false,
            envelope,
            judgments: [],
            callerProofs: [],
            evidenceContext,
            result,
          },
        };
      }
      evidenceContext.requestedBase = args.base ?? "HEAD";
      if (args.check === "docs" || args.check === "spec") {
        const deps = { client, host, runtime, exec };
        const result =
          args.check === "docs"
            ? await runDocsCheck(deps, {
                cwd: cwd,
                base: args.base,
                signal,
                maxCalls: args.max_calls,
                evidenceContext,
              })
            : await runSpecCheck(deps, {
                cwd: cwd,
                base: args.base,
                specPath: args.spec_path,
                signal,
                maxCalls: args.max_calls,
                evidenceContext,
              });
        runtime.session.record(result.envelope);
        runtime.guide.deliver(ctx);
        const usage = result.judgments.reduce(
          (sum, judgment) => ({
            inputTokens: sum.inputTokens + (judgment.usage?.inputTokens ?? 0),
            costUsd: sum.costUsd + (judgment.usage?.costUsd ?? 0),
          }),
          { inputTokens: 0, costUsd: 0 },
        );
        return {
          content: [
            {
              type: "text" as const,
              text: renderResultReport(result.result, {
                details: result.envelope,
              }),
            },
          ],
          details: { ...result, callerProofs: [], evidenceContext },
          ...hostUsage(host.isOmp, usage),
        };
      }
      const started = performance.now();
      const judgments: Judgment[] = [];
      const callerProofs: CallerProof[] = [];
      const answers: AnswerInput[] = [];
      const unitOrder = new Map<AnswerInput, string>();
      const limitations: Limitation[] = [];
      const unchecked: string[] = [];
      const {
        options: judgeOptions,
        budget,
        gateWith,
        spent,
      } = createJudgeOptions({
        signal,
        maxCalls: args.max_calls,
        session: runtime.session,
      });
      let matrixHealthy = true;
      let emptyBase: string | undefined;
      const finish = (refusal?: string, cause?: Cause) => {
        answers.sort((a, b) =>
          (unitOrder.get(a) ?? "").localeCompare(unitOrder.get(b) ?? ""),
        );
        const uniqueLimitations = [
          ...new Map(
            limitations.map((limit) => [`${limit.fact}\0${limit.next}`, limit]),
          ).values(),
        ];
        const usage = judgments.reduce(
          (sum, value) => ({
            inputTokens: sum.inputTokens + (value.usage?.inputTokens ?? 0),
            costUsd: sum.costUsd + (value.usage?.costUsd ?? 0),
          }),
          { inputTokens: 0, costUsd: 0 },
        );
        const noFindings =
          !refusal &&
          matrixHealthy &&
          !answers.length &&
          !unchecked.length &&
          report.items.size > 0 &&
          [...report.items.values()].every(
            (item) => item.treatment === "judged",
          );
        const envelope = buildEnvelope({
          answers,
          limitations:
            emptyBase !== undefined && !refusal
              ? [
                  ...uniqueLimitations,
                  {
                    fact: `no changed units against ${emptyBase}`,
                    next: "nothing judged; pass base= or check the working directory",
                  },
                ]
              : uniqueLimitations,
          unchecked: [...new Set(unchecked)],
          budget: budget(),
          ...(refusal ? { refusal } : {}),
          ...(noFindings && emptyBase === undefined
            ? {
                lines: [
                  {
                    type: "list" as const,
                    title: "risk: no findings",
                    items: [],
                  },
                ],
              }
            : {}),
          yield: {
            calls: judgments.reduce((n, j) => n + (j.calls ?? 0), 0),
            questions: judgments.reduce((n, j) => n + (j.questions ?? 0), 0),
            costUsd:
              judgments.every((j) => j.usage !== undefined) &&
              judgments.length > 0
                ? usage.costUsd
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
            `No changed units against ${emptyBase}; no risk judgment requested.`,
            emptyBase,
            [],
            false,
          );
        if (
          refusal &&
          !report.diagnostics.some((d) => d.effect === "blocking")
        ) {
          report.refusal = refusal !== NOT_CONFIGURED;
          report.diagnose(cause ?? "internal_error", refusal);
        }
        const result = report.build(
          "jev_check_diff",
          evidenceContext,
          reportMetrics(envelope),
        );
        runtime.session.record(envelope);
        runtime.guide.deliver(ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: renderResultReport(result, { details: envelope }),
            },
          ],
          details: {
            evidenceContext,
            result,
            ok: !refusal,
            envelope,
            judgments,
            callerProofs,
          } satisfies RiskDetails,
          ...hostUsage(host.isOmp, usage),
        };
      };
      if (!client) return finish(NOT_CONFIGURED, "not_configured");
      const comparison = await resolveBase(exec, cwd, args.base, signal);
      if (!comparison.ok)
        return finish(comparison.error, comparison.cause ?? "invalid_base");
      evidenceContext.resolvedBase = comparison.base;
      const base = comparison.base;
      const analysis = await createAnalysisContext();
      const collected = await collectUnits(
        exec,
        {
          cwd: cwd,
          base,
          signal,
        },
        analysis.parser,
      );
      if (!collected.ok)
        return finish(collected.error, collected.cause ?? "git_failure");
      const repositoryRoot = await exec(
        "git",
        ["rev-parse", "--show-toplevel"],
        { cwd, timeout: TIMEOUT_MS, signal },
      );
      if (
        !repositoryRoot.code &&
        !repositoryRoot.killed &&
        evidenceContext.effectiveRoot
      )
        evidenceContext.effectiveRoot.path = repositoryRoot.stdout.trim();
      report.inventories.push({
        id: "changed-units",
        kind: "units",
        rules: [
          "Changed source units against resolved base; tests are evidence, not risk units",
        ],
        restrictions: args.only ?? [],
        discovered: known(collected.units.length),
        considered: known(collected.units.length),
        scopeRestricted: Boolean(args.only?.length),
        criteria: [],
      });
      for (const unit of collected.units)
        report.expect(`unit:${unit.id}`, unitLabel(unit), "unit");
      for (const limit of collected.limits)
        report.diagnose(
          limit.kind === "secret_pattern"
            ? "secret_pattern"
            : "collection_omitted",
          `${limit.file}: ${limit.kind}`,
          limit.file,
        );
      for (const limit of collected.limits)
        limitations.push({
          fact: `${limit.file}: ${limit.kind}`,
          next: "read the complete before/after source or rerun with base= a nearer ref",
        });
      const readableUnits = collected.units.filter((unit) => {
        if (unit.before !== null || unit.after !== null) return true;
        unchecked.push(`${unitLabel(unit)} source unavailable`);
        report.diagnose(
          "binary_or_non_utf8",
          "Changed source unavailable",
          unit.file,
          [`unit:${unit.id}`],
        );
        return false;
      });
      if (!collected.units.length) {
        emptyBase = base;
        return finish();
      }
      if (!readableUnits.length) return finish();
      const matrix = prepareRiskMatrix(readableUnits, {
        ...args,
        testFilesPresent: collected.files.some((file) => isTestFile(file.path)),
      });
      if (!matrix.ok) return finish(matrix.error, "invalid_arguments");
      const prepared = matrix;
      prepared.state = withEvidenceContext(prepared.state, evidenceContext);
      for (const unit of readableUnits) report.items.delete(`unit:${unit.id}`);
      for (const cell of prepared.cells)
        report.expect(
          `risk:${cell.id}`,
          `${cell.unitId} ${cell.dimension}`,
          "unit",
          `risk:${cell.unitId}`,
        );
      for (const warning of prepared.warnings) {
        limitations.push(warning);
        report.diagnose(
          "unsupported_syntax",
          warning.fact,
          undefined,
          [],
          false,
        );
      }
      if (JSON.stringify(prepared.state).length > STATE_MAX_CHARS)
        return finish(
          `risk state exceeds STATE_MAX_CHARS=${STATE_MAX_CHARS}; rerun with base= a nearer ref`,
          "evidence_too_large",
        );
      const batches = prepareBatches(prepared.state, prepared.questions, {
        groups: prepared.groups,
        witnesses: prepared.witnessQuestionIds,
      });
      if (!batches.ok) return finish(batches.error, "group_too_large");
      let reservedMatrixCalls = batches.batches.length;
      const optionsFor = (matrixRequest = false): JudgmentOptions => ({
        ...judgeOptions,
        beforeRequest(questionCount) {
          if (matrixRequest && reservedMatrixCalls > 0) reservedMatrixCalls--;
          return gateWith(matrixRequest ? 0 : reservedMatrixCalls)(
            questionCount,
          );
        },
      });
      const judge = async (
        state: State,
        questions: Record<string, Question>,
        extra?: JudgmentOptions,
        matrixRequest = false,
      ) => {
        state = withEvidenceContext(state, evidenceContext);
        if (JSON.stringify(state).length > STATE_MAX_CHARS)
          return {
            ok: false as const,
            error: `required evidence exceeds STATE_MAX_CHARS=${STATE_MAX_CHARS}`,
          };
        const result = await client.judge(state, questions, {
          ...optionsFor(matrixRequest),
          ...extra,
        });
        judgments.push(result);
        return result;
      };
      const local = prepared.dimensions.some(
        (dimension) => dimension.name === "reliability",
      )
        ? await collectRiskCallers(
            exec,
            { cwd: cwd, base, signal },
            collected.units,
            collected.files,
            analysis.parser,
          )
        : { proofs: [], limits: [] };
      const uncheckedCallers = new Set<string>();
      for (const limit of local.limits) {
        if (limit.kind !== "dynamic_access_uncovered") {
          const id = `caller:${limit.unitId}`;
          report.expect(id, `${limit.unitId} local caller`, "unit");
          report.diagnose(
            "collection_omitted",
            limit.reason,
            limit.paths.join(" + "),
            [id],
          );
        } else
          report.diagnose(
            "dynamic_dependency",
            limit.reason,
            limit.paths.join(" + "),
            [],
            false,
          );
        limitations.push({
          fact: `${limit.unitId}: ${limit.reason} — ${limit.paths.join(" + ")}`,
          next: "read the named caller/provider pieces or supply an observation via jev_ask",
        });
        if (
          limit.kind !== "dynamic_access_uncovered" &&
          !uncheckedCallers.has(limit.unitId)
        ) {
          uncheckedCallers.add(limit.unitId);
          unchecked.push(
            `${limit.unitId} local caller ${limit.paths.join(" + ")}`,
          );
        }
      }
      const matrixPromise = judge(
        prepared.state,
        prepared.questions,
        { groups: prepared.groups, witnesses: prepared.witnessQuestionIds },
        true,
      ).finally(() => {
        reservedMatrixCalls = 0;
      });
      const localPromises = local.proofs.map(async (proof) => {
        if (
          args.max_calls !== undefined &&
          spent() + reservedMatrixCalls >= args.max_calls
        )
          await matrixPromise;
        return {
          proof,
          result: await judge(proof.state, { caller: proof.question }),
        };
      });
      const [result, locals] = await Promise.all([
        matrixPromise,
        Promise.all(localPromises),
      ]);
      const health = result.ok
        ? evaluateWitnessHealth(prepared, result)
        : {
            healthy: false,
            controls: [],
            unhealthyQuestionIds: new Map<string, string>(),
          };
      matrixHealthy = health.healthy;
      for (const failure of health.controls)
        report.diagnose(
          health.healthy ? "conservative_widening" : "control_failure",
          failure.fact,
          undefined,
          prepared.cells
            .filter((cell) => health.unhealthyQuestionIds.has(cell.id))
            .map((cell) => `risk:${cell.id}`),
          false,
        );
      report.countControls(result, prepared.witnessQuestionIds);
      for (const cell of prepared.cells) {
        const rawAnswer = result.ok ? result.answers[cell.id] : undefined;
        const answer =
          rawAnswer?.type === "unjudged" && !rawAnswer.cause && budget()
            ? {
                ...rawAnswer,
                cause:
                  budget()?.kind === "session"
                    ? ("session_budget" as const)
                    : ("call_budget" as const),
              }
            : rawAnswer;
        const invalid = health.unhealthyQuestionIds.get(cell.id);
        if (!result.ok)
          report.failure(
            result,
            [`risk:${cell.id}`],
            budget()
              ? budget()?.kind === "session"
                ? "session_budget"
                : "call_budget"
              : undefined,
          );
        else
          report.answer(
            `risk:${cell.id}`,
            answer,
            {
              band: invalid ? "unsure" : "verdict",
              reason: invalid,
              uncalibrated: cell.uncalibrated,
            },
            controlsFor(cell.id, result, prepared.witnessQuestionIds),
            false,
          );
      }
      const decoys = new Set(
        prepared.witnesses
          .filter((witness) => witness.expected === "no")
          .map((witness) => witness.unitId),
      ).size;
      const references = new Set(
        prepared.witnesses
          .filter((witness) => witness.expected === "yes")
          .map((witness) => witness.unitId),
      ).size;
      const witnessStatus = health.healthy
        ? "healthy"
        : !result.ok ||
            health.controls.some((control) =>
              control.fact.includes("unavailable"),
            )
          ? "unavailable"
          : "unhealthy";
      limitations.push({
        fact: prepared.witnesses.length
          ? `risk matrix: ${decoys} decoys and ${references} references ${witnessStatus}`
          : "risk matrix: witnesses disabled",
        next: "read the findings and stated limits",
      });
      limitations.push(...health.controls);
      if (!result.ok)
        limitations.push({
          fact: `risk matrix: ${result.error}`,
          next: "check Jev configuration and availability, then retry",
        });
      const severity: {
        unit: EvidenceUnit;
        dimension: BuiltinRiskDimension;
        lines: AnswerInput[];
        evidence?: State;
      }[] = [];
      for (const cell of prepared.cells) {
        const unit = collected.units.find((u) => u.id === cell.unitId);
        if (!unit) continue;
        const answer = result.ok ? result.answers[cell.id] : undefined;
        if (answer?.type !== "bool") {
          unchecked.push(`${unitLabel(unit)} ${cell.dimension}`);
          continue;
        }
        if (answer.p < FLAG_MIN) continue;
        const reason = health.unhealthyQuestionIds.get(cell.id);
        const line: AnswerInput = {
          label: `${unitLabel(unit)} ${cell.dimension}${reason ? ` — ${reason}` : ""}`,
          value: { head: "risk", p: answer.p },
          band: reason ? "unsure" : "verdict",
          uncalibrated: cell.uncalibrated,
        };
        answers.push(line);
        unitOrder.set(line, unit.id);
        if (!cell.uncalibrated)
          severity.push({ unit, dimension: cell.dimension, lines: [line] });
      }
      for (const { proof, result: localResult } of locals) {
        callerProofs.push(proof);
        const unit = collected.units.find((u) => u.id === proof.unitId);
        const reportId = `caller:${proof.unitId}`;
        report.expect(
          reportId,
          `${unit ? unitLabel(unit) : proof.unitId} local caller`,
          "unit",
        );
        if (!localResult.ok) {
          report.failure(
            localResult,
            [reportId],
            budget()
              ? budget()?.kind === "session"
                ? "session_budget"
                : "call_budget"
              : undefined,
          );
          continue;
        }
        const answer = localResult.answers.caller;
        if (answer?.type !== "choice") {
          report.answer(reportId, answer);
          unchecked.push(
            `${unit ? unitLabel(unit) : proof.unitId} local caller`,
          );
          continue;
        }
        const p = answer.probabilities.new_failure ?? 0;
        const missing =
          (answer.probabilities.cannot_tell ?? 0) >= CANNOT_TELL_MIN;
        const negative = !missing && p < BAND_BOOL_GRAY_A;
        const merged: EvidenceSpan[] = [];
        for (const span of [...proof.paths].sort(
          (a, b) =>
            a.path.localeCompare(b.path) || a.start - b.start || a.end - b.end,
        )) {
          const previous = merged.at(-1);
          if (
            previous &&
            previous.path === span.path &&
            span.start <= previous.end + 1
          )
            previous.end = Math.max(previous.end, span.end);
          else merged.push({ ...span });
        }
        const omitted = Math.max(0, merged.length - CALLER_DISPLAY_MAX_SPANS);
        const passages = merged
          .slice(0, CALLER_DISPLAY_MAX_SPANS)
          .map((span) => `${span.path}:${span.start}-${span.end}`)
          .join(" + ");
        const line: AnswerInput = {
          label: `${unit ? unitLabel(unit) : proof.unitId} reliability — static code only; ${passages}${omitted ? ` (+${omitted} passages)` : ""}`,
          value: {
            head: missing
              ? "cannot_tell"
              : negative
                ? "no_new_failure"
                : "new_failure",
            p: missing
              ? (answer.probabilities.cannot_tell ?? 0)
              : negative
                ? (answer.probabilities.no_new_failure ?? 0)
                : p,
          },
          band: missing
            ? "abstain"
            : negative || p >= FLAG_MIN
              ? "verdict"
              : "unsure",
          reason: missing
            ? "actual provider or binding missing; supply its declaration or an observation via jev_ask"
            : negative
              ? "Local caller check does not flag a new failure; static evidence does not prove every caller safe."
              : p < FLAG_MIN
                ? "Local caller new-failure probability is in the gray band; inspect the stated proof passages natively."
                : "Local caller new-failure probability meets the finding threshold; static code evidence only.",
        };
        const callerItem = report.items.get(reportId);
        if (callerItem)
          report.items.set(reportId, { ...callerItem, label: line.label });
        report.answer(reportId, answer, line);
        if (missing && line.reason)
          report.diagnose(
            "missing_required",
            line.reason,
            line.label,
            [reportId],
            false,
          );
        if (!unit || negative) continue;
        answers.push(line);
        unitOrder.set(line, unit.id);
        if (!missing && p >= FLAG_MIN) {
          const existing = severity.find(
            (item) =>
              item.unit.id === unit.id && item.dimension === "reliability",
          );
          if (existing) {
            existing.evidence = proof.state;
            existing.lines.push(line);
          } else
            severity.push({
              unit,
              dimension: "reliability",
              lines: [line],
              evidence: proof.state,
            });
        }
      }
      // One severity request per unit: every dimension of that unit shares its
      // state, so several score questions ride a single request under
      // REQUEST_MAX_TOKENS instead of one request each.
      const byUnit = new Map<string, typeof severity>();
      for (const item of severity) {
        const key = `${item.unit.id}:${item.evidence ? "caller" : "unit"}`;
        const group = byUnit.get(key) ?? [];
        group.push(item);
        byUnit.set(key, group);
      }
      await Promise.all(
        [...byUnit.values()].map(async (group) => {
          const request = prepareSeverityBatch(
            group.map((item) => ({
              unit: item.unit,
              dimension: item.dimension,
              ...(item.evidence?.callerEvidence !== undefined
                ? { callerEvidence: item.evidence.callerEvidence }
                : {}),
            })),
          );
          const value = await judge(request.state, request.questions);
          for (const [index, item] of group.entries()) {
            const id = request.ids[index] as string;
            const reportId = `severity:${item.unit.id}:${item.dimension}`;
            report.expect(
              reportId,
              `${item.unit.id} ${item.dimension} severity`,
              "unit",
            );
            if (value.ok) report.answer(reportId, value.answers[id]);
            else
              report.failure(
                value,
                [reportId],
                budget()
                  ? budget()?.kind === "session"
                    ? "session_budget"
                    : "call_budget"
                  : undefined,
              );
            const answer = value.ok ? value.answers[id] : undefined;
            if (answer?.type === "score") {
              const suffix = ` · severity ${answer.score.toFixed(1)}/3`;
              for (const line of item.lines) line.label += suffix;
            } else
              unchecked.push(
                `${unitLabel(item.unit)} ${item.dimension} severity`,
              );
          }
        }),
      );
      return finish();
    },
  };
}
