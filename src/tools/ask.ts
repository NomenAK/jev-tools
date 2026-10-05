import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { createAnalysisContext } from "../adapters/analysis-context.ts";
import { collectAskRepository, repositoryPath } from "../adapters/ask-proof.ts";
import { collectProofSyntax } from "../adapters/ask-syntax.ts";
import { canonicalPath } from "../adapters/canonical-path.ts";
import { captureCommand } from "../adapters/command.ts";
import {
  type EvidenceContext,
  resolveEvidenceContext,
  withEvidenceContext,
} from "../adapters/evidence-context.ts";
import { collectFiles } from "../adapters/files.ts";
import { shareGitInventory } from "../adapters/git-inventory.ts";
import { hostUsage } from "../adapters/usage.ts";
import {
  ASK_MAX_FILES,
  ASK_NOTE_MAX_CHARS,
  ASK_TIMEOUT_MAX_S,
  ASK_TIMEOUT_S,
  OUTPUT_SHAPE_MAX_COUNT,
  STATE_MAX_CHARS,
} from "../constants.ts";
import { buildAskClosure } from "../core/ask-closure.ts";
import type { ReferenceResolution } from "../core/ask-references.ts";
import {
  blockedAskReadings,
  resolveAskReferences,
} from "../core/ask-references.ts";
import {
  compileAsks,
  readAsks,
  reverseQuestions,
  sameSubjectQuestions,
} from "../core/asks.ts";
import {
  fitOutputToBudget,
  needsPassageFinding,
  planPassageFinding,
} from "../core/command-state.ts";
import {
  createImportGraphBuilder,
  type ImportSource,
} from "../core/imports.ts";
import { checkIntegrity } from "../core/integrity.ts";
import type { AnswerInput, EnvelopeInput } from "../core/output.ts";
import {
  type Action,
  answerItemFromInput,
  buildResultReport,
  type Cause,
  type Context,
  contextFromEvidence,
  type Diagnostic,
  type Item,
  known,
  notApplicable,
  type ResultReportV1,
  unknown,
} from "../core/result-report.ts";
import { assembleState } from "../core/state.ts";
import { discoverTests } from "../core/test-discovery.ts";
import { describeAsk } from "../describe.ts";
import type { GuideContext } from "../guide.ts";
import type { Judgment } from "../jev/types.ts";
import { renderResultReport } from "../render.ts";
import { isRecord } from "../result.ts";
import type { ToolDependencies } from "../runtime.ts";
import { NOT_CONFIGURED } from "../texts/configuration.ts";
import { ASK_GUIDELINE } from "../texts/instructions.ts";
import { asksParameter } from "./ask-schema.ts";
import { createJudgeOptions, finishToolCall } from "./judge-options.ts";

interface AskEvidenceFacts {
  references?: ReferenceResolution;
  omissions: {
    reference: string;
    reason: string;
    origin?: string;
    scope?: string;
    required?: boolean;
  }[];
  blockedGroups: { ids: string[]; reason: string; cause?: Cause }[];
  inventory: string[];
}

export const askParameters = Type.Object(
  {
    root: Type.Optional(Type.String()),
    state: Type.Optional(Type.String({ maxLength: ASK_NOTE_MAX_CHARS })),
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    base: Type.Optional(Type.String({ minLength: 1 })),
    command: Type.Optional(Type.String({ minLength: 1 })),
    timeout_s: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: ASK_TIMEOUT_MAX_S,
        default: ASK_TIMEOUT_S,
      }),
    ),
    asks: asksParameter("ask"),
    max_calls: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type AskArgs = Static<typeof askParameters>;

