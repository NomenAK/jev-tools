import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { collectAskFiles } from "../adapters/ask-files.ts";
import {
  resolveEvidenceContext,
  withEvidenceContext,
} from "../adapters/evidence-context.ts";
import { shareGitInventory } from "../adapters/git-inventory.ts";
import { hostUsage } from "../adapters/usage.ts";
import { STATE_MAX_CHARS } from "../constants.ts";
import {
  compileAsks,
  readAsks,
  reverseQuestions,
  sameSubjectQuestions,
} from "../core/asks.ts";
import { checkIntegrity } from "../core/integrity.ts";
import type { AnswerInput, Envelope, EnvelopeInput } from "../core/output.ts";
import { buildEnvelope } from "../core/output.ts";
import {
  type Action,
  answerItemFromInput,
  buildResultReport,
  type Cause,
  contextFromEvidence,
  type Diagnostic,
  type Item,
  known,
  type ResultReportV1,
  unknown,
} from "../core/result-report.ts";
import { interpolate } from "../describe.ts";
import type { GuideContext } from "../guide.ts";
import type { Answer, Judgment, JudgmentMetadata } from "../jev/types.ts";
import { renderResultReport } from "../render.ts";
import type { ToolDependencies } from "../runtime.ts";
import { ASK_FILES_DESCRIPTION } from "../texts/ask-files.ts";
import { NOT_CONFIGURED } from "../texts/configuration.ts";
import { asksParameter } from "./ask-schema.ts";
import { createJudgeOptions } from "./judge-options.ts";

