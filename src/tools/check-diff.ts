import { createHash } from "node:crypto";
import { type Static, Type } from "@sinclair/typebox";
import { createAnalysisContext } from "../adapters/analysis-context.ts";
import { collectUnits } from "../adapters/git.ts";
import { resolveBase } from "../adapters/git-base.ts";
import { shareGitInventory } from "../adapters/git-inventory.ts";
import { collectRiskCallers } from "../adapters/risk-callers.ts";
import { hostUsage } from "../adapters/usage.ts";
import {
  BAND_BOOL_GRAY_A,
  CALLER_DISPLAY_MAX_SPANS,
  CANNOT_TELL_MIN,
  FLAG_MIN,
  STATE_MAX_CHARS,
} from "../constants.ts";
import { prepareBatches } from "../core/batches.ts";
import { isTestFile } from "../core/diff.ts";
import {
  type AnswerInput,
  type BudgetRefusal,
  buildEnvelope,
  type Envelope,
  type Limitation,
} from "../core/output.ts";
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
  prepareRiskSeverity,
} from "../presets/risk.ts";
import { renderEnvelope } from "../render.ts";
import type { ToolDependencies } from "../runtime.ts";
import { CHECK_DIFF_DESCRIPTION } from "../texts/check-diff.ts";
import { NOT_CONFIGURED } from "../texts/configuration.ts";
import { runDocsCheck } from "./docs-check.ts";
import { runSpecCheck } from "./spec-check.ts";