export function createAskTool(dependencies: ToolDependencies) {
  const { host, runtime, exec: execute } = dependencies;
  const { isOmp, names } = host;
  const allowCommand = process.env.JEV_TOOLS_ALLOW_COMMAND !== "0";
  const parameters = allowCommand
    ? askParameters
    : Type.Omit(askParameters, ["command", "timeout_s"]);
  return {
    name: "jev_ask",
    label: "Jev ask",
    description: describeAsk(names),
    parameters,
    ...(isOmp
      ? {
          approval: (args: AskArgs) =>
            args.command ? ("exec" as const) : ("read" as const),
          loadMode: "essential" as const,
        }
      : {
          promptSnippet:
            "Typed answers about one situation built from a note, files and a command's output",
          promptGuidelines: [ASK_GUIDELINE],
        }),
    async execute(
      _id: string,
      args: AskArgs,
      signal: AbortSignal | undefined,
      _update: unknown,
      ctx: { cwd: string } & GuideContext,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: Judgment & {
        result: ResultReportV1;
        evidenceContext: EvidenceContext;
        evidenceFacts: AskEvidenceFacts;
      };
      usage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
        cost: {
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
          total: number;
        };
      };
    }> {
      const client = dependencies.client;
      const evidence = await resolveEvidenceContext(ctx.cwd, args.root, {
        exec: execute,
        signal,
        origin: dependencies.evidenceOrigin,
      });
      const evidenceContext = evidence.context;
      const cwd = evidence.ok ? evidence.cwd : evidenceContext.authority.path;
      const started = performance.now();
      const evidenceFacts: AskEvidenceFacts = {
        omissions: [],
        blockedGroups: [],
        inventory: [],
      };
      evidenceContext.requestedBase = args.base;
      const asks = compileAsks(args.asks, { surface: "ask" });
      let commandContext: Context["command"] = args.command
        ? {
            execution: "not_started",
            cwd: evidence.ok
              ? known(cwd)
              : unknown("effective root not established"),
            exitCode: unknown("command not started"),
            timedOut: unknown("command not started"),
          }
        : {
            execution: "not_requested",
            cwd: notApplicable("no command"),
            exitCode: notApplicable("no command"),
            timedOut: notApplicable("no command"),
          };
      let refusalCause: Cause = "invalid_arguments";
      let inventoryCollected = false;
      const auxiliary = {
        controls: { fresh: 0, cache: 0, notJudged: 0, static: 0 },
        passages: { fresh: 0, cache: 0, notJudged: 0 },
      };
      const attributionAnswers: Record<string, AnswerInput["reportControls"]> =
        {};
      const attributionMissing = new Set<string>();
      const findResults: Judgment[] = [];
      const exec = shareGitInventory(execute);
      const finish = (
        result: Judgment,
        input: Omit<EnvelopeInput, "yield">,
      ) => {
        const { content, envelope } = finishToolCall(runtime, ctx, started, input, {
          calls: result.calls ?? 0,
          questions: result.questions ?? 0,
          costUsd: result.usage?.costUsd,
          cacheHits: result.cacheHits ?? 0,
          cacheRequests: result.cacheRequests ?? 0,
        });
        const diagnostics: Diagnostic[] = [];
        const actions: Action[] = [];
        const globalMissing = new Map<
          string,
          { diagnosticIds: string[]; actionIds: string[] }
        >();
        const diagnose = (
          cause: Cause,
          fact: string,
          scope: Diagnostic["scope"],
          target: string | undefined,
          origin: Diagnostic["origin"],
          effect: Diagnostic["effect"] = "blocking",
          next?: string,
        ) => {
          const id = `diagnostic:${diagnostics.length}`;
          const actionId = `action:${actions.length}`;
          const code =
            cause === "invalid_root" || cause === "invalid_base"
              ? "correct_context"
              : cause === "forbidden_path"
                ? "correct_reference"
                : cause === "missing_required" || cause === "empty_required"
                  ? "provide_evidence"
                  : cause === "not_configured"
                    ? "configure_client"
                    : "inspect_native";
          actions.push({
            id: actionId,
            code,
            target:
              target === undefined
                ? unknown("target not established")
                : known(target),
            scope,
            condition:
              "Only if materially new evidence or corrected context is available",
            instruction:
              next ??
              (code === "provide_evidence"
                ? `Provide the actually missing evidence${target ? `: ${target}` : ""}; do not repeat an already captured command.`
                : "Inspect the supplied evidence natively; correct the named cause before any useful new Jev call."),
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
            origin,
            scope,
            effect,
            material: true,
            omittedMembers: [],
            memberCount: known(0),
            actionIds: [actionId],
          });
          return { diagnosticIds: [id], actionIds: [actionId] };
        };
        const items: Item[] = asks.ok
          ? asks.readings.map((reading, index) => {
              const groupId = `group:${asks.groups.findIndex((group) => group.includes(reading.id))}`;
              const target = asks.asks[reading.askIndex]?.about ?? "state";
              const pieces: Item["evidence"] = [
                {
                  target,
                  canonicalPath: unknown(
                    "selector does not establish a canonical file identity",
                  ),
                  aliases: [],
                  side: target === "output" ? "output" : "state",
                  revision: notApplicable("non-file evidence"),
                },
              ];
              for (const [alias, path] of Object.entries(
                evidenceFacts.references?.aliases ?? {},
              )) {
                const before =
                  evidenceFacts.references?.additions.some(
                    (addition) =>
                      addition.reference === alias &&
                      addition.side === "files_before",
                  ) || target.includes("files_before");
                pieces.push({
                  target: alias,
                  canonicalPath: evidenceContext.effectiveRoot
                    ? known(resolve(evidenceContext.effectiveRoot.path, path))
                    : unknown("effective root unavailable"),
                  aliases: [alias],
                  side: before ? "before" : "current",
                  revision:
                    before && evidenceContext.resolvedBase
                      ? known(evidenceContext.resolvedBase)
                      : unknown("working tree evidence"),
                });
              }
              const common = {
                id: reading.id,
                kind:
                  reading.kind === "verify"
                    ? ("claim" as const)
                    : ("question" as const),
                label: reading.label,
                groupId,
                evidence: pieces,
                diagnosticIds: [] as string[],
                actionIds: [] as string[],
              };
              const originalAnswer = input.answers?.[index];
              const attributionControls = attributionAnswers[reading.id];
              const answer =
                originalAnswer && attributionMissing.has(reading.id)
                  ? {
                      ...originalAnswer,
                      unjudged: true,
                      reason: "Required attribution control is incomplete",
                    }
                  : originalAnswer && attributionControls
                    ? {
                        ...originalAnswer,
                        reportControls: [
                          ...(originalAnswer.reportControls ?? []),
                          ...attributionControls,
                        ],
                      }
                    : originalAnswer;
              if (
                answer &&
                !answer.unjudged &&
                (answer.source || answer.answer?.source)
              )
                return answerItemFromInput(
                  common,
                  input.controls?.length
                    ? {
                        ...answer,
                        band: "unsure",
                        reason: input.controls
                          .map((control) => control.fact)
                          .join("; "),
                      }
                    : answer,
                );
              const blocked = evidenceFacts.blockedGroups.find((group) =>
                group.ids.includes(reading.id),
              );
              const omission = evidenceFacts.omissions.find(
                (item) =>
                  item.required &&
                  (item.origin === "note" || item.scope === reading.id),
              );
              const groupFailure = result.ok
                ? (
                    asks.groups.find((group) => group.includes(reading.id)) ??
                    []
                  )
                    .map((id) => result.answers[id])
                    .find(
                      (answer) => answer?.type === "unjudged" && answer.cause,
                    )
                : undefined;
              const cause = blocked
                ? (blocked.cause ?? "missing_required")
                : groupFailure?.type === "unjudged" && groupFailure.cause
                  ? groupFailure.cause
                  : input.budget
                    ? input.budget.kind === "session"
                      ? "session_budget"
                      : "call_budget"
                    : (result.failureCause ??
                      (input.refusal ? refusalCause : "control_failure"));
              const globalKey =
                omission?.origin === "note" ? omission.reference : undefined;
              const existingLinks = globalKey
                ? globalMissing.get(globalKey)
                : undefined;
              const links =
                existingLinks ??
                diagnose(
                  cause,
                  blocked?.reason ??
                    answer?.reason ??
                    (result.ok
                      ? "Required judgment group incomplete or response provenance not established"
                      : result.error),
                  omission?.origin === "note"
                    ? { kind: "call" }
                    : { kind: "group", groupIds: [groupId] },
                  omission?.reference,
                  omission?.origin === "note"
                    ? "note"
                    : blocked
                      ? "ask"
                      : input.budget
                        ? "budget"
                        : "provider",
                );
              if (globalKey) globalMissing.set(globalKey, links);
              return {
                ...common,
                ...links,
                treatment: "not_judged",
                source: "none",
              };
            })
          : [];
        if (!items.length)
          diagnose(
            input.refusal ? refusalCause : "collection_empty",
            input.refusal ?? "No requested results collected",
            { kind: "call" },
            undefined,
            "input",
          );
        for (const control of input.controls ?? [])
          diagnose(
            "control_failure",
            control.fact,
            { kind: "call" },
            undefined,
            "control",
            "reservation",
            control.next,
          );
        for (const limitation of input.limitations ?? [])
          diagnose(
            "evidence_limit",
            limitation.fact,
            { kind: "call" },
            limitation.path,
            "closure",
            "reservation",
            limitation.next,
          );
        const report = buildResultReport({
          tool: "jev_ask",
          context: contextFromEvidence(evidenceContext, {
            command: commandContext,
            inventories: inventoryCollected
              ? [
                  {
                    id: "repository",
                    kind: "repository",
                    rules: ["Git tracked and admitted repository evidence"],
                    restrictions: args.paths ?? [],
                    discovered: known(evidenceFacts.inventory.length),
                    considered: known(evidenceFacts.inventory.length),
                    scopeRestricted: false,
                    criteria: [],
                  },
                ]
              : [],
          }),
          items,
          diagnostics,
          actions,
          metrics: {
            calls: result.calls ?? 0,
            questions: result.questions ?? 0,
            cacheHits: result.cacheHits ?? 0,
            cacheRequests: result.cacheRequests ?? 0,
            costUsd: result.usage?.costUsd,
            elapsedMs: performance.now() - started,
          },
          auxiliary,
          total: known(items.length),
          refused:
            !!input.refusal &&
            refusalCause !== "not_configured" &&
            !result.failureCause,
        });
        runtime.guide.deliver(ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: renderResultReport(report, { details: envelope }),
            },
          ],
          details: {
            ...result,
            result: report,
            evidenceContext,
            evidenceFacts,
          },
        };
      };
      const textResult = (text: string, cause: Cause = "invalid_arguments") => {
        refusalCause = cause;
        const technical = findResults.reduce(
          (totals, judgment) => ({
            calls: totals.calls + (judgment.calls ?? 0),
            questions: totals.questions + (judgment.questions ?? 0),
            cacheHits: totals.cacheHits + (judgment.cacheHits ?? 0),
            cacheRequests: totals.cacheRequests + (judgment.cacheRequests ?? 0),
          }),
          { calls: 0, questions: 0, cacheHits: 0, cacheRequests: 0 },
        );
        return finish(
          { ok: false, error: text, ...technical },
          { refusal: text },
        );
      };
      if (!evidence.ok)
        return textResult(evidence.error, evidence.cause ?? "invalid_root");
      if (!asks.ok) return textResult(asks.error);
      const preliminary = resolveAskReferences(asks, args.state, {}, []);
      if (preliminary.invalid.length) {
        evidenceFacts.references = preliminary;
        return textResult(
          preliminary.invalid.map((item) => item.reason).join("; "),
          "forbidden_path",
        );
      }
      if (!client) return textResult(NOT_CONFIGURED, "not_configured");
      if (args.command && !allowCommand)
        return textResult("command disabled by JEV_TOOLS_ALLOW_COMMAND=0");
      if (
        args.timeout_s !== undefined &&
        (!Number.isFinite(args.timeout_s) ||
          args.timeout_s < 1 ||
          args.timeout_s > ASK_TIMEOUT_MAX_S)
      )
        return textResult(
          `timeout_s must be between 1 and ${ASK_TIMEOUT_MAX_S}`,
        );
      if (args.state === undefined && !args.paths?.length && !args.command)
        return textResult("Provide state, command or at least one path.");
      const files = await collectFiles(cwd, args.paths ?? [], signal, {
        exec,
        allowEmpty: true,
        skipInvalidUtf8: true,
      });
      if (!files.ok)
        return textResult(files.error, files.cause ?? "file_unavailable");
      if (
        !Object.keys(files.files).length &&
        args.state === undefined &&
        !args.command &&
        files.skipped.length
      )
        return textResult(
          `No readable evidence: ${files.skipped.join("; ")}`,
          "collection_empty",
        );
      const proofLimitations: Array<
        NonNullable<EnvelopeInput["limitations"]>[number]
      > = files.skipped.map((fact) => ({
        fact,
        next: "Provide this file as UTF-8 text if the judgment needs it.",
      }));
      let repository = await collectAskRepository(exec, cwd, args.base, signal);
      inventoryCollected = repository.ok;
      if (repository.ok) {
        evidenceFacts.inventory = [...repository.known];
        evidenceContext.resolvedBase = repository.baseSha;
      }
      if (!repository.ok && args.base)
        return textResult(repository.error, "invalid_base");
      if (!repository.ok)
        proofLimitations.push({
          fact: `closure unavailable: ${repository.error}`,
          next: "pass dependencies explicitly in paths",
        });
      if (args.command)
        commandContext = {
          ...commandContext,
          execution: "started",
          cwd: known(repository.ok ? repository.root : cwd),
        };
      const command = args.command
        ? await captureCommand(
            exec,
            repository.ok ? repository.root : cwd,
            args.command,
            args.timeout_s,
            signal,
            dependencies.apiKey ?? process.env.JEV_TOOLS_API_KEY,
          )
        : undefined;
      if (command?.ok)
        commandContext = {
          execution: "finished",
          cwd: known(repository.ok ? repository.root : cwd),
          exitCode: known(command.output.exit_code),
          timedOut: known(command.output.timed_out),
        };
      if (command && !command.ok) {
        commandContext = {
          // Reported execution states are not_requested, not_started, started
          // and finished. A spawn whose completion was not observed (adapter
          // "unknown") did start, so it reports "started" with unknown exit
          // code and timeout.
          execution:
            command.commandExecution === "unknown"
              ? "started"
              : command.commandExecution,
          cwd: known(repository.ok ? repository.root : cwd),
          exitCode:
            command.commandExitCode !== undefined
              ? known(command.commandExitCode)
              : unknown("command completion not observed"),
          timedOut:
            command.commandTimedOut !== undefined
              ? known(command.commandTimedOut)
              : unknown("command completion not observed"),
        };
        return textResult(command.error, command.cause ?? "file_unavailable");
      }
      if (command?.ok) {
        repository = await collectAskRepository(exec, cwd, args.base, signal);
        if (!repository.ok && args.base)
          return textResult(repository.error, "invalid_base");
      }
      const initialState = assembleState(args.state, files.files);
      if (!initialState.ok) return textResult(initialState.error);
      if (command?.ok && Object.hasOwn(initialState.state, "output"))
        return textResult(
          "state contains reserved key output when command is supplied; rename it in your note",
          "reserved_key",
        );
      let outputNotIdentifiable = false;
      if (command?.ok && repository.ok) {
        for (const target of command.targets) {
          if (target.path.startsWith(`${repository.root}/`))
            target.path = target.path.slice(repository.root.length + 1);
          else if (isAbsolute(target.path)) {
            // Windows reports C:/... or short 8.3 forms; compare canonically.
            const local = relative(
              repository.root,
              await canonicalPath(target.path),
            )
              .split("\\")
              .join("/");
            if (local && !local.startsWith("../") && !isAbsolute(local))
              target.path = local;
          }
          let matches = [...repository.known].filter(
            (path) => path === target.path || path.endsWith(`/${target.path}`),
          );
          if (target.testName) {
            const matched: string[] = [];
            for (const candidate of matches) {
              const source = await collectFiles(
                repository.root,
                [candidate],
                signal,
                { exec, allowEmpty: true, inventory: repository.known },
              );
              if (
                source.ok &&
                discoverTests([
                  { path: candidate, text: source.files[candidate] ?? "" },
                ]).entries.some((entry) =>
                  entry.scenarios.some(
                    (scenario) => scenario.name === target.testName,
                  ),
                )
              )
                matched.push(candidate);
            }
            matches = matched;
          }
          if (matches.length !== 1) {
            outputNotIdentifiable ||= command.assertion && target.assertion;
            continue;
          }
          const path = matches[0];
          if (!path) continue;
          const local = repositoryPath(cwd, repository.root, path);
          if (!Object.hasOwn(files.files, local)) {
            const added = await collectFiles(repository.root, [path], signal, {
              exec,
              allowEmpty: true,
              inventory: repository.known,
            });
            if (added.ok && Object.keys(files.files).length < ASK_MAX_FILES) {
              files.files[local] = added.files[path] ?? "";
              files.identities.push(
                ...added.identities.map((identity) => ({
                  ...identity,
                  requestedPath: local,
                })),
              );
            } else {
              outputNotIdentifiable ||= command.assertion && target.assertion;
              continue;
            }
          }
          if (target.assertion && target.nodeId?.includes("::")) {
            const discovery = discoverTests([
              { path, text: files.files[local] ?? "" },
            ]);
            const name = target.nodeId
              .split("::")
              .slice(1)
              .join("::")
              .replace(/\[[\s\S]*\]$/, "");
            if (
              !discovery.entries.some((entry) =>
                entry.scenarios.some(
                  (scenario) =>
                    scenario.id === name ||
                    scenario.name === name.split("::").at(-1),
                ),
              )
            )
              outputNotIdentifiable ||= command.assertion;
          }
        }
      }
      if (
        command?.ok &&
        command.assertion &&
        (!command.targets.length || !repository.ok) &&
        !discoverTests(
          Object.entries(files.files).map(([path, text]) => ({ path, text })),
        ).entries.length
      )
        outputNotIdentifiable = true;
      const references = resolveAskReferences(
        asks,
        args.state,
        repository.ok
          ? {
              files: Object.fromEntries(
                Object.entries(files.files).map(([path, text]) => [
                  repositoryPath(repository.root, cwd, path),
                  text,
                ]),
              ),
              beforeInventory: args.base ? [...repository.beforeKnown] : [],
            }
          : files.files,
        repository?.ok ? [...repository.known] : [],
      );
      evidenceFacts.references = references;
      evidenceFacts.inventory = repository.ok ? [...repository.known] : [];
      if (references.invalid.length)
        return textResult(
          references.invalid.map((item) => item.reason).join("; "),
          "forbidden_path",
        );
      const unresolved = [...references.unresolved];
      const historical: Record<string, string | null> = {};
      if (repository.ok && args.base) {
        for (const reference of references.additions.filter(
          (reference) =>
            reference.side === "files_before" && reference.required,
        )) {
          const before = await repository.readBefore(reference.path);
          if (before.ok) historical[reference.path] = before.text;
          else {
            if (before.cause === "forbidden_path")
              return textResult(before.error, before.cause);
            unresolved.push({
              ...reference,
              reason: before.error,
              ...(before.cause ? { cause: before.cause } : {}),
            });
          }
        }
      }
      if (repository?.ok) {
        const root = repository.root;
        const additions = await Promise.all(
          references.additions
            .filter((addition) => addition.side !== "files_before")
            .map(async (addition) => ({
              addition,
              added: await collectFiles(root, [addition.path], signal, {
                allowEmpty: true,
                exec,
                inventory: repository.known,
              }),
            })),
        );
        for (const { addition, added } of additions) {
          if (added.ok) {
            const local = repositoryPath(cwd, root, addition.path);
            files.files[local] = added.files[addition.path] ?? "";
            files.identities.push(
              ...added.identities.map((identity) => ({
                ...identity,
                requestedPath: local,
              })),
            );
          } else
            unresolved.push({
              ...addition,
              reason: added.error,
              ...(added.cause ? { cause: added.cause } : {}),
            });
        }
      }
      const state = assembleState(args.state, files.files);
      if (!state.ok) return textResult(state.error);
      if (command?.ok && Object.hasOwn(state.state, "output"))
        return textResult(
          "state contains reserved key output when command is supplied; rename it in your note",
          "reserved_key",
        );
      if (command?.ok) state.state.output = { ...command.output };
      if (repository?.ok) {
        if (evidenceContext.effectiveRoot)
          evidenceContext.effectiveRoot.path = repository.root;
        evidenceContext.requestedBase = args.base;
        evidenceContext.resolvedBase = repository.baseSha;
        const canonical = Object.fromEntries(
          Object.entries(files.files).map(([path, text]) => [
            repositoryPath(repository.root, cwd, path),
            text,
          ]),
        );
        state.state.files = canonical;
        state.state.evidence = {
          context: evidenceContext,
          aliases: Object.fromEntries(
            Object.entries(references.aliases)
              .map(([alias, path]): [string, string] => [
                alias,
                repository.known.has(path) || repository.beforeKnown.has(path)
                  ? path
                  : repositoryPath(repository.root, cwd, path),
              ])
              .sort(([a], [b]) => a.localeCompare(b)),
          ),
        };
        // Canonical repository paths are the sole serialized content keys.
        const sources: ImportSource[] = Object.entries(canonical).map(
          ([path, text]) => ({ path, text }),
        );
        const before: Record<string, string | null> = { ...historical };
        if (args.base) {
          for (const path of Object.keys(canonical)) {
            const old = await repository.readBefore(path);
            if (!old.ok)
              return textResult(old.error, old.cause ?? "file_unavailable");
            before[path] = old.text;
          }
          state.state.base_sha = repository.baseSha ?? "";
          state.state.files_before = before;
          const stateSize = JSON.stringify(
            command?.ok ? { ...state.state, output: undefined } : state.state,
          ).length;
          if (stateSize > STATE_MAX_CHARS) {
            const partSizes = Object.entries(state.state)
              .map(([part, value]) => `${part} ${JSON.stringify(value).length}`)
              .join(", ");
            return textResult(
              `serialized state including files_before exceeds ${STATE_MAX_CHARS} chars (${stateSize}); serialized parts: ${partSizes}; split the situation into smaller states.`,
              "evidence_too_large",
            );
          }
        }
        const configuration: ImportSource[] = [];
        for (const path of repository.known) {
          if (
            !/(^|\/)(?:(tsconfig|jsconfig)(?:\.[^/]+)?|package)\.json$/.test(
              path,
            )
          )
            continue;
          const source = await repository.read(path);
          if (source.ok) configuration.push(source);
        }
        const analysis = await createAnalysisContext();
        const buildGraph = createImportGraphBuilder(
          configuration,
          repository.known,
          analysis,
        );
        const edges = new Map<string, readonly string[]>();
        const limits: ReturnType<typeof buildGraph>["limits"][number][] = [];
        const declarations: Awaited<
          ReturnType<typeof collectProofSyntax>
        >["declarations"][number][] = [];
        const bindings: Awaited<
          ReturnType<typeof collectProofSyntax>
        >["bindings"][number][] = [];
        const syntaxLimits: Awaited<
          ReturnType<typeof collectProofSyntax>
        >["limits"][number][] = [];
        const uses = new Map<string, readonly string[]>();
        const reached = new Set(sources.map((source) => source.path));
        for (const path of Object.keys(canonical)) {
          if (!/(^|\/)(test[^/]*|[^/]*_test)\.py$/.test(path)) continue;
          let parent = path.slice(0, path.lastIndexOf("/") + 1);
          while (true) {
            const fixture = `${parent}conftest.py`;
            if (repository.known.has(fixture) && !reached.has(fixture)) {
              reached.add(fixture);
              const loaded = await repository.read(fixture);
              if (loaded.ok) sources.push(loaded);
            }
            if (!parent) break;
            parent = parent
              .slice(0, -1)
              .slice(0, parent.slice(0, -1).lastIndexOf("/") + 1);
          }
        }
        for (let index = 0; index < sources.length; index++) {
          const source = sources[index];
          if (!source) continue;
          if (args.base && !Object.hasOwn(before, source.path)) {
            const old = await repository.readBefore(source.path);
            if (old.ok) before[source.path] = old.text;
            else
              proofLimitations.push({
                fact: old.error,
                next: `provide before evidence for ${source.path}`,
              });
          }
          const parsed = await collectProofSyntax(
            [source],
            args.base ? before : undefined,
            analysis.parser,
          );
          declarations.push(...parsed.declarations);
          bindings.push(...parsed.bindings);
          syntaxLimits.push(...parsed.limits);
          for (const [path, names] of parsed.uses ?? []) uses.set(path, names);
          const graph = buildGraph([source]);
          for (const [path, targets] of graph.edges) edges.set(path, targets);
          limits.push(...graph.limits);
          if (
            !Object.hasOwn(canonical, source.path) &&
            !source.path.endsWith("conftest.py") &&
            !parsed.bindings.some((binding) => binding.reexport)
          )
            continue;
          for (const path of graph.edges.get(source.path) ?? []) {
            if (reached.has(path)) continue;
            reached.add(path);
            const loaded = await repository.read(path);
            if (loaded.ok) sources.push(loaded);
            else
              proofLimitations.push({
                fact: loaded.error,
                next: `provide readable evidence for ${path}`,
              });
          }
        }
        const syntax = {
          declarations,
          bindings,
          limits: syntaxLimits,
          uses,
          sources,
          ...(args.base ? { before } : {}),
        };
        const closureState = { ...state.state };
        if (command?.ok) delete closureState.output;
        const closure = buildAskClosure({
          graph: { edges, limits },
          syntax,
          paths: Object.keys(canonical),
          intentions: JSON.stringify(asks.asks),
          state: closureState,
        });
        state.state = closure.state;
        if (command?.ok) state.state.output = { ...command.output };
        proofLimitations.push(
          ...closure.limitations.filter(
            (limit) => !limit.fact.startsWith("Import closure only,"),
          ),
        );
        proofLimitations.push({
          fact: `closure: +${closure.added.length}${closure.added.length ? ` (${closure.added.map((piece) => `${piece.path} ${piece.name}, ${piece.chars} chars`).join("; ")})` : ""}; imports only, depth 1; files with no import link are not checked`,
          next: "pass unrelated config, docs and other flows in paths when the answer depends on them",
        });
      } else
        proofLimitations.push({
          fact: "closure: +0; imports only, depth 1; repository inventory unavailable",
          next: "pass dependencies explicitly in paths",
        });
      if (!repository.ok)
        state.state.evidence = {
          context: evidenceContext,
          aliases: references.aliases,
        };
      // Command output has its own passage-selection budget below. Only immutable
      // file/note evidence can refuse here, before selection has had a chance.
      const serializedSize = JSON.stringify(
        command?.ok ? { ...state.state, output: undefined } : state.state,
      ).length;
      if (serializedSize > STATE_MAX_CHARS)
        return textResult(
          `serialized state exceeds ${STATE_MAX_CHARS} chars (${serializedSize}); files and versions are never truncated`,
          "evidence_too_large",
        );
      evidenceFacts.omissions = unresolved;
      const blocked = blockedAskReadings(
        asks,
        state.state,
        unresolved,
        args.state,
      );
      const inserted = isRecord(state.state.files) ? state.state.files : {};
      const identities = files.identities.map((file) => {
        const insertedPath = repository.ok
          ? repositoryPath(repository.root, cwd, file.requestedPath)
          : file.requestedPath;
        const content = inserted[insertedPath];
        return {
          ...file,
          insertedPath: resolve(
            repository.ok ? repository.root : cwd,
            insertedPath,
          ),
          content: typeof content === "string" ? content : "",
          insertedSha256: createHash("sha256")
            .update(typeof content === "string" ? content : "")
            .digest("hex"),
        };
      });
      const blockedMembers = new Set(
        asks.groups
          .filter((group) => group.some((id) => blocked.has(id)))
          .flat(),
      );
      evidenceFacts.blockedGroups = asks.groups
        .filter((group) => group.some((id) => blocked.has(id)))
        .map((ids) => {
          const reason =
            ids
              .map((id) => blocked.get(id))
              .find((reason) => reason !== undefined) ??
            "Required evidence unavailable";
          // A secret refusal stays named as such instead of missing_required.
          const secret = unresolved.some(
            (item) => item.reason === reason && item.cause === "secret_pattern",
          );
          return {
            ids,
            reason,
            ...(secret ? { cause: "secret_pattern" as const } : {}),
          };
        });
      // Same-subject controls are judged in a second round only; sending
      // them here would judge every claim instead of contradicted ones.
      const secondRound = new Set(
        asks.readings.flatMap((reading) =>
          reading.sameSubject ? [reading.sameSubject] : [],
        ),
      );
      const questions = Object.fromEntries(
        Object.entries(asks.questions).filter(
          ([id]) => !blockedMembers.has(id) && !secondRound.has(id),
        ),
      );
      const integrity = checkIntegrity(
        state.state,
        asks.asks,
        identities.filter((identity) => identity.content.trim().length > 0),
      );
      const { options: judgeOptions, budget: callBudget } = createJudgeOptions({
        signal,
        maxCalls: args.max_calls,
        session: runtime.session,
      });
      const options = { ...judgeOptions, cache: !args.command };
      if (command?.ok) {
        const output = command.output;
        const text = output.stdout + output.stderr;
        if (needsPassageFinding(state.state, output)) {
          const planned = planPassageFinding({
            stdout: output.stdout,
            stderr: output.stderr,
            compressedChars: command.compressedChars,
            originalBytes: command.originalBytes,
          });
          if (!planned.ok)
            return textResult(planned.error, "evidence_too_large");
          const chunks = [
            ...planned.plan.stdoutChunks,
            ...planned.plan.stderrChunks,
          ];
          const chunkStates = chunks.map((chunk) =>
            withEvidenceContext({ output: chunk.text }, evidenceContext),
          );
          if (
            chunkStates.some(
              (chunkState) =>
                JSON.stringify(chunkState).length > STATE_MAX_CHARS,
            )
          )
            return textResult(
              `serialized output chunk including evidence context exceeds ${STATE_MAX_CHARS} chars; narrow command`,
              "evidence_too_large",
            );
          const found = await Promise.all(
            chunkStates.map(async (chunkState) => {
              const judgment = await client.judge(
                chunkState,
                {
                  find: {
                    type: "bool",
                    instructions:
                      "Does this excerpt of a command's output show something failing (a failed test or assertion, a compiler error, a crash, an error message) with its details?",
                  },
                },
                options,
              );
              findResults.push(judgment);
              return judgment.ok && judgment.answers.find?.type === "bool"
                ? judgment.answers.find.p
                : 0;
            }),
          );
          if (
            findResults.some(
              (judgment) =>
                !judgment.ok || judgment.answers.find?.type !== "bool",
            )
          )
            integrity.controls.push({
              fact: "output find incomplete: some chunks were not judged",
              next: "narrow command or raise max_calls",
            });
          const fitted = fitOutputToBudget(
            state.state,
            output,
            planned.plan,
            found,
          );
          if (!fitted.ok)
            return textResult(fitted.error, "evidence_too_large");
          output.stdout = fitted.fitted.stdout;
          output.stderr = fitted.fitted.stderr;
          if (fitted.fitted.omittedFailing)
            integrity.controls.push({
              fact: "failing output passages omitted: insufficient state budget",
              next: "narrow command or reduce paths",
            });
          output.truncated = true;
          command.selectedPassages = fitted.fitted.selectedPassages;
        }
        state.state.output = { ...output };
        const checked = checkIntegrity(state.state, asks.asks, [], {
          text: output.stdout + output.stderr,
          truncated: output.truncated,
          omittedChars: Math.max(
            0,
            command.lineOmittedChars +
              text.length -
              output.stdout.length -
              output.stderr.length,
          ),
        });
        integrity.controls.push(...checked.controls);
        integrity.notes.push(...checked.notes);
        if (JSON.stringify(state.state).length > STATE_MAX_CHARS)
          return textResult(
            "serialized command output exceeds state budget; narrow command or reduce paths",
            "evidence_too_large",
          );
        if (outputNotIdentifiable)
          integrity.controls.push({
            fact: "not identifiable: the output shows an assertion failure and the failing test is absent; a wrong test and a bug look alike",
            next: "pass the failing test and its code in paths",
          });
      }
      let result: Judgment = Object.keys(questions).length
        ? await client.judge(state.state, questions, {
            ...options,
            groups: asks.groups.filter(
              (group) => !group.some((id) => blockedMembers.has(id)),
            ),
          })
        : { ok: true, answers: {}, calls: 0, questions: 0 };
      if (result.ok) {
        for (const id of blockedMembers)
          result.answers[id] = {
            type: "unjudged",
            reason: blocked.get(id) ?? "required evidence is absent or empty",
          };
      }
      let reversed: Judgment | undefined;
      if (result.ok) {
        const reverse = reverseQuestions(asks, result.answers);
        if (Object.keys(reverse).length) {
          reversed = await client.judge(state.state, reverse, options);
          if (!reversed.ok)
            reversed = {
              ...reversed,
              ok: true,
              answers: Object.fromEntries(
                Object.keys(reverse).map((id) => [
                  id,
                  {
                    type: "unjudged" as const,
                    reason:
                      reversed && !reversed.ok
                        ? reversed.error
                        : "reverse control failed",
                  },
                ]),
              ),
            };
          const first = result;
          result = {
            ...first,
            calls: (first.calls ?? 0) + (reversed.calls ?? 0),
            questions: (first.questions ?? 0) + (reversed.questions ?? 0),
            cacheHits: (first.cacheHits ?? 0) + (reversed.cacheHits ?? 0),
            cacheRequests:
              (first.cacheRequests ?? 0) + (reversed.cacheRequests ?? 0),
            usage:
              first.usage && reversed.usage
                ? {
                    inputTokens:
                      first.usage.inputTokens + reversed.usage.inputTokens,
                    costUsd: first.usage.costUsd + reversed.usage.costUsd,
                  }
                : undefined,
          };
        }
      }
      for (const found of findResults)
        result = {
          ...result,
          calls: (result.calls ?? 0) + (found.calls ?? 0),
          questions: (result.questions ?? 0) + (found.questions ?? 0),
          cacheHits: (result.cacheHits ?? 0) + (found.cacheHits ?? 0),
          cacheRequests:
            (result.cacheRequests ?? 0) + (found.cacheRequests ?? 0),
          usage:
            result.usage && found.usage
              ? {
                  inputTokens:
                    result.usage.inputTokens + found.usage.inputTokens,
                  costUsd: result.usage.costUsd + found.usage.costUsd,
                }
              : undefined,
        };
      // Same-subject controls: one extra judge call for every contradicted
      // first-round verdict, on the same state. The call counts against
      // max_calls through options; a refused or failed round leaves each
      // control unjudged so readAsks demotes the contradiction.
      if (result.ok) {
        const controls = sameSubjectQuestions(
          asks,
          result.answers,
          reversed?.ok ? reversed.answers : undefined,
        );
        if (Object.keys(controls).length) {
          const second = await client.judge(state.state, controls, options);
          if (second.ok) Object.assign(result.answers, second.answers);
          else
            for (const id of Object.keys(controls))
              result.answers[id] = {
                type: "unjudged",
                reason: second.error,
              };
          const first = result;
          result = {
            ...first,
            calls: (first.calls ?? 0) + (second.calls ?? 0),
            questions: (first.questions ?? 0) + (second.questions ?? 0),
            cacheHits: (first.cacheHits ?? 0) + (second.cacheHits ?? 0),
            cacheRequests:
              (first.cacheRequests ?? 0) + (second.cacheRequests ?? 0),
            usage: {
              inputTokens:
                (first.usage?.inputTokens ?? 0) +
                (second.usage?.inputTokens ?? 0),
              costUsd:
                (first.usage?.costUsd ?? 0) + (second.usage?.costUsd ?? 0),
            },
          };
        }
      }
      const attribution: Array<
        NonNullable<EnvelopeInput["limitations"]>[number]
      > = [];
      if (result.ok) {
        const initial = readAsks(
          asks,
          result.answers,
          reversed?.ok ? reversed.answers : undefined,
        );
        for (const reading of asks.readings.filter(
          (reading) => reading.attributable,
        )) {
          const selected = initial.find(
            (answer) => answer.label === reading.label,
          )?.value?.head;
          if (
            typeof selected !== "string" ||
            !reading.among?.includes(selected)
          ) {
            attribution.push({
              fact: `attribution ${reading.label}: no designated candidate`,
              next: "provide decisive candidate evidence before acting",
            });
            attributionMissing.add(reading.id);
            auxiliary.controls.notJudged++;
            continue;
          }
          if (!Object.hasOwn(inserted, selected)) {
            attribution.push({
              fact: `attribution ${reading.label}: designated piece ${selected} is absent`,
              next: `add ${selected} to paths before acting`,
            });
            attributionMissing.add(reading.id);
            auxiliary.controls.notJudged++;
            continue;
          }
          const selectedPath = repository?.ok
            ? (references.additions.find(
                (addition) => addition.reference === selected,
              )?.path ?? repositoryPath(repository.root, cwd, selected))
            : selected;
          const retained = (path: string) => {
            if (!repository?.ok) return path !== selected;
            return (
              (references.additions.find(
                (addition) => addition.reference === path,
              )?.path ?? repositoryPath(repository.root, cwd, path)) !==
              selectedPath
            );
          };
          const ablated = {
            ...state.state,
            files: Object.fromEntries(
              Object.entries(inserted).filter(([path]) => retained(path)),
            ),
            ...(isRecord(state.state.files_before)
              ? {
                  files_before: Object.fromEntries(
                    Object.entries(state.state.files_before).filter(([path]) =>
                      retained(path),
                    ),
                  ),
                }
              : {}),
            ...(isRecord(state.state.closure)
              ? {
                  closure: Object.fromEntries(
                    Object.entries(state.state.closure).filter(
                      ([piece]) => !piece.startsWith(`${selectedPath} (`),
                    ),
                  ),
                }
              : {}),
          };
          const question = questions[reading.id];
          if (!question) continue;
          const control = await client.judge(
            ablated,
            { [reading.id]: question },
            options,
          );
          const answer = control.ok ? control.answers[reading.id] : undefined;
          if (answer && answer.type !== "unjudged" && answer.source)
            attributionAnswers[reading.id] = [
              {
                id: `${reading.id}:attribution`,
                kind: "attribution",
                source: answer.source,
                outcome:
                  answer.type === "choice"
                    ? answer.choice === selected
                      ? "does not rest on it"
                      : "attributed"
                    : "invalid attribution response",
                rawValues:
                  answer.type === "bool"
                    ? [
                        {
                          label: "attribution",
                          value: answer.p >= 0.5,
                          probability: known(answer.p),
                        },
                      ]
                    : Object.entries(answer.probabilities).map(
                        ([label, value]) => ({
                          label,
                          value: label,
                          probability: known(value),
                        }),
                      ),
              },
            ];
          if (answer?.type !== "choice") attributionMissing.add(reading.id);
          if (answer && answer.type !== "unjudged" && answer.source)
            auxiliary.controls[answer.source]++;
          else auxiliary.controls.notJudged++;
          attribution.push(
            answer?.type === "choice"
              ? {
                  fact: `attribution ${reading.label}: ${answer.choice === selected ? "does not rest on it" : "attributed"} (${selected})`,
                  next: "read the designated evidence before acting",
                }
              : {
                  fact: `attribution ${reading.label}: unjudged${!control.ok ? `: ${control.error}` : answer?.type === "unjudged" ? `: ${answer.reason}` : ""}`,
                  next: `rerun attribution for ${selected} before acting`,
                },
          );
          result = {
            ...result,
            calls: (result.calls ?? 0) + (control.calls ?? 0),
            questions: (result.questions ?? 0) + (control.questions ?? 0),
            cacheHits: (result.cacheHits ?? 0) + (control.cacheHits ?? 0),
            cacheRequests:
              (result.cacheRequests ?? 0) + (control.cacheRequests ?? 0),
            usage:
              result.usage && control.usage
                ? {
                    inputTokens:
                      result.usage.inputTokens + control.usage.inputTokens,
                    costUsd: result.usage.costUsd + control.usage.costUsd,
                  }
                : undefined,
          };
        }
      }
      const refusal = callBudget();
      const unchecked = asks.readings
        .filter(
          (reading) =>
            !result.ok ||
            [
              reading.id,
              ...(reading.twin ? [reading.twin] : []),
              ...Object.values(reading.controls ?? {}),
            ].some(
              (id) =>
                !result.answers[id] || result.answers[id]?.type === "unjudged",
            ) ||
            (reversed?.ok && reversed.answers[reading.id]?.type === "unjudged"),
        )
        .map((reading) => reading.label);
      for (const reading of asks.readings) {
        for (const id of [
          reading.twin,
          ...Object.values(reading.controls ?? {}),
        ].filter((id): id is string => !!id)) {
          const answer = result.ok ? result.answers[id] : undefined;
          if (answer && answer.type !== "unjudged" && answer.source)
            auxiliary.controls[answer.source]++;
          else auxiliary.controls.notJudged++;
        }
        if (
          reversed &&
          Object.hasOwn(reversed.ok ? reversed.answers : {}, reading.id)
        ) {
          const answer = reversed.ok ? reversed.answers[reading.id] : undefined;
          if (answer && answer.type !== "unjudged" && answer.source)
            auxiliary.controls[answer.source]++;
          else auxiliary.controls.notJudged++;
        }
      }
      for (const found of findResults) {
        const answer = found.ok ? found.answers.find : undefined;
        if (answer && answer.type !== "unjudged" && answer.source)
          auxiliary.passages[answer.source]++;
        else auxiliary.passages.notJudged++;
      }
      const output = finish(result, {
        ...(result.ok
          ? {
              answers: readAsks(
                asks,
                result.answers,
                reversed?.ok ? reversed.answers : undefined,
              ),
            }
          : !refusal
            ? { refusal: result.error }
            : {}),
        ...(refusal ? { budget: refusal, unchecked } : {}),
        controls: integrity.controls,
        state: {
          files: Object.keys(inserted).length,
          integrity: integrity.controls.length ? "failed" : "ok",
          warnings: asks.warnings.map((w) => w.fact),
        },
        limitationPriorityPaths: [],
        limitations: [
          ...(command?.ok
            ? [
                {
                  fact: `output: ${command.output.command} → ${command.output.timed_out ? "timed out" : `exit ${command.output.exit_code ?? "unavailable"}`} (${command.originalBytes} bytes → ${command.compressedChars} chars, repetitive lines collapsed${command.lineOmittedChars ? `, ${command.lineOmittedChars} line chars omitted` : ""}${command.selectedPassages ? ", selected passages" : ""})`,
                  next: "read command output with bash when exact text is needed",
                },
              ]
            : []),
          ...(command?.ok && command.redactions
            ? [
                {
                  fact: `output: ${command.redactions} occurrence${command.redactions === 1 ? "" : "s"} of the configured Jev API key replaced with [redacted]`,
                  next: "remove the key from the command's output; it is never sent to Jev",
                },
              ]
            : []),
          ...(command?.ok && command.shapeLimitExceeded
            ? [
                {
                  fact: `output shape limit exceeded at ${OUTPUT_SHAPE_MAX_COUNT}; rarity grouping disabled`,
                  next: "narrow command or reduce verbosity",
                },
              ]
            : []),
          ...asks.warnings,
          ...integrity.notes,
          ...proofLimitations,
          ...attribution,
        ],
      });
      return { ...output, ...hostUsage(isOmp, result.usage) };
    },
  } satisfies ToolDefinition<typeof parameters, Judgment>;
}
