import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { collectAskFiles } from "../adapters/ask-files.ts";
import { canonicalPath } from "../adapters/canonical-path.ts";
import { shareGitInventory } from "../adapters/git-inventory.ts";
import { hostUsage } from "../adapters/usage.ts";
import { compileAsks, readAsks, reverseQuestions } from "../core/asks.ts";
import { checkIntegrity } from "../core/integrity.ts";
import type {
  AnswerInput,
  BudgetRefusal,
  Envelope,
  EnvelopeInput,
} from "../core/output.ts";
import { buildEnvelope } from "../core/output.ts";
import { interpolate } from "../describe.ts";
import type { GuideContext } from "../guide.ts";
import type { Answer, Judgment, JudgmentMetadata } from "../jev/types.ts";
import { renderEnvelope } from "../render.ts";
import type { ToolDependencies } from "../runtime.ts";
import { ASK_FILES_DESCRIPTION } from "../texts/ask-files.ts";
import { NOT_CONFIGURED } from "../texts/configuration.ts";
import { asksParameter } from "./ask-schema.ts";

export const askFilesParameters = Type.Object(
  {
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
            "jev_ask_files: put every ask in one call; declare intents (verify, classify, rate, decide), never raw questions",
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
      const cwd = await canonicalPath(ctx.cwd);
      const started = performance.now();
      const exec = shareGitInventory(execute);
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
        const usage = hostUsage(host.isOmp, {
          inputTokens: totals.inputTokens,
          costUsd: totals.costUsd,
        });
        return {
          content: [{ type: "text" as const, text: renderEnvelope(envelope) }],
          details: { files: records, skipped, envelope },
          ...usage,
        };
      };
      if (!client) return finish({ refusal: NOT_CONFIGURED });
      const plan = compileAsks(args.asks, { surface: "files" });
      if (!plan.ok) return finish({ refusal: plan.error });
      const collected = await collectAskFiles(cwd, args.paths, signal, exec);
      if (!collected.ok) return finish({ refusal: collected.error });
      skipped = collected.skipped;
      if (!collected.files.length && skipped.length)
        return finish({
          refusal: `No readable evidence: ${skipped.join("; ")}`,
        });
      let sent = 0;
      let budget: BudgetRefusal | undefined;
      const options = {
        signal,
        ...runtime.session.requestGate(),
        beforeRequest: (count: number) => {
          if (args.max_calls !== undefined && sent >= args.max_calls) {
            budget = {
              kind: "max_calls",
              message: `max_calls=${args.max_calls} reached`,
            };
            return { ok: false as const, error: budget.message };
          }
          const admission = runtime.session.admit(count);
          if (!admission.ok) {
            budget = { kind: "session", message: admission.error };
            return admission;
          }
          sent++;
          return admission;
        },
        onUsage: (usage: { inputTokens: number; costUsd: number }) =>
          runtime.session.recordUsage(usage),
      };
      const accumulate = (result: JudgmentMetadata) => {
        totals.calls += result.calls ?? 0;
        totals.questions += result.questions ?? 0;
        totals.cacheHits += result.cacheHits ?? 0;
        totals.cacheRequests += result.cacheRequests ?? 0;
        totals.inputTokens += result.usage?.inputTokens ?? 0;
        totals.costUsd += result.usage?.costUsd ?? 0;
      };
      const rows = await Promise.all(
        collected.files.map(async (file) => {
          const state = { path: file.path, content: file.content };
          const integrity = checkIntegrity(state, plan.asks, [
            {
              ...file.identity,
              insertedPath: resolve(cwd, state.path),
              content: state.content,
              insertedSha256: createHash("sha256")
                .update(state.content)
                .digest("hex"),
            },
          ]);
          const initial = await client.judge(state, plan.questions, {
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
            next: "read the file or retry",
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
        budget,
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
