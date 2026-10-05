import { type Static, Type } from "@sinclair/typebox";
import {
  resolveEvidenceContext,
  withEvidenceContext,
} from "../adapters/evidence-context.ts";
import { collectSearchExcerpts } from "../adapters/files.ts";
import { prefilter } from "../adapters/find.ts";
import { shareGitInventory } from "../adapters/git-inventory.ts";
import { hostUsage } from "../adapters/usage.ts";
import * as C from "../constants.ts";
import {
  contentWords,
  findKeywords,
  type RankedFile,
  rankFiles,
  retainFiles,
} from "../core/find.ts";
import type { Band, EnvelopeInput } from "../core/output.ts";
import { needsReverse, pointerQuestion, readPointer } from "../core/pointer.ts";
import {
  type Action,
  answerItemFromInput,
  buildResultReport,
  type Cause,
  contextFromEvidence,
  type Diagnostic,
  type Item,
  known,
  type RawValue,
} from "../core/result-report.ts";
import { secretRefusal } from "../core/secret-path.ts";
import { interpolate } from "../describe.ts";
import type { GuideContext } from "../guide.ts";
import type { Answer, Judgment, Question, State } from "../jev/types.ts";
import { renderResultReport } from "../render.ts";
import type { ToolDependencies } from "../runtime.ts";
import { NOT_CONFIGURED } from "../texts/configuration.ts";
import { FIND_DESCRIPTION } from "../texts/find.ts";
import { createJudgeOptions, finishToolCall } from "./judge-options.ts";

export const findParameters = Type.Object(
  {
    root: Type.Optional(Type.String()),
    goal: Type.String({ minLength: 1 }),
    keywords: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    scope: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())]),
    ),
    exclude: Type.Optional(Type.Array(Type.String())),
    effort: Type.Optional(
      Type.Union([
        Type.Literal("quick"),
        Type.Literal("default"),
        Type.Literal("thorough"),
      ]),
    ),
    max_calls: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type FindArgs = Static<typeof findParameters>;
