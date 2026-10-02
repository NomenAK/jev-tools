import { matchesGlob, relative, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { createAnalysisContext } from "../adapters/analysis-context.ts";
import { canonicalPath } from "../adapters/canonical-path.ts";
import { collectUnits } from "../adapters/git.ts";
import { resolveBase } from "../adapters/git-base.ts";
import { shareGitInventory } from "../adapters/git-inventory.ts";
import { attachRunnerVersions } from "../adapters/runner-version.ts";
import { collectTestInventory } from "../adapters/test-inventory.ts";
import { hostUsage } from "../adapters/usage.ts";
import {
  SELECT_MIN,
  STATE_MAX_CHARS,
  WITNESS_AUTO_MIN_CELLS,
} from "../constants.ts";
import type { ImportSource } from "../core/imports.ts";
import {
  createImportGraphBuilder,
  importClosureLazy,
} from "../core/imports.ts";
import type {
  AnswerInput,
  BudgetRefusal,
  EnvelopeInput,
  Limitation,
} from "../core/output.ts";
import { buildEnvelope } from "../core/output.ts";
import { buildRunnerCommands } from "../core/test-commands.ts";
import { prepareCoverageWitnesses } from "../core/test-coverage.ts";
import type { TestEntry } from "../core/test-discovery.ts";
import { discoverTests, isTestConfiguration } from "../core/test-discovery.ts";
import {
  prepareTestEvidence,
  type TestEvidence,
} from "../core/test-evidence.ts";
import { prepareTestStates } from "../core/test-state.ts";
import type { EvidenceUnit } from "../core/units.ts";
import type { GuideContext } from "../guide.ts";
import type { Answer, Judgment, Question, State } from "../jev/types.ts";
import {
  buildCoverageWitnessUnits,
  evaluateBatchWitnessHealth,
} from "../presets/witnesses.ts";
import { renderEnvelope } from "../render.ts";
import type { ToolDependencies } from "../runtime.ts";
import { SELECT_TESTS_DESCRIPTION } from "../texts/select-tests.ts";

export const selectTestsParameters = Type.Object(
  {
    base: Type.Optional(Type.String({ minLength: 1 })),
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    witnesses: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("auto"),
        Type.Literal("on"),
      ]),
    ),
    max_calls: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type SelectTestsArgs = Static<typeof selectTestsParameters>;
interface Candidate {
  entry: TestEntry;
  paths: readonly string[];
  units: readonly EvidenceUnit[];
  state: State;
  touched: boolean;
  uncertain: boolean;
}

function makeCandidate(
  entry: TestEntry,
  files: ReadonlyMap<string, ImportSource>,
  evidence: TestEvidence,
  changed: ReadonlySet<string>,
  outside: boolean,
): Candidate {
  const enriched = evidence.units.map((unit) => ({
    id: unit.id,
    kind: unit.kind,
    file: unit.file,
    name: unit.name,
    exported: unit.exported,
    before: unit.before,
    after: unit.after,
    usedBy: (evidence.usedBy.get(unit.id) ?? []).map(({ path, text }) => ({
      path,
      text,
    })),
  }));
  return {
    entry,
    paths: evidence.paths,
    units: evidence.units,
    state: {
      testFile: { path: entry.path, text: files.get(entry.path)?.text ?? "" },
      changedUnits: enriched,
      imports: evidence.imports.map(({ path, text }) => ({ path, text })),
    },
    touched: changed.has(entry.path),
    uncertain: evidence.uncertain || outside,
  };
}