export const askFilesParameters = Type.Object(
  {
    root: Type.Optional(Type.String()),
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    asks: asksParameter("files"),
    max_calls: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type AskFilesArgs = Static<typeof askFilesParameters>;
interface FileJudgment {
  path: string;
  initial: Judgment;
  reversed?: Judgment;
}
export interface AskFilesDetails {
  files: FileJudgment[];
  skipped: string[];
  envelope: Envelope;
  result: ResultReportV1;
}
export function createAskFilesTool(dependencies: ToolDependencies) {
  const { host, runtime, exec: execute } = dependencies;
  return {
    name: "jev_ask_files",
    label: "Jev ask files",
    description: interpolate(ASK_FILES_DESCRIPTION, host.names),
    parameters: askFilesParameters,
    ...(host.isOmp
      ? { approval: "read" as const, loadMode: "essential" as const }
      : {
          promptSnippet:
            "Typed answers about many files from intents you declare, without reading them",
          promptGuidelines: [
            "jev_ask_files: put every ask in one call; prefer typed intents (verify, classify, rate, decide) over free",
            "jev_ask_files: use it to decide what to read, then read only the files that matter",
          ],
        }),
    async execute(
      _id: string,
      args: AskFilesArgs,
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
      const cwd = evidence.ok ? evidence.cwd : evidenceContext.authority.path;
      const started = performance.now();
      const exec = shareGitInventory(execute);
      const plan = compileAsks(args.asks, { surface: "files" });
      let refusalCause: Cause = "invalid_arguments";
      let collectedPaths: string[] | undefined;
      let costKnown = true;
      const reportItems: Item[] = [];
      const diagnostics: Diagnostic[] = [];
      const actions: Action[] = [];
      const auxiliary = {
        controls: { fresh: 0, cache: 0, notJudged: 0, static: 0 },
        passages: { fresh: 0, cache: 0, notJudged: 0 },
      };
      const diagnose = (
        cause: Cause,
        fact: string,
        scope: Diagnostic["scope"],
        target?: string,
      ) => {
        const id = `diagnostic:${diagnostics.length}`,
          actionId = `action:${actions.length}`;
        actions.push({
          id: actionId,
          code:
            cause === "invalid_root"
              ? "correct_context"
              : cause === "not_configured"
                ? "configure_client"
                : "inspect_native",
          target:
            target === undefined
              ? unknown("target not established")
              : known(target),
          scope,
          condition:
            "Only after correcting context or supplying materially new evidence",
          instruction:
            "Read the admitted files natively; do not repeat the unchanged Jev call.",
          repeatUnchanged: false,
        });
        diagnostics.push({
          id,
          cause,
          fact,
          target:
            target === undefined
              ? unknown("target not established")
              : known(target),
          origin:
            cause === "call_budget" || cause === "session_budget"
              ? "budget"
              : "collection",
          scope,
          effect: "blocking",
          material: true,
          omittedMembers: [],
          memberCount: known(0),
          actionIds: [actionId],
        });
        return { diagnosticIds: [id], actionIds: [actionId] };
      };
      const totals = {
        calls: 0,
        questions: 0,
        cacheHits: 0,
        cacheRequests: 0,
        inputTokens: 0,
        costUsd: 0,
      };
      const records: FileJudgment[] = [];
      let skipped: string[] = [];
      const finish = (input: Omit<EnvelopeInput, "yield">) => {
        const envelope = buildEnvelope({
          ...input,
          yield: { ...totals, elapsedMs: performance.now() - started },
        });
        runtime.session.record(envelope);
        runtime.guide.deliver(ctx);
        if (!reportItems.length && !diagnostics.length)
          diagnose(
            input.refusal ? refusalCause : "collection_empty",
            input.refusal ?? "No file-question results collected",
            { kind: "call" },
          );
        if (!reportItems.length && collectedPaths && plan.ok)
          for (const path of collectedPaths)
            for (const reading of plan.readings)
              reportItems.push({
                id: `${path}:${reading.id}`,
                kind: "file_question",
                label: `${path}  ${reading.label}`,
                groupId: `${path}:group:${plan.groups.findIndex((group) => group.includes(reading.id))}`,
                evidence: [
                  {
                    target: path,
                    canonicalPath: known(resolve(cwd, path)),
                    aliases: [],
                    side: "current",
                    revision: unknown("working tree evidence"),
                  },
                ],
                diagnosticIds: diagnostics.map((diagnostic) => diagnostic.id),
                actionIds: actions.map((action) => action.id),
                treatment: "not_judged",
                source: "none",
              });
        for (const limitation of input.limitations ?? []) {
          diagnose(
            "evidence_limit",
            limitation.fact,
            { kind: "call" },
            limitation.path,
          );
          const diagnostic = diagnostics.at(-1);
          if (diagnostic) diagnostic.effect = "reservation";
        }
        const report = buildResultReport({
          tool: "jev_ask_files",
          context: contextFromEvidence(evidenceContext, {
            inventories: collectedPaths
              ? [
                  {
                    id: "files",
                    kind: "repository",
                    rules: [
                      "Requested paths expanded with admission and pruning",
                    ],
                    restrictions: args.paths,
                    discovered: unknown(
                      "collector does not expose pre-pruning candidate count",
                    ),
                    considered: known(collectedPaths.length),
                    scopeRestricted: true,
                    criteria: [],
                  },
                ]
              : [],
          }),
          items: reportItems,
          diagnostics,
          actions,
          metrics: {
            ...totals,
            costUsd: costKnown && collectedPaths ? totals.costUsd : undefined,
            elapsedMs: performance.now() - started,
          },
          auxiliary,
          total:
            collectedPaths && plan.ok
              ? known(collectedPaths.length * plan.readings.length)
              : unknown("file-question inventory not collected"),
          refused: !!input.refusal && refusalCause !== "not_configured",
        });
        const usage = hostUsage(host.isOmp, {
          inputTokens: totals.inputTokens,
          costUsd: totals.costUsd,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: renderResultReport(report, { details: envelope }),
            },
          ],
          details: {
            files: records,
            skipped,
            envelope,
            evidenceContext,
            result: report,
          },
          ...usage,
        };
      };
      if (!evidence.ok) {
        refusalCause = evidence.cause ?? "invalid_root";
        return finish({ refusal: evidence.error });
      }
      if (!plan.ok) return finish({ refusal: plan.error });
      if (!client) {
        refusalCause = "not_configured";
        return finish({ refusal: NOT_CONFIGURED });
      }
      const collected = await collectAskFiles(cwd, args.paths, signal, exec);
      if (!collected.ok) {
        refusalCause = collected.cause ?? "file_unavailable";
        return finish({ refusal: collected.error });
      }
      collectedPaths = collected.files.map((file) => file.path);
      skipped = collected.skipped;
      for (const skippedPath of skipped)
        diagnose(
          collected.secret.includes(skippedPath)
            ? "secret_pattern"
            : "collection_omitted",
          skippedPath,
          { kind: "inventory", inventoryIds: ["files"] },
        );
      if (!collected.files.length && skipped.length)
        return finish({
          refusal: `No readable evidence: ${skipped.join("; ")}`,
        });
      const states = collected.files.map((file) => ({
        file,
        state: withEvidenceContext(
          { path: file.path, content: file.content },
          evidenceContext,
        ),
      }));
      if (
        states.some(
          ({ state }) => JSON.stringify(state).length > STATE_MAX_CHARS,
        )
      ) {
        refusalCause = "evidence_too_large";
        return finish({
          refusal: `required evidence exceeds STATE_MAX_CHARS=${STATE_MAX_CHARS}`,
        });
      }
      const { options, budget } = createJudgeOptions({
        signal,
        maxCalls: args.max_calls,
        session: runtime.session,
      });
      // Same-subject controls are judged in a second round only, per file,
      // for contradicted first-round verdicts.
      const secondRound = new Set(
        plan.readings.flatMap((reading) =>
          reading.sameSubject ? [reading.sameSubject] : [],
        ),
      );
      const firstRound = Object.fromEntries(
        Object.entries(plan.questions).filter(([id]) => !secondRound.has(id)),
      );
      const accumulate = (result: JudgmentMetadata) => {
        totals.calls += result.calls ?? 0;
        totals.questions += result.questions ?? 0;
        totals.cacheHits += result.cacheHits ?? 0;
        totals.cacheRequests += result.cacheRequests ?? 0;
        totals.inputTokens += result.usage?.inputTokens ?? 0;
        totals.costUsd += result.usage?.costUsd ?? 0;
        if (!result.usage && result.calls !== 0) costKnown = false;
      };
      const rows = await Promise.all(
        states.map(async ({ file, state }) => {
          const integrity = checkIntegrity(state, plan.asks, [
            {
              ...file.identity,
              insertedPath: resolve(cwd, file.path),
              content: file.content,
              insertedSha256: createHash("sha256")
                .update(file.content)
                .digest("hex"),
            },
          ]);
          const initial = await client.judge(state, firstRound, {
            ...options,
            groups: plan.groups,
          });
          accumulate(initial);
          let reversed: Judgment | undefined;
          let reverseAnswers: Record<string, Answer> | undefined;
          if (initial.ok) {
            const questions = reverseQuestions(plan, initial.answers);
            if (Object.keys(questions).length) {
              reversed = await client.judge(state, questions, options);
              accumulate(reversed);
              reverseAnswers = reversed.ok
                ? reversed.answers
                : Object.fromEntries(
                    Object.keys(questions).map((id) => [
                      id,
                      {
                        type: "unjudged" as const,
                        reason:
                          reversed && !reversed.ok
                            ? reversed.error
                            : "reverse control failed",
                      },
                    ]),
                  );
            }
            // Same-subject controls: one extra judge call for every
            // contradicted first-round verdict. It counts against max_calls
            // through options; a refused or failed round leaves each control
            // unjudged so readAsks demotes the contradiction.
            const controls = sameSubjectQuestions(
              plan,
              initial.answers,
              reverseAnswers,
            );
            if (Object.keys(controls).length) {
              const second = await client.judge(state, controls, options);
              accumulate(second);
              if (second.ok) Object.assign(initial.answers, second.answers);
              else
                for (const id of Object.keys(controls))
                  initial.answers[id] = {
                    type: "unjudged",
                    reason: second.error,
                  };
            }
          }
          const answers: AnswerInput[] = initial.ok
            ? readAsks(plan, initial.answers, reverseAnswers)
            : [];
          return { file, initial, reversed, integrity, answers };
        }),
      );
      const answers: AnswerInput[] = [];
      const unchecked: string[] = [];
      const unjudged: NonNullable<EnvelopeInput["unjudged"]>[number][] = [];
      for (const row of rows) {
        const readings = plan.readings;
        for (const [index, reading] of readings.entries()) {
          const groupId = `${row.file.path}:group:${plan.groups.findIndex((group) => group.includes(reading.id))}`;
          const common = {
            id: `${row.file.path}:${reading.id}`,
            kind: "file_question" as const,
            label: `${row.file.path}  ${reading.label}`,
            groupId,
            evidence: [
              {
                target: row.file.path,
                canonicalPath: known(resolve(cwd, row.file.path)),
                aliases: [],
                side: "current" as const,
                revision: unknown("working tree evidence"),
              },
            ],
            diagnosticIds: [] as string[],
            actionIds: [] as string[],
          };
          const answer = row.answers[index];
          if (
            answer &&
            !answer.unjudged &&
            (answer.source || answer.answer?.source)
          )
            reportItems.push(
              answerItemFromInput(
                common,
                row.integrity.controls.length
                  ? {
                      ...answer,
                      band: "unsure",
                      reason: row.integrity.controls
                        .map((control) => control.fact)
                        .join("; "),
                    }
                  : answer,
              ),
            );
          else {
            const raw = row.initial.ok
              ? row.initial.answers[reading.id]
              : undefined;
            const cause =
              raw?.type === "unjudged" ? raw.cause : row.initial.failureCause;
            const links = diagnose(
              cause ??
                (budget()
                  ? budget()?.kind === "session"
                    ? "session_budget"
                    : "call_budget"
                  : "control_failure"),
              answer?.reason ??
                (row.initial.ok
                  ? "Required group incomplete or response provenance not established"
                  : row.initial.error),
              { kind: "group", groupIds: [groupId] },
              row.file.path,
            );
            reportItems.push({
              ...common,
              ...links,
              treatment: "not_judged",
              source: "none",
            });
          }
          for (const id of [
            reading.twin,
            ...Object.values(reading.controls ?? {}),
          ].filter((id): id is string => !!id)) {
            const control = row.initial.ok
              ? row.initial.answers[id]
              : undefined;
            if (control && control.type !== "unjudged" && control.source)
              auxiliary.controls[control.source]++;
            else auxiliary.controls.notJudged++;
          }
          const reverse = row.reversed?.ok
            ? row.reversed.answers[reading.id]
            : undefined;
          if (row.reversed) {
            if (reverse && reverse.type !== "unjudged" && reverse.source)
              auxiliary.controls[reverse.source]++;
            else auxiliary.controls.notJudged++;
          }
        }
        records.push({
          path: row.file.path,
          initial: row.initial,
          ...(row.reversed ? { reversed: row.reversed } : {}),
        });
        if (!row.initial.ok) {
          unchecked.push(row.file.path);
          unjudged.push({
            label: row.file.path,
            reason: row.initial.error,
            next: "read the supplied file natively; a new Jev call needs materially changed evidence or recovered service",
          });
          continue;
        }
        if (
          Object.values(row.initial.answers).some(
            (answer) => answer.type === "unjudged",
          ) ||
          (row.reversed &&
            (!row.reversed.ok ||
              Object.values(row.reversed.answers).some(
                (answer) => answer.type === "unjudged",
              )))
        )
          unchecked.push(row.file.path);
        for (const answer of row.answers)
          answers.push({
            ...answer,
            label: `${row.file.path}  ${answer.label}`,
            ...(row.integrity.controls.length
              ? {
                  band: "unsure" as const,
                  reason: row.integrity.controls
                    .map((control) => control.fact)
                    .join("; "),
                }
              : {}),
          });
      }
      return finish({
        state: {
          files: collected.files.length,
          integrity: rows.some((row) => row.integrity.controls.length)
            ? "failed"
            : "ok",
          warnings: plan.warnings.map((warning) => warning.fact),
        },
        answers,
        unjudged,
        unchecked,
        budget: budget(),
        lines: skipped.length
          ? [{ type: "list", title: "skipped", items: skipped }]
          : [],
        limitations: [
          ...plan.warnings,
          ...rows.flatMap((row) => [
            ...row.integrity.controls,
            ...row.integrity.notes,
          ]),
        ],
      });
    },
  } satisfies ToolDefinition<typeof askFilesParameters, AskFilesDetails>;
}