export function createFindFilesTool(dependencies: ToolDependencies) {
  const { host, runtime, exec: execute } = dependencies;
  return {
    name: "jev_find_files",
    label: "Jev find files",
    description: interpolate(FIND_DESCRIPTION, host.names),
    parameters: findParameters,
    ...(host.isOmp
      ? {
          approval: "read" as const,
          loadMode: "essential" as const,
          defaultInactive: true,
        }
      : {
          promptSnippet:
            "Find the files for a goal described in plain words, ranked, with an entry point",
          promptGuidelines: [
            "jev_find_files: describe the behavior in one sentence of five words or more, not a guessed identifier",
          ],
        }),
    async execute(
      _id: string,
      args: FindArgs,
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
      const totals = {
        calls: 0,
        questions: 0,
        cacheHits: 0,
        cacheRequests: 0,
        usage: { inputTokens: 0, costUsd: 0 },
      };
      const limitations: NonNullable<EnvelopeInput["limitations"]>[number][] =
        [];
      const unchecked: string[] = [];
      const { options, budget } = createJudgeOptions({
        signal,
        maxCalls: args.max_calls,
        session: runtime.session,
      });
      const context = contextFromEvidence(evidenceContext);
      const diagnostics: Diagnostic[] = [];
      const actions: Action[] = [];
      const auxiliary = {
        controls: { fresh: 0, cache: 0, notJudged: 0, static: 0 },
        passages: { fresh: 0, cache: 0, notJudged: 0 },
      };
      let entryPaths: string[] = [];
      let costObserved = true;
      let failureCause: Cause = "invalid_response";
      let primary: Answer | undefined;
      let confirmation: Answer | undefined;
      let confirmationRequired = false;
      const raw = (answer: Answer): RawValue[] =>
        answer.type === "choice"
          ? Object.entries(answer.probabilities).map(
              ([label, probability]) => ({
                label,
                value: label,
                probability: known(probability),
              }),
            )
          : [];
      const diagnostic = (
        cause: Cause,
        fact: string,
        members: string[] = [],
      ) => {
        const id = `d${diagnostics.length + 1}`;
        const actionId = `a${actions.length + 1}`;
        const code =
          cause === "invalid_root"
            ? "correct_context"
            : cause === "not_configured"
              ? "configure_client"
              : cause === "service_unavailable" || cause === "transport_failure"
                ? "recover_service"
                : "inspect_native";
        actions.push({
          id: actionId,
          code,
          target: known(members.join(", ") || "entry"),
          scope: { kind: "call" },
          condition:
            code === "correct_context"
              ? "If the requested root is incorrect"
              : code === "configure_client"
                ? "If Jev judgment is still useful after configuring the client"
                : code === "recover_service"
                  ? "Only after service recovery is observed"
                  : "If the entry decision remains open",
          instruction:
            code === "correct_context"
              ? "Provide the exact registered worktree top-level; no fallback was performed."
              : code === "configure_client"
                ? "Configure the Jev client, or continue with native discovery."
                : code === "recover_service"
                  ? "Continue natively while unavailable; revisit only after a material service change."
                  : "Inspect the candidate paths or collected passages natively; retain uncertainty without repeating unchanged evidence.",
          repeatUnchanged: false,
        });
        diagnostics.push({
          id,
          cause,
          fact,
          target: known(
            members.join(", ") ||
              (cause === "invalid_root"
                ? (args.root ?? cwd)
                : cause === "forbidden_path"
                  ? JSON.stringify({ scope: args.scope, exclude: args.exclude })
                  : "entry"),
          ),
          origin:
            cause === "invalid_root" || cause === "forbidden_path"
              ? "input"
              : cause === "call_budget" || cause === "session_budget"
                ? "budget"
                : cause === "control_failure"
                  ? "control"
                  : cause === "service_unavailable" ||
                      cause === "transport_failure" ||
                      cause === "invalid_response" ||
                      cause === "provider_context_refusal" ||
                      cause === "not_configured"
                    ? "provider"
                    : "collection",
          scope: { kind: "call" },
          effect: "blocking",
          material: true,
          omittedMembers: members,
          memberCount: known(members.length),
          actionIds: [actionId],
        });
      };
      const finish = (input: Omit<EnvelopeInput, "yield">) => {
        const currentBudget = budget();
        const { envelope } = finishToolCall(
          runtime,
          ctx,
          started,
          {
            ...input,
            limitations: [...limitations, ...(input.limitations ?? [])],
            ...(currentBudget
              ? { budget: currentBudget, unchecked: [...new Set(unchecked)] }
              : {}),
          },
          {
            ...totals,
            costUsd: costObserved ? totals.usage.costUsd : undefined,
          },
        );
        if (input.refusal) diagnostic(failureCause, input.refusal);
        if (
          !input.refusal &&
          !diagnostics.length &&
          !budget() &&
          !unchecked.length &&
          !primary?.source
        )
          diagnostic(
            "invalid_response",
            "entry decision was not received with established answer provenance",
          );
        const settledBudget = budget();
        if (settledBudget)
          diagnostic(
            settledBudget.kind === "max_calls"
              ? "call_budget"
              : "session_budget",
            settledBudget.message,
            [...new Set(unchecked)],
          );
        if (unchecked.length && !budget())
          diagnostic(
            failureCause,
            "candidate ranking or entry work was not judged",
            [...new Set(unchecked)],
          );
        const entryLine = input.lines?.find((line) => line.type === "entry");
        if (entryLine?.type === "entry" && primary?.source)
          actions.push({
            id: `a${actions.length + 1}`,
            code: "inspect_native",
            target: known(
              (entryLine.nextRead ?? []).join(", ") || "candidate inventory",
            ),
            scope: { kind: "group", groupIds: ["entry"] },
            condition:
              "If the entry decision remains open after this bounded judgment",
            instruction:
              entryLine.candidate.label === "none"
                ? "Search elsewhere or widen the admitted scope for the goal; inspect any named alternative before collecting genuinely new evidence. Do not retry unchanged evidence."
                : "Read the named candidate passages; add only genuinely discriminating evidence if needed. Do not reword unchanged evidence to retry.",
            repeatUnchanged: false,
          });
        const common = {
          id: "entry",
          kind: "entry" as const,
          label: "entry",
          groupId: "entry",
          evidence: entryPaths.map((path) => ({
            target: path,
            canonicalPath: known(`${cwd}/${path}`),
            aliases: [],
            side: "current" as const,
            revision: context.resolvedBase,
          })),
          diagnosticIds: diagnostics.map((d) => d.id),
          actionIds: actions.map((a) => a.id),
        };
        let item: Item = { ...common, treatment: "not_judged", source: "none" };
        if (
          entryLine?.type === "entry" &&
          primary?.type === "choice" &&
          primary.source &&
          (!confirmationRequired ||
            (confirmation?.type === "choice" && confirmation.source))
        ) {
          auxiliary.passages[primary.source]--;
          item = answerItemFromInput(common, {
            label: "entry",
            answer: primary,
            value: entryLine.candidate.value,
            publicResult: entryLine.candidate.value.head,
            band: entryLine.band,
            reason: limitations.map((limit) => limit.fact).join("; "),
            rawValues: raw(primary),
            reportControls:
              confirmation?.type === "choice" && confirmation.source
                ? [
                    {
                      id: "entry-order",
                      kind: "order",
                      source: confirmation.source,
                      outcome: entryLine.orderDependent
                        ? "order-dependent"
                        : "consistent",
                      rawValues: raw(confirmation),
                    },
                  ]
                : [],
          });
        }
        const report = buildResultReport({
          tool: "jev_find_files",
          context,
          items: [item],
          diagnostics,
          actions,
          metrics: {
            ...totals,
            costUsd: costObserved ? totals.usage.costUsd : undefined,
            elapsedMs: performance.now() - started,
          },
          auxiliary,
          total: known(1),
          refused: Boolean(
            input.refusal &&
              (failureCause === "invalid_root" ||
                failureCause === "forbidden_path"),
          ),
          missingWork: unchecked.length > 0,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: renderResultReport(report, {
                details: {
                  lines: [
                    ...envelope.lines,
                    ...(entryLine?.type === "entry"
                      ? [
                          {
                            type: "list" as const,
                            title: "read",
                            items: [...(entryLine.nextRead ?? [])],
                          },
                          {
                            type: "list" as const,
                            title: "auxiliary ranking",
                            items: (entryLine.relevant ?? []).map(
                              (candidate) =>
                                `${candidate.label} (${candidate.value.p})`,
                            ),
                          },
                        ]
                      : []),
                    {
                      type: "list" as const,
                      title: "discovery reservations",
                      items: [...limitations, ...(input.limitations ?? [])].map(
                        (limit) => limit.fact,
                      ),
                    },
                  ],
                },
              }),
            },
          ],
          details: { ...totals, evidenceContext, result: report },
          ...hostUsage(host.isOmp, totals.usage),
        };
      };
      if (!evidence.ok) {
        failureCause = evidence.cause ?? "invalid_root";
        return finish({ refusal: evidence.error });
      }
      if (!client) {
        failureCause = "not_configured";
        return finish({ refusal: NOT_CONFIGURED });
      }
      const words = contentWords(args.goal);
      const short = words.length < C.FIND_GOAL_MIN_WORDS;
      if (short)
        limitations.push({
          fact: `goal has ${words.length} content words: verdicts are capped at unsure`,
          next: "describe the behavior in one sentence",
        });
      const keywords = findKeywords(args.goal, args.keywords);
      const candidateLimit =
        args.effort === "quick"
          ? C.FIND_QUICK_CANDIDATES
          : args.effort === "thorough"
            ? C.FIND_THOROUGH_CANDIDATES
            : C.FIND_NAME_CANDIDATES;
      const readLimit =
        args.effort === "quick"
          ? C.FIND_QUICK_READ
          : args.effort === "thorough"
            ? C.FIND_THOROUGH_READ
            : C.FIND_FILES_READ;
      const candidates = await prefilter(
        exec,
        cwd,
        keywords,
        candidateLimit,
        args.scope,
        args.exclude,
        signal,
      );
      if (!candidates.ok) {
        failureCause = candidates.cause ?? "git_failure";
        return finish({ refusal: candidates.error });
      }
      for (const path of candidates.secret)
        diagnostic("secret_pattern", secretRefusal(path), [path]);
      context.inventories.push({
        id: "candidates",
        kind: "repository",
        rules: [
          "Git tracked and non-ignored untracked files",
          "keyword prefilter with existing effort limit",
        ],
        restrictions: [
          ...(typeof args.scope === "string"
            ? [args.scope]
            : (args.scope ?? [])),
          ...(args.exclude ?? []).map((path) => `exclude ${path}`),
        ],
        discovered: known(candidates.scopeFiles),
        considered: known(candidates.paths.length),
        scopeRestricted: Boolean(args.scope || args.exclude?.length),
        criteria: [],
      });
      const entry = (
        path: string,
        p: number,
        band: Band,
        alternatives: RankedFile[] = [],
        orderDependent = false,
        orderProbabilities?: readonly [number, number],
        relevant: RankedFile[] = [],
      ): NonNullable<EnvelopeInput["lines"]>[number] => ({
        type: "entry",
        candidate: { label: path, value: { head: path, p } },
        band,
        candidates: alternatives.map((item) => ({
          label: item.path,
          value: { head: item.path, p: item.p },
        })),
        orderDependent,
        orderProbabilities,
        relevant: relevant.map((item) => ({
          label: item.path,
          value: { head: item.path, p: item.p },
        })),
        nextRead:
          path === "none"
            ? []
            : [
                path,
                ...(band === "unsure"
                  ? alternatives
                      .map((item) => item.path)
                      .filter((path) => path !== "none")
                  : []),
              ],
      });
      if (!candidates.paths.length) {
        diagnostic(
          "collection_empty",
          candidates.scopeFiles === 0
            ? "scope matched 0 files; no entry judgment"
            : "no file shares a word with the goal; no entry judgment",
        );
        return finish({});
      }
      const judge = async (
        state: State,
        questions: Record<string, Question>,
      ): Promise<Judgment> => {
        state = withEvidenceContext(state, evidenceContext);
        if (JSON.stringify(state).length > C.STATE_MAX_CHARS)
          return {
            ok: false,
            error: `required evidence exceeds STATE_MAX_CHARS=${C.STATE_MAX_CHARS}`,
          };
        const result = await client.judge(state, questions, {
          signal,
          ...runtime.session.requestGate(),
          ...options,
          admissionCause: () =>
            budget()?.kind === "max_calls" ? "call_budget" : "session_budget",
        });
        for (const key of [
          "calls",
          "questions",
          "cacheHits",
          "cacheRequests",
        ] as const)
          totals[key] += result[key] ?? 0;
        totals.usage.inputTokens += result.usage?.inputTokens ?? 0;
        if (result.calls && !result.usage) costObserved = false;
        if (!result.ok) {
          failureCause = result.failureCause ?? "invalid_response";
          auxiliary.passages.notJudged += Object.keys(questions).length;
        }
        totals.usage.costUsd += result.usage?.costUsd ?? 0;
        if (result.ok)
          for (const id of Object.keys(questions)) {
            const answer = result.answers[id];
            if (answer?.type === "unjudged") {
              failureCause = answer.cause ?? "invalid_response";
              auxiliary.passages.notJudged++;
            } else if (answer?.source) auxiliary.passages[answer.source]++;
            else auxiliary.passages.notJudged++;
          }
        return result;
      };
      const boolQuestions = (
        paths: string[],
        content: boolean,
      ): Record<string, Question> =>
        Object.fromEntries(
          paths.map((path) => [
            path,
            {
              type: "bool",
              instructions: content
                ? `Does the passage from ${path} implement or document behavior that helps with this goal: ${args.goal}?`
                : `Could the file ${path} help with this goal: ${args.goal}?`,
              criteria: {
                true: "The file could help with the goal",
                false: "The file does not help with the goal",
              },
            },
          ]),
        );
      const names: RankedFile[] = [];
      const nameBatches = Array.from(
        { length: Math.ceil(candidates.paths.length / C.FIND_NAME_BATCH) },
        (_, index) =>
          candidates.paths.slice(
            index * C.FIND_NAME_BATCH,
            (index + 1) * C.FIND_NAME_BATCH,
          ),
      );
      const nameResults = await Promise.all(
        nameBatches.map(async (paths) => ({
          paths,
          result: await judge(
            { goal: args.goal, paths },
            boolQuestions(paths, false),
          ),
        })),
      );
      for (const { paths, result } of nameResults) {
        if (!result.ok && !budget()) return finish({ refusal: result.error });
        for (const path of paths) {
          const answer = result.ok ? result.answers[path] : undefined;
          if (answer?.type === "bool") names.push({ path, p: answer.p });
          else unchecked.push(path);
        }
      }
      const rankedNames = rankFiles(names);
      let bestRanking = rankedNames;
      const fallback = () => {
        primary = undefined;
        if (bestRanking.length)
          limitations.push({
            fact: `auxiliary ranking retained: ${bestRanking.map((item) => `${item.path} (${item.p})`).join(" · ")}; entry was not judged`,
            next: "inspect these paths natively",
          });
        const top = bestRanking.slice(0, 2);
        return finish({
          lines: [
            entry(
              top[0]?.path ?? "none",
              top[0]?.p ?? 0,
              "unsure",
              top.slice(1),
            ),
          ],
          answers: bestRanking.map((item) => ({
            label: item.path,
            value: { head: "relevant", p: item.p },
            band: "unsure" as const,
          })),
        });
      };
      if (budget()) {
        unchecked.push(
          ...candidates.paths.filter(
            (path) => !names.some((item) => item.path === path),
          ),
        );
        return fallback();
      }
      const readPaths = rankedNames
        .slice(0, readLimit)
        .map((item) => item.path);
      const files: Record<string, string> = {};
      const content: RankedFile[] = [];
      const contentBatches = Array.from(
        { length: Math.ceil(readPaths.length / C.FIND_READ_PER_CALL) },
        (_, index) =>
          readPaths.slice(
            index * C.FIND_READ_PER_CALL,
            (index + 1) * C.FIND_READ_PER_CALL,
          ),
      );
      const contentResults = await Promise.all(
        contentBatches.map(async (paths) => {
          const read = await collectSearchExcerpts(
            cwd,
            paths,
            keywords,
            signal,
            exec,
          );
          if (!read.ok) {
            failureCause = read.cause ?? "file_unavailable";
            return { paths, result: read };
          }
          Object.assign(files, read.pointers);
          limitations.push(
            ...read.limits.map((limit) => ({
              fact: `${limit.path}: ${limit.reason}`,
              next: "provide a UTF-8 text file",
            })),
          );
          if (read.ignored.length) {
            for (const omission of read.omissions)
              diagnostic(
                omission.cause,
                `${omission.path}: ${omission.reason}`,
                [omission.path],
              );
            limitations.push({
              fact: `${read.ignored.length} binary, empty or unreadable paths ignored: ${read.ignored.join(", ")}`,
              next: "narrow scope to text files",
            });
          }
          const textPaths = paths.filter(
            (path) => read.files[path] !== undefined,
          );
          if (!textPaths.length)
            return { paths: [], result: { ok: true as const, answers: {} } };
          return {
            paths: textPaths,
            result: await judge(
              {
                goal: args.goal,
                files: Object.fromEntries(
                  Object.entries(read.files).sort(([a], [b]) =>
                    a.localeCompare(b),
                  ),
                ),
              },
              boolQuestions(textPaths, true),
            ),
          };
        }),
      );
      for (const { paths, result } of contentResults) {
        if (!result.ok && !budget()) return finish({ refusal: result.error });
        for (const path of paths) {
          const answer = result.ok ? result.answers[path] : undefined;
          if (answer?.type === "bool") content.push({ path, p: answer.p });
          else unchecked.push(path);
        }
      }
      if (content.length) bestRanking = rankFiles(content);
      if (budget()) {
        unchecked.push(
          ...readPaths.filter(
            (path) => !content.some((item) => item.path === path),
          ),
        );
        return fallback();
      }
      const retained = retainFiles(content, rankedNames);
      limitations.push({
        fact: `cascade: ${names.length} names judged → ${content.length} files read → ${retained.length} shown to the pointer`,
        next: "",
      });
      const relevant = rankFiles(content).filter((item) =>
        retained.some((file) => file.path === item.path),
      );
      const output = (
        path: string,
        p: number,
        band: Band,
        alternatives: RankedFile[] = [],
        orderDependent = false,
        orderProbabilities?: readonly [number, number],
      ) =>
        finish({
          lines: [
            entry(
              path,
              p,
              band,
              alternatives,
              orderDependent,
              orderProbabilities,
              relevant,
            ),
          ],
        });
      if (!retained.length) {
        diagnostic(
          "collection_empty",
          "no file retained by content or names guard; no entry decision was judged",
        );
        return finish({});
      }
      entryPaths = retained.map((item) => item.path);
      context.inventories.push({
        id: "entry-passages",
        kind: "repository",
        rules: [
          "name ranking then bounded passage ranking",
          "existing content and names guard",
        ],
        restrictions: entryPaths,
        discovered: known(content.length),
        considered: known(retained.length),
        scopeRestricted: true,
        criteria: [],
      });
      const idByPath = Object.fromEntries(
        retained.map((item, index) => [item.path, `c${index + 1}`]),
      );
      const pathById = Object.fromEntries(
        retained.map((item, index) => [`c${index + 1}`, item.path]),
      );
      const pointer = async (paths: string[]): Promise<Judgment> => {
        return judge(
          {
            goal: args.goal,
            candidates: paths.map((path) => ({
              id: idByPath[path] ?? "",
              path,
              excerpt: files[path] ?? "",
            })),
          },
          {
            entry: pointerQuestion({
              instructions: `Which candidate is the best entry point for this goal: ${args.goal}? Choose none if no passage helps.`,
              noneLabel: "No candidate implements or documents the goal",
              candidates: paths.map((path) => ({
                id: idByPath[path] ?? "",
                label: `${idByPath[path] ?? ""} — ${path}`,
              })),
            }),
          },
        );
      };
      const paths = retained.map((item) => item.path);
      const firstResult = await pointer(paths);
      if (!firstResult.ok && !budget())
        return finish({ refusal: firstResult.error });
      const first = firstResult.ok ? firstResult.answers.entry : undefined;
      primary = first;
      if (first?.type !== "choice") {
        unchecked.push("entry");
        return fallback();
      }
      const ranked = (probabilities: Record<string, number>) =>
        readPointer(probabilities).ranked.map(({ id, p }) => ({ path: id, p }));
      const firstRanks = ranked(first.probabilities);
      const firstTop = firstRanks[0];
      if (!firstTop)
        return finish({ refusal: "Pointer returned no probabilities." });
      let ranks = firstRanks;
      let band: Band =
        firstTop.p >= C.ORDER_REVERSE_BELOW ? "verdict" : "unsure";
      let disagreement = false;
      let orderDependent = false;
      let orderProbabilities: readonly [number, number] | undefined;
      if (
        retained.length > 1 &&
        (args.effort === "thorough" ||
          (args.effort !== "quick" &&
            needsReverse(first.probabilities, retained.length)))
      ) {
        confirmationRequired = true;
        const secondResult = await pointer([...paths].reverse());
        if (!secondResult.ok && !budget()) {
          auxiliary.passages.notJudged--;
          auxiliary.controls.notJudged++;
          return finish({ refusal: secondResult.error });
        }
        const second = secondResult.ok ? secondResult.answers.entry : undefined;
        confirmation = second;
        if (second?.type === "choice" && second.source) {
          auxiliary.passages[second.source]--;
          auxiliary.controls[second.source]++;
        } else {
          auxiliary.passages.notJudged--;
          auxiliary.controls.notJudged++;
          diagnostic(
            second?.type === "unjudged"
              ? (second.cause ?? "control_failure")
              : "control_failure",
            "required reversed-order entry control was not judged",
          );
          return fallback();
        }
        {
          const secondRanks = ranked(second.probabilities);
          const combined = readPointer(
            first.probabilities,
            second.probabilities,
          );
          ranks = combined.ranked.map(({ id, p }) => ({ path: id, p }));
          disagreement = firstTop.path !== secondRanks[0]?.path;
          const chosen = ranks[0]?.path ?? firstTop.path;
          orderProbabilities = [
            first.probabilities[chosen] ?? 0,
            second.probabilities[chosen] ?? 0,
          ];
          orderDependent = combined.orderDependent;
          band =
            !disagreement && (ranks[0]?.p ?? 0) >= C.FIND_CONFIRM_MIN
              ? "verdict"
              : "unsure";
        }
      }
      if (disagreement)
        limitations.push({
          fact: "the two orders disagree",
          next: ranks.slice(0, 2).every((item) => item.path !== "none")
            ? "read both"
            : "read the named file if present; rephrase goal or widen scope",
        });
      else if (band === "unsure")
        limitations.push({
          fact: "entry probability below confirmation threshold",
          next: ranks.slice(0, 2).every((item) => item.path !== "none")
            ? "read both"
            : "read the named file if present; rephrase goal or widen scope",
        });
      const top = ranks[0];
      if (!top)
        return finish({ refusal: "Pointer returned no probabilities." });
      if (top.path === "none")
        limitations.push({
          fact: "pointer chose none",
          next: "rephrase goal or widen scope",
        });
      return output(
        top.path === "none" ? "none" : (pathById[top.path] ?? top.path),
        top.p,
        short || budget() ? "unsure" : band,
        band === "unsure" || short
          ? ranks.slice(1, 2).map((item) => ({
              path:
                item.path === "none"
                  ? "none"
                  : (pathById[item.path] ?? item.path),
              p: item.p,
            }))
          : [],
        orderDependent,
        orderProbabilities,
      );
    },
  };
}
