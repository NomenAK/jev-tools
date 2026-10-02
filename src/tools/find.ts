import { type Static, Type } from "@sinclair/typebox";
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
import {
  type Band,
  type BudgetRefusal,
  buildEnvelope,
  type EnvelopeInput,
} from "../core/output.ts";
import { needsReverse, pointerQuestion, readPointer } from "../core/pointer.ts";
import { interpolate } from "../describe.ts";
import type { GuideContext } from "../guide.ts";
import type { Judgment, Question, State } from "../jev/types.ts";
import { renderEnvelope } from "../render.ts";
import type { ToolDependencies } from "../runtime.ts";
import { NOT_CONFIGURED } from "../texts/configuration.ts";
import { FIND_DESCRIPTION } from "../texts/find.ts";

export const findParameters = Type.Object(
  {
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
      let budget: BudgetRefusal | undefined;
      let sent = 0;
      const finish = (input: Omit<EnvelopeInput, "yield">) => {
        const envelope = buildEnvelope({
          ...input,
          limitations: [...limitations, ...(input.limitations ?? [])],
          ...(budget ? { budget, unchecked: [...new Set(unchecked)] } : {}),
          yield: {
            ...totals,
            costUsd: totals.usage.costUsd,
            elapsedMs: performance.now() - started,
          },
        });
        runtime.session.record(envelope);
        runtime.guide.deliver(ctx);
        return {
          content: [{ type: "text" as const, text: renderEnvelope(envelope) }],
          details: totals,
          ...hostUsage(host.isOmp, totals.usage),
        };
      };
      if (!client) return finish({ refusal: NOT_CONFIGURED });
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
        ctx.cwd,
        keywords,
        candidateLimit,
        args.scope,
        args.exclude,
        signal,
      );
      if (!candidates.ok) return finish({ refusal: candidates.error });
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
        limitations.push({
          fact:
            candidates.scopeFiles === 0
              ? "scope matched 0 files"
              : "no file shares a word with the goal",
          next: "rephrase goal or widen scope",
        });
        return finish({
          lines: [entry("none", 1, short ? "unsure" : "verdict")],
        });
      }
      const judge = async (
        state: State,
        questions: Record<string, Question>,
      ): Promise<Judgment> => {
        const result = await client.judge(state, questions, {
          signal,
          beforeRequest: (count) => {
            if (args.max_calls !== undefined && sent >= args.max_calls) {
              budget = {
                kind: "max_calls",
                message: `max_calls=${args.max_calls} reached`,
              };
              return { ok: false, error: budget.message };
            }
            const admission = runtime.session.admit(count);
            if (!admission.ok) {
              budget = { kind: "session", message: admission.error };
              return admission;
            }
            sent++;
            return admission;
          },
          onUsage: (usage) => runtime.session.recordUsage(usage),
        });
        for (const key of [
          "calls",
          "questions",
          "cacheHits",
          "cacheRequests",
        ] as const)
          totals[key] += result[key] ?? 0;
        totals.usage.inputTokens += result.usage?.inputTokens ?? 0;
        totals.usage.costUsd += result.usage?.costUsd ?? 0;
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
        if (!result.ok && !budget) return finish({ refusal: result.error });
        for (const path of paths) {
          const answer = result.ok ? result.answers[path] : undefined;
          if (answer?.type === "bool") names.push({ path, p: answer.p });
          else unchecked.push(path);
        }
      }
      const rankedNames = rankFiles(names);
      let bestRanking = rankedNames;
      const fallback = () => {
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
      if (budget) {
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
            ctx.cwd,
            paths,
            keywords,
            signal,
            exec,
          );
          if (!read.ok) return { paths, result: read };
          Object.assign(files, read.pointers);
          limitations.push(
            ...read.limits.map((limit) => ({
              fact: `${limit.path}: ${limit.reason}`,
              next: "provide a UTF-8 text file",
            })),
          );
          if (read.ignored.length)
            limitations.push({
              fact: `${read.ignored.length} binary, empty or unreadable paths ignored: ${read.ignored.join(", ")}`,
              next: "narrow scope to text files",
            });
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
        if (!result.ok && !budget) return finish({ refusal: result.error });
        for (const path of paths) {
          const answer = result.ok ? result.answers[path] : undefined;
          if (answer?.type === "bool") content.push({ path, p: answer.p });
          else unchecked.push(path);
        }
      }
      if (content.length) bestRanking = rankFiles(content);
      if (budget) {
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
        limitations.push({
          fact: "no file retained by content or names guard",
          next: "rephrase goal or widen scope",
        });
        return output("none", 1, short ? "unsure" : "verdict");
      }
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
                label: `Candidate ${idByPath[path]}`,
              })),
            }),
          },
        );
      };
      const paths = retained.map((item) => item.path);
      const firstResult = await pointer(paths);
      if (!firstResult.ok && !budget)
        return finish({ refusal: firstResult.error });
      const first = firstResult.ok ? firstResult.answers.entry : undefined;
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
        const secondResult = await pointer([...paths].reverse());
        if (!secondResult.ok && !budget)
          return finish({ refusal: secondResult.error });
        const second = secondResult.ok ? secondResult.answers.entry : undefined;
        if (second?.type !== "choice") {
          unchecked.push("entry confirmation");
          band = "unsure";
        } else {
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
        short || budget ? "unsure" : band,
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