export function createSelectTestsTool(dependencies: ToolDependencies) {
  const { host, runtime, exec: execute } = dependencies;
  return {
    name: "jev_select_tests",
    label: "Jev select tests",
    description: SELECT_TESTS_DESCRIPTION,
    parameters: selectTestsParameters,
    ...(host.isOmp
      ? { approval: "read" as const, loadMode: "essential" as const }
      : {
          promptSnippet:
            "Pick the tests the diff can affect and the runner command for only those",
        }),
    async execute(
      _id: string,
      args: SelectTestsArgs,
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
        usage: { inputTokens: 0, costUsd: 0 },
      };
      let costKnown = false;
      let sent = 0;
      let budget: BudgetRefusal | undefined;
      const finish = (input: Omit<EnvelopeInput, "yield">) => {
        const limitKeys = new Set<string>();
        const uniqueLimits = input.limitations?.filter((limit) => {
          const key = JSON.stringify([limit.fact, limit.next]);
          if (limitKeys.has(key)) return false;
          limitKeys.add(key);
          return true;
        });
        const envelope = buildEnvelope({
          ...input,
          limitations: uniqueLimits,
          yield: {
            ...totals,
            costUsd: costKnown ? totals.usage.costUsd : undefined,
            elapsedMs: performance.now() - started,
          },
        });
        runtime.session.record(envelope);
        runtime.guide.deliver(ctx);
        const details: Judgment & { limitations?: readonly Limitation[] } = {
          ok: true,
          answers: {},
          ...totals,
          limitations: uniqueLimits,
        };
        return {
          content: [{ type: "text" as const, text: renderEnvelope(envelope) }],
          details,
          ...hostUsage(host.isOmp, costKnown ? totals.usage : undefined),
        };
      };
      const comparison = await resolveBase(exec, cwd, args.base, signal);
      if (!comparison.ok) return finish({ refusal: comparison.error });
      const analysis = await createAnalysisContext();
      const [inventory, diff] = await Promise.all([
        collectTestInventory(exec, cwd, signal),
        collectUnits(
          exec,
          { cwd: cwd, base: comparison.base, signal },
          analysis.parser,
        ),
      ]);
      if (!inventory.ok) return finish({ refusal: inventory.error });
      if (!diff.ok) return finish({ refusal: diff.error });
      const known = new Set(inventory.paths);
      const sourceFiles = new Map<string, ImportSource>();
      const read = async (path: string): Promise<ImportSource | undefined> => {
        const source = await inventory.read(path);
        if (source) sourceFiles.set(path, source);
        return source;
      };
      const configurationPaths = inventory.paths.filter(
        (path) =>
          isTestConfiguration(path) ||
          /(?:^|\/)tsconfig[^/]*\.json$/.test(path),
      );
      for (let offset = 0; offset < configurationPaths.length; offset += 16)
        await Promise.all(
          configurationPaths.slice(offset, offset + 16).map(read),
        );
      const candidatePaths = new Set<string>();
      const configurationSet = new Set(configurationPaths);
      for (;;) {
        candidatePaths.clear();
        const references = new Set<string>();
        discoverTests(
          inventory.paths.map(
            (path) => sourceFiles.get(path) ?? { path, text: "" },
          ),
          candidatePaths,
          analysis,
          references,
        );
        const pending = [...references].filter(
          (path) => known.has(path) && !configurationSet.has(path),
        );
        if (!pending.length) break;
        for (const path of pending) configurationSet.add(path);
        configurationPaths.push(...pending);
        for (let offset = 0; offset < pending.length; offset += 16)
          await Promise.all(pending.slice(offset, offset + 16).map(read));
      }
      const planned = [...candidatePaths];
      for (let offset = 0; offset < planned.length; offset += 16)
        await Promise.all(planned.slice(offset, offset + 16).map(read));
      const discovery = discoverTests(
        [...sourceFiles.values()],
        undefined,
        analysis,
      );
      const versionedEntries = await attachRunnerVersions(
        inventory.cwd,
        discovery.entries,
        inventory.read,
        known,
      );
      const changed = new Set(
        diff.files.flatMap((file) => [file.path, file.oldPath]),
      );
      const build = createImportGraphBuilder(
        [...sourceFiles.values()].filter((file) =>
          configurationPaths.includes(file.path),
        ),
        known,
        analysis,
      );
      const cache = new Map<
        string,
        Promise<import("../core/imports.ts").ImportGraph>
      >();
      const roots = [
        ...new Set([
          ...discovery.entries.map((entry) => entry.path),
          ...diff.units.map((unit) => unit.file),
          ...inventory.paths.filter((path) =>
            /(?:^|\/)conftest\.py$/.test(path),
          ),
        ]),
      ];
      for (const path of roots)
        await importClosureLazy(read, path, { known, build, cache });
      const graphs = await Promise.all(cache.values());
      const graph = {
        edges: new Map(graphs.flatMap((part) => [...part.edges])),
        limits: graphs.flatMap((part) => part.limits),
      };
      const evidenceFor = prepareTestEvidence(
        [...sourceFiles.values()],
        graph,
        diff.units,
        analysis.parser,
      );
      const evidenceLimits: Limitation[] = [];
      const outside = diff.files.some(
        (file) =>
          !graph.edges.has(file.path) ||
          !/\.[cm]?[jt]sx?$|\.py$/.test(file.path),
      );
      const candidates = versionedEntries
        .filter(
          (entry) =>
            !args.paths?.length ||
            args.paths.some(
              (path) =>
                matchesGlob(entry.path, path) ||
                entry.path.startsWith(`${path.replace(/\/$/, "")}/`),
            ),
        )
        .map((entry) => {
          const evidence = evidenceFor(entry);
          evidenceLimits.push(
            ...evidence.limits.map((limit) => ({
              cause: limit.kind,
              path: limit.path,
              dependency: limit.specifier,
              fact: `${limit.kind}: ${limit.path}${limit.specifier ? ` (${limit.specifier})` : ""}`,
              next: "read the unresolved call chain or run this test",
            })),
          );
          return makeCandidate(
            entry,
            sourceFiles,
            outside || evidence.uncertain
              ? { ...evidence, units: diff.units }
              : evidence,
            changed,
            outside,
          );
        });
      const selected: {
        entry: TestEntry;
        scenarioIds: readonly string[] | null;
      }[] = [];
      const answers: AnswerInput[] = [];
      const unjudged: { label: string; reason: string; next: string }[] = [];
      const limitations: Limitation[] = [
        ...evidenceLimits,
        ...discovery.limits.map((limit) => ({
          cause: `runner ${limit.kind}${limit.framework ? ` (${limit.framework})` : ""}`,
          path: limit.path,
          fact:
            limit.kind === "types"
              ? `type tests separate from runtime — ${limit.path}`
              : limit.kind === "local_runner_unproven"
                ? `local runner not proven: ${limit.framework} — ${limit.path}`
                : limit.kind === "interactive_script_skipped"
                  ? `interactive runner script skipped — ${limit.path}`
                  : limit.kind === "unsupported"
                    ? `framework unsupported: ${limit.framework} — ${limit.path}`
                    : limit.kind === "unknown"
                      ? `framework unknown — ${limit.path}`
                      : `runner discovery incomplete — ${limit.path}`,
          next:
            limit.kind === "types"
              ? "run the identified project type-check command"
              : limit.kind === "local_runner_unproven"
                ? "verify the project runner executable"
                : limit.kind === "interactive_script_skipped"
                  ? "use the non-interactive native runner command"
                  : limit.kind === "unsupported" || limit.kind === "unknown"
                    ? "run the listed files with the project runner"
                    : "read the config or collect with the project runner",
        })),
        ...inventory.limits.map((limit) => ({
          cause: limit.kind,
          path: limit.path,
          fact: `${limit.kind}: ${limit.path}`,
          next: "read the missing file or collect with the project runner",
        })),
      ];
      for (const limit of graph.limits)
        limitations.push({
          cause: `import ${limit.kind}`,
          path: limit.path,
          dependency: limit.specifier,
          fact: `${limit.kind === "dynamic" ? "dynamic import unresolved" : `import ${limit.kind}`}: ${limit.path} (${limit.specifier})`,
          next: "read the missing dependency or collect with the project runner",
        });
      for (const limit of diff.limits)
        limitations.push({
          cause: limit.kind,
          path: limit.file,
          fact: `${limit.kind}: ${limit.file}`,
          next: "read the complete changed source",
        });
      const coverage = new Map<string, number>();
      const incompleteUnits = new Set<string>();
      let fallback = false;
      let skipped = 0;
      const judge = async (
        state: State,
        questions: Record<string, Question>,
        witnessIds?: readonly string[],
      ) => {
        if (JSON.stringify(state).length > STATE_MAX_CHARS)
          return {
            ok: false as const,
            error: `required evidence exceeds STATE_MAX_CHARS=${STATE_MAX_CHARS}`,
          };
        if (args.max_calls !== undefined && sent >= args.max_calls) {
          budget = {
            kind: "max_calls",
            message: `max_calls=${args.max_calls} reached`,
          };
          return { ok: false as const, error: budget.message };
        }
        if (!client) return { ok: false as const, error: "Jev unavailable" };
        const result = await client.judge(state, questions, {
          signal,
          witnesses: witnessIds,
          ...runtime.session.requestGate(),
          beforeRequest: (questionCount) => {
            if (args.max_calls !== undefined && sent >= args.max_calls) {
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
        totals.calls += result.calls ?? 0;
        totals.questions += result.questions ?? 0;
        totals.cacheHits += result.cacheHits ?? 0;
        totals.cacheRequests += result.cacheRequests ?? 0;
        if (result.usage) {
          costKnown = true;
          totals.usage.inputTokens += result.usage.inputTokens;
          totals.usage.costUsd += result.usage.costUsd;
        }
        return result;
      };
      const pointerResults = await Promise.all(
        candidates.map(async (candidate) => {
          const { entry } = candidate;
          if (candidate.touched)
            return {
              candidate,
              selected: null as readonly string[] | null,
              touched: true,
            };
          if (!candidate.units.length && !candidate.uncertain && !outside) {
            skipped++;
            return {
              candidate,
              selected: [] as readonly string[],
              touched: false,
            };
          }
          const units = candidate.units;
          if (
            units.some((unit) => unit.before === null && unit.after === null)
          ) {
            for (const unit of units) incompleteUnits.add(unit.id);
            unjudged.push({
              label: entry.path,
              reason: "changed source not UTF-8 text or unavailable",
              next: "run the whole file with the project runner",
            });
            return { candidate, selected: null, touched: false };
          }
          if (!entry.scenarios.length) {
            unjudged.push({
              label: entry.path,
              reason: "scenario names or count unresolved",
              next: "run the whole file with the project runner",
            });
            return { candidate, selected: null, touched: false };
          }
          const prepared = prepareTestStates(candidate.state, entry.scenarios);
          const ids: string[] = prepared.unjudged.map(
            (item) => item.scenario.id,
          );
          for (const item of prepared.unjudged) {
            for (const unit of units) incompleteUnits.add(unit.id);
            unjudged.push({
              label: `${entry.path}: ${item.scenario.name}`,
              reason: item.reason,
              next: "run this test with the project runner",
            });
            limitations.push({
              cause: "required test evidence omitted",
              path: entry.path,
              dependency: item.scenario.name,
              fact: `required test evidence omitted: ${entry.path}: ${item.scenario.name}`,
              next: "read the complete test body and required imports",
            });
          }
          await Promise.all(
            prepared.batches.map(async (batch) => {
              const questions: Record<string, Question> = Object.fromEntries(
                batch.scenarios.map((scenario) => [
                  scenario.id,
                  {
                    type: "choice" as const,
                    instructions: `When the test named ${scenario.name} runs, which changed unit does it execute or read, directly or through the functions it calls?`,
                    criteria: Object.fromEntries([
                      ...units.map((unit) => [
                        unit.id,
                        `${unit.name} (${unit.file})`,
                      ]),
                      ["none", "No changed unit executes or gets read"],
                    ]),
                  },
                ]),
              );
              const result = await judge(batch.state, questions);
              if (!result.ok) {
                fallback ||= !budget;
                for (const unit of units) incompleteUnits.add(unit.id);
                ids.push(...batch.scenarios.map((scenario) => scenario.id));
                unjudged.push({
                  label: entry.path,
                  reason: result.error,
                  next: budget ? "raise max_calls" : "run all discovered tests",
                });
                return;
              }
              for (const scenario of batch.scenarios) {
                const answer = result.answers[scenario.id];
                if (
                  answer?.type !== "choice" ||
                  typeof answer.probabilities.none !== "number" ||
                  !Number.isFinite(answer.probabilities.none)
                ) {
                  ids.push(scenario.id);
                  for (const unit of units) incompleteUnits.add(unit.id);
                  unjudged.push({
                    label: `${entry.path}: ${scenario.name}`,
                    reason:
                      answer?.type === "unjudged"
                        ? answer.reason
                        : "missing valid pointer",
                    next: "run this test",
                  });
                  continue;
                }
                const p = 1 - answer.probabilities.none;
                if (p >= SELECT_MIN) {
                  ids.push(scenario.id);
                  coverage.set(
                    answer.choice,
                    Math.max(coverage.get(answer.choice) ?? 0, p),
                  );
                  answers.push({
                    label: `${entry.path}: ${scenario.name}`,
                    value: {
                      head: `runs ${units.find((unit) => unit.id === answer.choice)?.name ?? answer.choice}`,
                      p,
                    },
                    band: prepared.unjudged.length ? "unsure" : "verdict",
                  });
                }
              }
            }),
          );
          return { candidate, selected: ids, touched: false };
        }),
      );
      for (const result of pointerResults) {
        if (result.selected === null || result.selected.length)
          selected.push({
            entry: result.candidate.entry,
            scenarioIds: result.selected,
          });
        if (result.touched)
          answers.push({
            label: result.candidate.entry.path,
            value: { head: "touched", p: 1 },
            band: "verdict",
          });
      }
      const residual = diff.units.filter(
        (unit) => unit.exported && (coverage.get(unit.id) ?? 0) < SELECT_MIN,
      );
      await Promise.all(
        candidates.map(async (candidate) => {
          const units = residual.filter(
            (unit) =>
              candidate.units.some((reached) => reached.id === unit.id) ||
              candidate.uncertain ||
              outside,
          );
          if (!units.length) return;
          const witnessUnits =
            args.witnesses === "off" ||
            (args.witnesses !== "on" &&
              units.length * candidate.entry.scenarios.length <
                WITNESS_AUTO_MIN_CELLS)
              ? []
              : buildCoverageWitnessUnits(units);
          const preliminary = prepareCoverageWitnesses(
            candidate.state,
            {},
            witnessUnits,
          );
          const prepared = prepareTestStates(
            preliminary.state,
            candidate.entry.scenarios,
          );
          if (prepared.unjudged.length || !candidate.entry.scenarios.length)
            for (const unit of units) incompleteUnits.add(unit.id);
          await Promise.all(
            prepared.batches.map(async (batch) => {
              const questions: Record<string, Question> = Object.fromEntries(
                units.flatMap((unit) =>
                  batch.scenarios.map((scenario) => [
                    `${scenario.id}_${unit.id}`,
                    {
                      type: "bool" as const,
                      instructions: `When test ${scenario.name} runs, does the after version of unit ${unit.id} (${unit.name}) execute or get read, directly or through functions it calls?`,
                    },
                  ]),
                ),
              );
              if (!Object.keys(questions).length) return;
              const witnessQuestions = prepareCoverageWitnesses(
                candidate.state,
                {},
                witnessUnits,
              );
              const realIds = Object.keys(questions);
              const result = await judge(
                batch.state,
                { ...questions, ...witnessQuestions.questions },
                witnessQuestions.witnesses.map((witness) => witness.id),
              );
              const health = evaluateBatchWitnessHealth(
                realIds,
                witnessQuestions.witnesses,
                result,
              );
              limitations.push(...health.failures);
              for (const unit of units) {
                if (!result.ok) {
                  fallback ||= !budget;
                  incompleteUnits.add(unit.id);
                  continue;
                }
                for (const scenario of batch.scenarios) {
                  const id = `${scenario.id}_${unit.id}`;
                  const answer: Answer | undefined = result.answers[id];
                  if (health.unhealthyQuestionIds.has(id)) {
                    incompleteUnits.add(unit.id);
                    continue;
                  }
                  if (answer?.type === "bool") {
                    coverage.set(
                      unit.id,
                      Math.max(coverage.get(unit.id) ?? 0, answer.p),
                    );
                    if (answer.p >= SELECT_MIN) {
                      const existing = selected.find(
                        (item) => item.entry === candidate.entry,
                      );
                      if (!existing)
                        selected.push({
                          entry: candidate.entry,
                          scenarioIds: [scenario.id],
                        });
                      else if (
                        existing.scenarioIds !== null &&
                        !existing.scenarioIds.includes(scenario.id)
                      )
                        existing.scenarioIds = [
                          ...existing.scenarioIds,
                          scenario.id,
                        ];
                      answers.push({
                        label: `${candidate.entry.path}: ${scenario.name}`,
                        value: { head: `runs ${unit.name}`, p: answer.p },
                        band: "verdict",
                      });
                    }
                  } else incompleteUnits.add(unit.id);
                }
              }
            }),
          );
        }),
      );
      const incomplete =
        discovery.limits.some((limit) =>
          limit.kind === "types"
            ? !discovery.entries.some(
                (entry) =>
                  entry.path === limit.path &&
                  entry.invocation?.kind === "typecheck",
              )
            : limit.kind !== "local_runner_unproven" &&
              limit.kind !== "interactive_script_skipped",
        ) ||
        inventory.limits.length > 0 ||
        diff.limits.length > 0 ||
        graph.limits.length > 0 ||
        evidenceLimits.length > 0 ||
        Boolean(args.paths?.length);
      for (const unit of residual)
        if ((coverage.get(unit.id) ?? 0) < SELECT_MIN)
          answers.push({
            label: `changed, run by no discovered test: ${unit.name} (${unit.file})`,
            value: {
              head: "within discovered inventory only",
              p: coverage.get(unit.id) ?? 0,
            },
            band:
              incomplete || incompleteUnits.has(unit.id) ? "unsure" : "verdict",
          });
      if (fallback) {
        selected.length = 0;
        selected.push(
          ...candidates.map((candidate) => ({
            entry: candidate.entry,
            scenarioIds: null,
          })),
        );
        limitations.push({
          fact: "fallback: all",
          next: "run all discovered tests with their project runner",
        });
      }
      const commands = buildRunnerCommands(selected);
      limitations.push(
        ...commands.limits.flatMap((limit) =>
          limit.files.map((path) => ({
            cause: limit.reason,
            path,
            fact: `${limit.reason}: ${path}`,
            next: limit.action,
          })),
        ),
      );
      if (skipped)
        limitations.push({
          fact: `${skipped} tests skipped because their imports cannot reach the diff`,
          next: "an alias or dynamic import would have kept a test in",
        });
      return finish({
        answers,
        unjudged,
        limitations,
        limitationPriorityPaths: [
          ...new Set([
            ...selected.map(({ entry }) => entry.path),
            ...diff.units.map((unit) => unit.file),
          ]),
        ],
        ...(budget ? { budget } : {}),
        lines: commands.commands.map((command) => ({
          type: "command" as const,
          ...command,
          cwd: relative(cwd, resolve(inventory.cwd, command.cwd)) || ".",
        })),
      });
    },
  } satisfies ToolDefinition<typeof selectTestsParameters, Judgment>;
}