export const checkDiffParameters = Type.Object(
  {
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
  envelope: Envelope;
  judgments: Judgment[];
  callerProofs: CallerProof[];
}
function unitLabel(unit: EvidenceUnit): string {
  const range = unit.afterRange ?? unit.beforeRange;
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
          promptGuidelines: [
            "jev_check_diff: run it once before you report done, not on a half-written diff",
          ],
        }),
    async execute(
      _id: string,
      args: CheckDiffArgs,
      signal: AbortSignal | undefined,
      _update: unknown,
      ctx: { cwd: string } & GuideContext,
    ) {
      const client = dependencies.client;
      const exec = shareGitInventory(execute);
      if (args.check === "docs" || args.check === "spec") {
        const deps = { client, host, runtime, exec };
        const result =
          args.check === "docs"
            ? await runDocsCheck(deps, {
                cwd: ctx.cwd,
                base: args.base,
                signal,
                maxCalls: args.max_calls,
              })
            : await runSpecCheck(deps, {
                cwd: ctx.cwd,
                base: args.base,
                specPath: args.spec_path,
                signal,
                maxCalls: args.max_calls,
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
            { type: "text" as const, text: renderEnvelope(result.envelope) },
          ],
          details: { ...result, callerProofs: [] },
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
      let budget: BudgetRefusal | undefined;
      let sent = 0;
      let matrixHealthy = true;
      let emptyBase: string | undefined;
      const finish = (refusal?: string) => {
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
          !refusal && matrixHealthy && !answers.length && !unchecked.length;
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
          budget,
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
            costUsd: usage.costUsd,
            cacheHits: judgments.reduce((n, j) => n + (j.cacheHits ?? 0), 0),
            cacheRequests: judgments.reduce(
              (n, j) => n + (j.cacheRequests ?? 0),
              0,
            ),
            elapsedMs: performance.now() - started,
          },
        });
        runtime.session.record(envelope);
        runtime.guide.deliver(ctx);
        return {
          content: [{ type: "text" as const, text: renderEnvelope(envelope) }],
          details: {
            ok: !refusal,
            envelope,
            judgments,
            callerProofs,
          } satisfies RiskDetails,
          ...hostUsage(host.isOmp, usage),
        };
      };
      if (!client) return finish(NOT_CONFIGURED);
      const comparison = await resolveBase(exec, ctx.cwd, args.base, signal);
      if (!comparison.ok) return finish(comparison.error);
      const base = comparison.base;
      const analysis = await createAnalysisContext();
      const collected = await collectUnits(
        exec,
        {
          cwd: ctx.cwd,
          base,
          signal,
        },
        analysis.parser,
      );
      if (!collected.ok) return finish(collected.error);
      for (const limit of collected.limits)
        limitations.push({
          fact: `${limit.file}: ${limit.kind}`,
          next: "read the complete before/after source or rerun with base= a nearer ref",
        });
      const readableUnits = collected.units.filter((unit) => {
        if (unit.before !== null || unit.after !== null) return true;
        unchecked.push(`${unitLabel(unit)} source unavailable`);
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
      if (!matrix.ok) return finish(matrix.error);
      const prepared = matrix;
      for (const warning of prepared.warnings) limitations.push(warning);
      if (JSON.stringify(prepared.state).length > STATE_MAX_CHARS)
        return finish(
          `risk state exceeds STATE_MAX_CHARS=${STATE_MAX_CHARS}; rerun with base= a nearer ref`,
        );
      const batches = prepareBatches(prepared.state, prepared.questions, {
        groups: prepared.groups,
        witnesses: prepared.witnessQuestionIds,
      });
      if (!batches.ok) return finish(batches.error);
      let reservedMatrixCalls = batches.batches.length;
      const optionsFor = (matrixRequest = false): JudgmentOptions => ({
        signal,
        beforeRequest(questionCount) {
          if (matrixRequest && reservedMatrixCalls > 0) reservedMatrixCalls--;
          const limit =
            args.max_calls === undefined
              ? undefined
              : args.max_calls - (matrixRequest ? 0 : reservedMatrixCalls);
          if (limit !== undefined && sent >= limit) {
            budget = {
              kind: "max_calls",
              message: `max_calls=${args.max_calls} reached`,
            };
            return { ok: false, error: budget.message };
          }
          const admitted = runtime.session.admit(questionCount);
          if (!admitted.ok) {
            budget = { kind: "session", message: admitted.error };
            return admitted;
          }
          sent++;
          return admitted;
        },
        onUsage: (usage) => runtime.session.recordUsage(usage),
      });
      const judge = async (
        state: State,
        questions: Record<string, Question>,
        extra?: JudgmentOptions,
        matrixRequest = false,
      ) => {
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
            { cwd: ctx.cwd, base, signal },
            collected.units,
            collected.files,
            analysis.parser,
          )
        : { proofs: [], limits: [] };
      const uncheckedCallers = new Set<string>();
      for (const limit of local.limits) {
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
          sent + reservedMatrixCalls >= args.max_calls
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
        if (!unit) continue;
        const answer = localResult.ok ? localResult.answers.caller : undefined;
        if (answer?.type !== "choice") {
          unchecked.push(`${unitLabel(unit)} local caller`);
          continue;
        }
        const p = answer.probabilities.new_failure ?? 0;
        const missing =
          (answer.probabilities.cannot_tell ?? 0) >= CANNOT_TELL_MIN;
        if (!missing && p < BAND_BOOL_GRAY_A) continue;
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
          label: `${unitLabel(unit)} reliability — static code only; ${passages}${omitted ? ` (+${omitted} passages)` : ""}`,
          value: {
            head: missing ? "cannot_tell" : "new_failure",
            p: missing ? (answer.probabilities.cannot_tell ?? 0) : p,
          },
          band: missing ? "abstain" : p >= FLAG_MIN ? "verdict" : "unsure",
          missing:
            "actual provider or binding missing; supply its declaration or an observation via jev_ask",
        };
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
      await Promise.all(
        severity.map(async (item) => {
          const request = prepareRiskSeverity(
            item.unit,
            item.dimension,
            item.evidence?.callerEvidence,
          );
          const value = await judge(request.state, request.questions);
          const answer = value.ok ? value.answers.severity : undefined;
          if (answer?.type === "score") {
            const suffix = ` · severity ${answer.score.toFixed(1)}/3`;
            for (const line of item.lines) line.label += suffix;
          } else
            unchecked.push(
              `${unitLabel(item.unit)} ${item.dimension} severity`,
            );
        }),
      );
      return finish();
    },
  };
}
