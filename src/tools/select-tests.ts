import { isAbsolute, matchesGlob, relative, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { createAnalysisContext } from "../adapters/analysis-context.ts";
import {
  type EvidenceContext,
  resolveEvidenceContext,
  withEvidenceContext,
} from "../adapters/evidence-context.ts";
import { collectUnits } from "../adapters/git.ts";
import { resolveBase } from "../adapters/git-base.ts";
import { shareGitInventory } from "../adapters/git-inventory.ts";
import { attachRunnerVersions } from "../adapters/runner-version.ts";
import { collectTestInventory } from "../adapters/test-inventory.ts";
import { hostUsage } from "../adapters/usage.ts";
import {
  CHOICE_MAX_OPTIONS,
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
import {
  type Cause,
  type ResultReportV1,
  known as reportKnown,
} from "../core/result-report.ts";
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
import { renderResultReport } from "../render.ts";
import type { ToolDependencies } from "../runtime.ts";
import { SELECT_TESTS_DESCRIPTION } from "../texts/select-tests.ts";
import { createJudgeOptions, finishToolCall } from "./judge-options.ts";
import { controlsFor, ReviewReport, reportMetrics } from "./review-report.ts";

export const selectTestsParameters = Type.Object(
  {
    root: Type.Optional(Type.String()),
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
      const selectionEvidence = {
        criteria: [] as { criterion: string; matches: string[] }[],
        wideningTriggers: [] as string[],
        inventory: [] as string[],
      };
      const report = new ReviewReport();
      let costKnown = false;
      let unknownCost = false;
      const {
        options: judgeOptions,
        budget: gateBudget,
        spent,
      } = createJudgeOptions({
        signal,
        maxCalls: args.max_calls,
        session: runtime.session,
      });
      // The state pre-check below refuses a request the gate would refuse
      // anyway; recording it here keeps the reported budget identical.
      let preflight: BudgetRefusal | undefined;
      const budget = (): BudgetRefusal | undefined => preflight ?? gateBudget();
      const finish = (input: Omit<EnvelopeInput, "yield">, cause?: Cause) => {
        const limitKeys = new Set<string>();
        const uniqueLimits = input.limitations?.filter((limit) => {
          const key = JSON.stringify([limit.fact, limit.next]);
          if (limitKeys.has(key)) return false;
          limitKeys.add(key);
          return true;
        });
        const { envelope } = finishToolCall(
          runtime,
          ctx,
          started,
          { ...input, limitations: uniqueLimits },
          {
            ...totals,
            costUsd:
              costKnown && !unknownCost ? totals.usage.costUsd : undefined,
            elapsedMs: performance.now() - started,
          },
        );
        if (input.refusal) {
          report.refusal = true;
          report.diagnose(cause ?? "internal_error", input.refusal);
        }
        if (!report.items.size && !input.refusal)
          report.diagnose(
            "collection_empty",
            "No test decision candidates in the discovered inventory; this is not proof of no affected tests.",
            undefined,
            [],
            false,
          );
        const result = report.build(
          "jev_select_tests",
          evidenceContext,
          reportMetrics(envelope),
        );
        const details: Judgment & {
          result: ResultReportV1;
          limitations?: readonly Limitation[];
          evidenceContext: EvidenceContext;
          selectionEvidence: typeof selectionEvidence;
        } = {
          ok: true,
          answers: {},
          ...totals,
          evidenceContext,
          selectionEvidence,
          result,
          limitations: uniqueLimits,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: renderResultReport(result, { details: envelope }),
            },
          ],
          details,
          ...hostUsage(host.isOmp, costKnown ? totals.usage : undefined),
        };
      };
      if (!evidence.ok)
        return finish(
          { refusal: evidence.error },
          evidence.cause ?? "invalid_root",
        );
      evidenceContext.requestedBase = args.base ?? "HEAD";
      for (const path of args.paths ?? [])
        if (
          isAbsolute(path) ||
          path.split(/[\\/]/).includes("..") ||
          path.split(/[\\/]/).includes(".git")
        )
          return finish(
            { refusal: `Path not permitted: ${path}` },
            "forbidden_path",
          );
      const comparison = await resolveBase(exec, cwd, args.base, signal);
      if (!comparison.ok)
        return finish(
          { refusal: comparison.error },
          comparison.cause ?? "invalid_base",
        );
      evidenceContext.resolvedBase = comparison.base;
      const analysis = await createAnalysisContext();
      const [inventory, diff] = await Promise.all([
        collectTestInventory(exec, cwd, signal),
        collectUnits(
          exec,
          { cwd: cwd, base: comparison.base, signal },
          analysis.parser,
        ),
      ]);
      if (!inventory.ok)
        return finish(
          { refusal: inventory.error },
          inventory.cause ?? "file_unavailable",
        );
      if (!diff.ok)
        return finish({ refusal: diff.error }, diff.cause ?? "git_failure");
      if (evidenceContext.effectiveRoot)
        evidenceContext.effectiveRoot.path = inventory.cwd;
      selectionEvidence.inventory = [...inventory.paths];
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
      selectionEvidence.wideningTriggers = diff.files
        .filter(
          (file) =>
            !graph.edges.has(file.path) ||
            !/\.[cm]?[jt]sx?$|\.py$/.test(file.path),
        )
        .map((file) => file.path);
      selectionEvidence.criteria = (args.paths ?? []).map((criterion) => ({
        criterion,
        matches: versionedEntries
          .filter(
            (entry) =>
              matchesGlob(entry.path, criterion) ||
              entry.path.startsWith(`${criterion.replace(/\/$/, "")}/`),
          )
          .map((entry) => entry.path),
      }));
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
      report.inventories.push({
        id: "test-candidates",
        kind: "tests",
        rules: [
          "Tracked supported test declarations and literal project runner configuration",
          "Import closure selection; conservative fallback preserves unjudged decisions",
        ],
        restrictions: args.paths ?? [],
        discovered: reportKnown(versionedEntries.length),
        considered: reportKnown(candidates.length),
        scopeRestricted: Boolean(args.paths?.length),
        criteria: selectionEvidence.criteria.map((criterion) => ({
          criterion: criterion.criterion,
          matches: reportKnown(criterion.matches.length),
          outcome: criterion.matches.length ? "matched" : "no_match",
          diagnosticIds: [],
        })),
      });
      for (const candidate of candidates) {
        const scenarios = candidate.entry.scenarios;
        if (!scenarios.length)
          report.expect(
            `test:${candidate.entry.path}:unknown`,
            candidate.entry.path,
            "scenario",
          );
        for (const scenario of scenarios)
          report.expect(
            `test:${candidate.entry.path}:${scenario.id}`,
            `${candidate.entry.path}: ${scenario.name}`,
            "scenario",
            `test:${candidate.entry.path}`,
          );
      }
      for (const criterion of selectionEvidence.criteria)
        if (!criterion.matches.length) {
          report.diagnose(
            "criteria_no_match",
            `No discovered tests match criterion ${criterion.criterion}`,
            criterion.criterion,
          );
          const excluded = inventory.limits.filter(
            (limit) =>
              matchesGlob(limit.path, criterion.criterion) ||
              limit.path.startsWith(
                `${criterion.criterion.replace(/\/$/, "")}/`,
              ),
          );
          if (excluded.length) {
            report.diagnose(
              "outside_inventory",
              "Requested criterion names entries excluded from the admitted inventory",
              criterion.criterion,
              [],
              false,
              excluded.map((limit) => limit.path),
            );
            const entry = report.inventories[0]?.criteria.find(
              (entry) => entry.criterion === criterion.criterion,
            );
            if (entry) entry.outcome = "outside_inventory";
          }
        }
      if (selectionEvidence.wideningTriggers.length)
        report.diagnose(
          "conservative_widening",
          `Changed files outside supported dependency graph: ${selectionEvidence.wideningTriggers.join(", ")}`,
          undefined,
          [],
          false,
        );
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
        state = withEvidenceContext(state, evidenceContext);
        if (JSON.stringify(state).length > STATE_MAX_CHARS)
          return {
            ok: false as const,
            cause: "evidence_too_large" as const,
            error: `required evidence exceeds STATE_MAX_CHARS=${STATE_MAX_CHARS}`,
          };
        if (args.max_calls !== undefined && spent() >= args.max_calls) {
          preflight = {
            kind: "max_calls",
            message: `max_calls=${args.max_calls} reached`,
          };
          return { ok: false as const, error: preflight.message };
        }
        if (!client) return { ok: false as const, error: "Jev unavailable" };
        const result = await client.judge(state, questions, {
          ...judgeOptions,
          witnesses: witnessIds,
          ...runtime.session.requestGate(),
          admissionCause: () =>
            budget()?.kind === "session" ? "session_budget" : "call_budget",
        });
        totals.calls += result.calls ?? 0;
        totals.questions += result.questions ?? 0;
        totals.cacheHits += result.cacheHits ?? 0;
        totals.cacheRequests += result.cacheRequests ?? 0;
        unknownCost ||= result.usage === undefined;
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
          const reportIds = [...report.items.values()]
            .filter(
              (item) =>
                item.groupId === `test:${entry.path}` ||
                item.id === `test:${entry.path}:unknown`,
            )
            .map((item) => item.id);
          if (candidate.touched)
            for (const id of reportIds) report.static(id, "touched", true);
          if (
            !candidate.units.length &&
            !candidate.uncertain &&
            !outside &&
            !candidate.touched
          )
            for (const id of reportIds)
              report.static(
                id,
                "static import closure cannot reach changed units",
                false,
              );
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
            report.diagnose(
              "binary_or_non_utf8",
              "Changed source unavailable",
              entry.path,
              reportIds,
            );
            for (const unit of units) incompleteUnits.add(unit.id);
            unjudged.push({
              label: entry.path,
              reason: "changed source not UTF-8 text or unavailable",
              next: "run the whole file with the project runner",
            });
            return { candidate, selected: null, touched: false };
          }
          if (!entry.scenarios.length) {
            report.totalUnknown = true;
            report.diagnose(
              "unsupported_syntax",
              "Scenario names or count unresolved",
              entry.path,
              reportIds,
            );
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
            report.diagnose("evidence_too_large", item.reason, entry.path, [
              `test:${entry.path}:${item.scenario.id}`,
            ]);
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
              // One option per changed unit plus none: past the cap the
              // pointer is skipped and every scenario stays selected, which
              // is the conservative outcome for unjudged tests.
              if (units.length + 1 > CHOICE_MAX_OPTIONS) {
                for (const unit of units) incompleteUnits.add(unit.id);
                ids.push(...batch.scenarios.map((scenario) => scenario.id));
                for (const scenario of batch.scenarios)
                  unjudged.push({
                    label: `${entry.path}: ${scenario.name}`,
                    reason: `unit pointer exceeds the choice option cap including none (${units.length} changed units); not judged`,
                    next: "run this test with the project runner",
                  });
                limitations.push({
                  cause: "unit pointer exceeds the choice option cap",
                  path: entry.path,
                  fact: `unit pointer exceeds the choice option cap: ${entry.path} (${units.length} changed units)`,
                  next: "run the affected tests with the project runner",
                });
                return;
              }
              const questions: Record<string, Question> = Object.fromEntries(
                batch.scenarios.map((scenario) => [
                  scenario.id,
                  {
                    type: "choice" as const,
                    instructions: `Which changed unit appears in the code the test named ${scenario.name} runs, as shown in the state: the test body and the shown functions it reaches?`,
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
              const batchIds = batch.scenarios.map(
                (scenario) => `test:${entry.path}:${scenario.id}`,
              );
              if (!result.ok)
                report.failure(
                  result,
                  batchIds,
                  budget()?.kind === "session"
                    ? "session_budget"
                    : budget()
                      ? "call_budget"
                      : !client
                        ? "not_configured"
                        : undefined,
                );
              else
                for (const scenario of batch.scenarios) {
                  const answer = result.answers[scenario.id];
                  const id = `test:${entry.path}:${scenario.id}`;
                  report.answer(id, answer, {
                    band: prepared.unjudged.length ? "unsure" : "verdict",
                  });
                  const item = report.items.get(id);
                  if (!item)
                    throw new Error(`Unregistered selection result ${id}`);
                  item.selection = {
                    selected:
                      answer?.type !== "choice" ||
                      1 - (answer.probabilities.none ?? 0) >= SELECT_MIN,
                    reason:
                      answer?.type === "choice"
                        ? "changed-unit pointer selection threshold"
                        : "conservative_fallback",
                  };
                }
              if (!result.ok) {
                fallback ||= !budget();
                for (const unit of units) incompleteUnits.add(unit.id);
                ids.push(...batch.scenarios.map((scenario) => scenario.id));
                unjudged.push({
                  label: entry.path,
                  reason: result.error,
                  next: budget()
                    ? "raise max_calls"
                    : "run all discovered tests",
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
          for (const unit of units)
            for (const scenario of candidate.entry.scenarios)
              report.expect(
                `coverage:${candidate.entry.path}:${scenario.id}:${unit.id}`,
                `${candidate.entry.path}: ${scenario.name} executes ${unit.name}`,
                "scenario",
                `coverage:${candidate.entry.path}:${scenario.id}`,
              );
          for (const omitted of prepared.unjudged)
            for (const unit of units)
              report.diagnose(
                "evidence_too_large",
                omitted.reason,
                candidate.entry.path,
                [
                  `coverage:${candidate.entry.path}:${omitted.scenario.id}:${unit.id}`,
                ],
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
              for (const failure of health.failures)
                report.diagnose(
                  "control_failure",
                  failure.fact,
                  candidate.entry.path,
                  units.flatMap((unit) =>
                    batch.scenarios
                      .filter((scenario) =>
                        health.unhealthyQuestionIds.has(
                          `${scenario.id}_${unit.id}`,
                        ),
                      )
                      .map(
                        (scenario) =>
                          `coverage:${candidate.entry.path}:${scenario.id}:${unit.id}`,
                      ),
                  ),
                  false,
                );
              report.countControls(
                result,
                witnessQuestions.witnesses.map((witness) => witness.id),
              );
              for (const unit of units)
                for (const scenario of batch.scenarios) {
                  const id = `coverage:${candidate.entry.path}:${scenario.id}:${unit.id}`;
                  report.expect(
                    id,
                    `${candidate.entry.path}: ${scenario.name} executes ${unit.name}`,
                    "scenario",
                    `coverage:${candidate.entry.path}:${scenario.id}`,
                  );
                  if (!result.ok)
                    report.failure(
                      result,
                      [id],
                      budget()?.kind === "session"
                        ? "session_budget"
                        : budget()
                          ? "call_budget"
                          : !client
                            ? "not_configured"
                            : undefined,
                    );
                  else
                    report.answer(
                      id,
                      result.answers[`${scenario.id}_${unit.id}`],
                      {
                        band: health.unhealthyQuestionIds.has(
                          `${scenario.id}_${unit.id}`,
                        )
                          ? "unsure"
                          : "verdict",
                        reason: health.unhealthyQuestionIds.get(
                          `${scenario.id}_${unit.id}`,
                        ),
                      },
                      controlsFor(
                        `${scenario.id}_${unit.id}`,
                        result,
                        witnessQuestions.witnesses.map((witness) => witness.id),
                      ),
                      false,
                    );
                }
              for (const unit of units) {
                if (!result.ok) {
                  fallback ||= !budget();
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
        if ((coverage.get(unit.id) ?? 0) < SELECT_MIN) {
          const supportingIds = [...report.items.keys()].filter(
            (id) => id.startsWith("coverage:") && id.endsWith(`:${unit.id}`),
          );
          report.diagnose(
            incomplete || incompleteUnits.has(unit.id)
              ? "collection_omitted"
              : "conservative_widening",
            `Derived from retained coverage decisions: no discovered test established execution of ${unit.name} (${unit.file}) within the considered inventory only.${incomplete || incompleteUnits.has(unit.id) ? " Absence remains unsure because evidence, scope, or controls are incomplete." : " This is not a global coverage claim."}`,
            unit.file,
            supportingIds,
            false,
          );
          if (!supportingIds.length) {
            const diagnostic = report.diagnostics.at(-1);
            if (diagnostic)
              diagnostic.scope = {
                kind: "inventory",
                inventoryIds: ["test-candidates"],
              };
            const action = report.actions.at(-1);
            if (action)
              action.scope = {
                kind: "inventory",
                inventoryIds: ["test-candidates"],
              };
          }
        }
      if (fallback) {
        selected.length = 0;
        selected.push(
          ...candidates.map((candidate) => ({
            entry: candidate.entry,
            scenarioIds: null,
          })),
        );
        report.diagnose(
          "conservative_widening",
          "Unavailable judgment conservatively selects all considered test candidates; static reachability exclusions do not narrow this fallback.",
          undefined,
          [],
          false,
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
      for (const limit of commands.limits)
        for (const path of limit.files)
          report.diagnose("unresolved_runner", limit.reason, path, [], false);
      for (const limit of discovery.limits)
        report.diagnose(
          "unresolved_runner",
          limit.kind,
          limit.path,
          [],
          limit.kind !== "local_runner_unproven" &&
            limit.kind !== "interactive_script_skipped",
        );
      for (const limit of inventory.limits)
        report.diagnose(
          limit.kind === "secret_pattern"
            ? "secret_pattern"
            : "collection_omitted",
          limit.kind,
          limit.path,
        );
      for (const limit of diff.limits)
        report.diagnose(
          limit.kind === "secret_pattern"
            ? "secret_pattern"
            : "collection_omitted",
          limit.kind,
          limit.file,
        );
      for (const limit of graph.limits)
        report.diagnose(
          "dynamic_dependency",
          `${limit.kind}${limit.specifier ? ` (${limit.specifier})` : ""}`,
          limit.path,
          [],
          false,
        );
      for (const item of report.items.values()) {
        const candidate = candidates.find(
          (candidate) =>
            item.id.startsWith(`test:${candidate.entry.path}:`) ||
            item.id.startsWith(`coverage:${candidate.entry.path}:`),
        );
        if (!candidate) continue;
        const plan = selected.find((plan) => plan.entry === candidate.entry);
        const scenario = candidate.entry.scenarios.find(
          (scenario) =>
            item.id === `test:${candidate.entry.path}:${scenario.id}` ||
            item.id.startsWith(
              `coverage:${candidate.entry.path}:${scenario.id}:`,
            ),
        );
        const isSelected = Boolean(
          plan &&
            (plan.scenarioIds === null ||
              (scenario && plan.scenarioIds.includes(scenario.id))),
        );
        item.selection = {
          selected: isSelected,
          reason: fallback
            ? "conservative_fallback"
            : item.treatment === "static"
              ? item.staticReason
              : item.treatment === "not_judged"
                ? "conservative_fallback"
                : "unchanged selection policy and whole-file widening",
        };
      }
      for (const criterion of report.inventories[0]?.criteria ?? [])
        criterion.diagnosticIds = report.diagnostics
          .filter(
            (diagnostic) =>
              diagnostic.cause === "criteria_no_match" &&
              diagnostic.target.status === "known" &&
              diagnostic.target.value === criterion.criterion,
          )
          .map((diagnostic) => diagnostic.id);
      report.actions.push({
        id: "execute-selection-plan",
        code: "execute_plan",
        target: reportKnown(inventory.cwd),
        scope: { kind: "call" },
        condition:
          "When verification is authorized and the listed runner/configuration is available.",
        instruction:
          "Execute the retained runner commands separately; this tool has not executed any test.",
        repeatUnchanged: false,
      });
      if (skipped)
        limitations.push({
          fact: `${skipped} tests skipped because their imports cannot reach the diff`,
          next: "an alias or dynamic import would have kept a test in",
        });
      for (const criterion of selectionEvidence.criteria)
        if (!criterion.matches.length)
          limitations.push({
            path: criterion.criterion,
            cause: "selection criterion has no discovered test match",
            fact: `selection criterion without match: ${criterion.criterion}`,
            next: "Change the criterion or supply the missing test/configuration evidence; an empty scope does not prove absence of impact.",
          });
      if (selectionEvidence.wideningTriggers.length)
        limitations.push({
          fact: `selection widened conservatively: ${selectionEvidence.wideningTriggers.join(", ")}`,
          next: "Run the widened static plans; dependency reachability is not established for these changed files.",
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
        ...(budget() ? { budget: budget() } : {}),
        lines: commands.commands.map((command) => ({
          type: "command" as const,
          ...command,
          cwd: relative(cwd, resolve(inventory.cwd, command.cwd)) || ".",
        })),
      });
    },
  } satisfies ToolDefinition<typeof selectTestsParameters, Judgment>;
}
