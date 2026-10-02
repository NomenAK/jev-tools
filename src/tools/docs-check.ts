import { createAnalysisContext } from "../adapters/analysis-context.ts";
import {
  collectDocsInventory,
  docsDeclarationSearch,
} from "../adapters/docs.ts";
import { collectUnits } from "../adapters/git.ts";
import { resolveBase } from "../adapters/git-base.ts";
import { shareGitInventory } from "../adapters/git-inventory.ts";
import {
  CHOICE_MAX_OPTIONS,
  DOCS_COLLECT_BUDGET_MS,
  DOCS_DISPLAY_MAX_SECTIONS,
  DOCS_MAX_SECTIONS,
  STATE_MAX_CHARS,
} from "../constants.ts";
import { collectDocsCandidates } from "../core/docs.ts";
import {
  type AnswerInput,
  type BudgetRefusal,
  buildEnvelope,
  type Envelope,
  type Limitation,
} from "../core/output.ts";
import type { Judgment } from "../jev/types.ts";
import {
  type DocsFinding,
  prepareDocsCheck,
  readDocsJudgment,
} from "../presets/docs.ts";
import type { ToolDependencies } from "../runtime.ts";
import { NOT_CONFIGURED } from "../texts/configuration.ts";

export interface DocsCheckInput {
  cwd: string;
  base?: string;
  signal?: AbortSignal;
  budgetMs?: number;
  maxCalls?: number;
}
export interface DocsCheckResult {
  ok: boolean;
  status:
    | "completed"
    | "collect_budget_reached"
    | "budget_exceeded"
    | "refused";
  envelope: Envelope;
  judgments: Judgment[];
  findings: DocsFinding[];
  unjudged?: { count: number; sections: readonly string[]; truncated: boolean };
  collection?: {
    kind: "collection_budget";
    count: number;
    sections: readonly string[];
    truncated: boolean;
  };
}
/** Shared judgment seam: no guide delivery, rendering, or session answer recording. */
export async function runDocsCheck(
  deps: ToolDependencies,
  input: DocsCheckInput,
): Promise<DocsCheckResult> {
  const started = performance.now();
  deps = { ...deps, exec: shareGitInventory(deps.exec) };
  const timeout =
    input.budgetMs === undefined
      ? undefined
      : AbortSignal.timeout(Math.max(0, Math.ceil(input.budgetMs)));
  const signals = [input.signal, timeout].filter(
    (value): value is AbortSignal => value !== undefined,
  );
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const judgments: Judgment[] = [];
  const findings: DocsFinding[] = [];
  const unchecked: string[] = [];
  let unjudged: DocsCheckResult["unjudged"];
  let collection: DocsCheckResult["collection"];
  const limitations: Limitation[] = [
    {
      fact: "Measured D22 limit: 2/45 documentation obligations found across 180 partial got/zod commits.",
      next: "Also review missing documentation: this check evaluates existing sentences, not documentation completeness.",
    },
  ];
  let budget: BudgetRefusal | undefined;
  let sent = 0;
  let emptyBase: string | undefined;
  const finish = (refusal?: string): DocsCheckResult => {
    if (unchecked.length > 5) {
      unjudged = {
        count: unchecked.length,
        sections: unchecked.slice(0, DOCS_MAX_SECTIONS),
        truncated: unchecked.length > DOCS_MAX_SECTIONS,
      };
      limitations.push({
        fact: `${unchecked.length} matching sections unjudged.`,
        next: "Narrow the diff with base=… or rerun on the relevant documentation.",
      });
    }
    const answers: AnswerInput[] = findings.map((finding) => ({
      label: `${finding.section.path}:${finding.section.start}-${finding.section.end} § ${finding.section.heading} — ${finding.sentence ? JSON.stringify(finding.sentence.text) : "sentence not identified"} — ${finding.band === "verdict" ? "now false" : "needs checking"} after ${finding.units.map((unit) => `${unit.name} (${unit.file})`).join(", ")}`,
      value: { head: "now_false", p: finding.probability },
      band: finding.band,
      reason: finding.reason,
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
      ...(collection || unjudged
        ? {
            lines: [
              ...(collection
                ? [
                    {
                      type: "collection" as const,
                      title:
                        "anchored documentation unexplored; directly cited sections were checked",
                      count: collection.count,
                      items: collection.sections.slice(
                        0,
                        DOCS_DISPLAY_MAX_SECTIONS,
                      ),
                      next: "Read these sections; narrow the diff with base=… to target their dependency.",
                    },
                  ]
                : []),
              ...(unjudged
                ? [
                    {
                      type: "collection" as const,
                      title: "matching documentation unjudged",
                      count: unjudged.count,
                      items: unjudged.sections.slice(
                        0,
                        DOCS_DISPLAY_MAX_SECTIONS,
                      ),
                      next: "Read these sections or rerun on the relevant documentation.",
                    },
                  ]
                : []),
            ],
          }
        : {}),
      unchecked: unjudged ? [] : unchecked,
      budget,
      refusal,
      ...(!refusal &&
      !budget &&
      !collection &&
      !unchecked.length &&
      !findings.length &&
      emptyBase === undefined
        ? {
            lines: [
              {
                type: "list" as const,
                title: "docs: no stale sentences reported",
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
    return {
      ok: !refusal,
      status: timeout?.aborted
        ? "budget_exceeded"
        : refusal
          ? "refused"
          : collection
            ? "collect_budget_reached"
            : "completed",
      envelope,
      judgments,
      findings,
      ...(collection ? { collection } : {}),
      ...(unjudged ? { unjudged } : {}),
    };
  };
  const client = deps.client;
  if (!client) return finish(NOT_CONFIGURED);
  const sessionRefusal = deps.runtime.session.refusal();
  if (sessionRefusal) return finish(sessionRefusal);
  try {
    const comparison = await resolveBase(
      deps.exec,
      input.cwd,
      input.base,
      signal,
    );
    if (!comparison.ok) return finish(comparison.error);
    const base = comparison.base;
    const analysis = await createAnalysisContext();
    const [collected, inventory] = await Promise.all([
      collectUnits(
        deps.exec,
        { cwd: input.cwd, base, signal },
        analysis.parser,
      ),
      collectDocsInventory(deps.exec, input.cwd, signal),
    ]);
    if (!collected.ok) return finish(collected.error);
    if (!inventory.ok) return finish(inventory.error);
    for (const limit of collected.limits)
      limitations.push({
        fact: `${limit.file} : ${limit.kind}`,
        next: "Read the complete change before concluding.",
      });
    if (!collected.units.length) {
      emptyBase = base;
      return finish();
    }
    const collectDeadline = performance.now() + DOCS_COLLECT_BUDGET_MS;
    const candidates = await collectDocsCandidates(
      inventory.files,
      collected.units,
      {
        known: inventory.tracked,
        read: inventory.read,
        declarations: docsDeclarationSearch(deps.exec, inventory, signal),
        changedFiles: collected.files,
        lexical: analysis,
        shouldStop: () =>
          performance.now() >= collectDeadline || !!signal?.aborted,
      },
    );
    for (const limit of inventory.limits)
      limitations.push({
        fact: `${limit.path} : ${limit.reason}`,
        next: "Read the omitted file; its documentation or imports are unchecked.",
      });
    for (const limit of candidates.limits) {
      if (limit.kind === "collection_budget") {
        const changedParts = collected.units.map((unit) =>
          unit.file.split("/"),
        );
        const sections = (limit.sections ?? [])
          .map((section) => {
            const parts = (section.split(" § ")[0] ?? "").split("/");
            const proximity = changedParts.reduce((best, changed) => {
              let common = 0;
              while (
                common < parts.length &&
                common < changed.length &&
                parts[common] === changed[common]
              )
                common++;
              return Math.max(best, common);
            }, 0);
            return { section, proximity };
          })
          .sort((a, b) => b.proximity - a.proximity);
        collection = {
          kind: limit.kind,
          count: sections.length,
          sections: sections
            .slice(0, DOCS_MAX_SECTIONS)
            .map((item) => item.section),
          truncated: sections.length > DOCS_MAX_SECTIONS,
        };
      } else
        limitations.push({
          fact: `${limit.path} : ${limit.reason}`,
          next: "Read the unresolved dependency; closure follows static imports only.",
        });
    }
    for (const omitted of candidates.omitted)
      unchecked.push(
        `${omitted.path} § ${omitted.heading} (DOCS_MAX_SECTIONS)`,
      );
    await Promise.all(
      candidates.candidates.map(async (candidate) => {
        const label = `${candidate.path} § ${candidate.heading}`;
        if (
          candidate.units.some(
            (unit) => unit.before === null && unit.after === null,
          )
        ) {
          unchecked.push(`${label} (changed source unavailable)`);
          return;
        }
        if (budget?.kind === "session") {
          unchecked.push(`${label} (${budget.message})`);
          return;
        }
        const prepared = prepareDocsCheck(candidate);
        if (
          JSON.stringify(prepared.state).length > STATE_MAX_CHARS ||
          candidate.sentences.length + 1 > CHOICE_MAX_OPTIONS
        ) {
          unchecked.push(`${label} (state or pointer too large)`);
          return;
        }
        if (signal?.aborted) {
          unchecked.push(`${label} (budget exceeded or canceled)`);
          return;
        }
        const judgment = await client.judge(
          prepared.state,
          prepared.questions,
          {
            signal,
            ...deps.runtime.session.requestGate(),
            beforeRequest(questionCount) {
              if (budget?.kind === "session")
                return { ok: false, error: budget.message };
              if (signal?.aborted)
                return {
                  ok: false,
                  error: "Budget exceeded or call canceled.",
                };
              if (input.maxCalls !== undefined && sent >= input.maxCalls) {
                budget = {
                  kind: "max_calls",
                  message: `max_calls=${input.maxCalls} reached`,
                };
                return { ok: false, error: budget.message };
              }
              const admitted = deps.runtime.session.admit(questionCount);
              if (!admitted.ok)
                budget = { kind: "session", message: admitted.error };
              else sent++;
              return admitted;
            },
            onUsage: (usage) => deps.runtime.session.recordUsage(usage),
          },
        );
        judgments.push(judgment);
        if (!judgment.ok) {
          unchecked.push(`${label} (${judgment.error})`);
          return;
        }
        if (
          !judgment.answers.status ||
          !judgment.answers.sentence ||
          Object.values(judgment.answers).some(
            (answer) => answer.type === "unjudged",
          )
        ) {
          unchecked.push(`${label} (unjudged question)`);
          const finding = readDocsJudgment(candidate, judgment.answers);
          if (finding)
            findings.push({
              ...finding,
              band: "unsure",
              reason: "unjudged question: read the section",
            });
          return;
        }
        const finding = readDocsJudgment(candidate, judgment.answers);
        if (finding) {
          const incomplete = candidate.units.some((unit) =>
            collected.limits.some((limit) => limit.file === unit.file),
          );
          findings.push(
            incomplete
              ? {
                  ...finding,
                  band: "unsure",
                  reason: "incomplete change evidence: read the omitted pieces",
                }
              : finding,
          );
        }
      }),
    );
    findings.sort(
      (a, b) =>
        a.section.path.localeCompare(b.section.path) ||
        a.section.start - b.section.start,
    );
    unchecked.sort();
    return finish();
  } catch (error) {
    if (signal?.aborted)
      return finish(
        timeout?.aborted ? "Docs budget exceeded." : "Docs check canceled.",
      );
    throw error;
  }
}
