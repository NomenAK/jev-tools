import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { createAnalysisContext } from "../adapters/analysis-context.ts";
import { collectAskRepository, repositoryPath } from "../adapters/ask-proof.ts";
import { collectProofSyntax } from "../adapters/ask-syntax.ts";
import { captureCommand } from "../adapters/command.ts";
import { collectFiles } from "../adapters/files.ts";
import { shareGitInventory } from "../adapters/git-inventory.ts";
import { hostUsage } from "../adapters/usage.ts";
import {
  ASK_MAX_FILES,
  ASK_NOTE_MAX_CHARS,
  ASK_TIMEOUT_MAX_S,
  ASK_TIMEOUT_S,
  OUTPUT_CHUNK_CHARS,
  OUTPUT_FIND_MAX_CALLS,
  OUTPUT_SHAPE_MAX_COUNT,
  STATE_MAX_CHARS,
} from "../constants.ts";
import { buildAskClosure } from "../core/ask-closure.ts";
import {
  blockedAskReadings,
  resolveAskReferences,
} from "../core/ask-references.ts";
import { compileAsks, readAsks, reverseQuestions } from "../core/asks.ts";
import { outputChunks, selectOutput } from "../core/command-output.ts";
import {
  createImportGraphBuilder,
  type ImportSource,
} from "../core/imports.ts";
import { checkIntegrity } from "../core/integrity.ts";
import type { BudgetRefusal, EnvelopeInput } from "../core/output.ts";
import { buildEnvelope } from "../core/output.ts";
import { assembleState } from "../core/state.ts";
import { discoverTests } from "../core/test-discovery.ts";
import { describeAsk } from "../describe.ts";
import type { GuideContext } from "../guide.ts";
import type { Judgment } from "../jev/types.ts";
import { renderEnvelope } from "../render.ts";
import { isRecord } from "../result.ts";
import type { ToolDependencies } from "../runtime.ts";
import { COMMAND_LIMIT_NOTICE } from "../texts/ask.ts";
import { NOT_CONFIGURED } from "../texts/configuration.ts";
import { asksParameter } from "./ask-schema.ts";

export const askParameters = Type.Object(
  {
    state: Type.Optional(Type.String({ maxLength: ASK_NOTE_MAX_CHARS })),
    paths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { maxItems: ASK_MAX_FILES }),
    ),
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

export function createAskTool({
  client,
  host,
  runtime,
  exec: execute,
}: ToolDependencies) {
  const { isOmp, names } = host;
  const allowCommand = process.env.JEV_TOOLS_ALLOW_COMMAND !== "0";
  const parameters = allowCommand
    ? askParameters
    : Type.Omit(askParameters, ["command", "timeout_s"]);
  return {
    name: "jev_ask",
    label: "Jev ask",
    description: `${describeAsk(names)}\n\n${COMMAND_LIMIT_NOTICE}`,
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
          promptGuidelines: [
            "jev_ask: before you conclude that a failure is a bug in the code, a wrong test or the environment, or that a plan matches the docs, pass the files to jev_ask and weigh its answer against your own reading",
          ],
        }),
    async execute(
      _id: string,
      args: AskArgs,
      signal: AbortSignal | undefined,
      _update: unknown,
      ctx: { cwd: string } & GuideContext,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: Judgment;
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
      const started = performance.now();
      const exec = shareGitInventory(execute);
      const finish = (
        result: Judgment,
        input: Omit<EnvelopeInput, "yield">,
      ) => {
        const envelope = buildEnvelope({
          ...input,
          yield: {
            calls: result.calls ?? 0,
            questions: result.questions ?? 0,
            costUsd: result.usage?.costUsd,
            cacheHits: result.cacheHits ?? 0,
            cacheRequests: result.cacheRequests ?? 0,
            elapsedMs: performance.now() - started,
          },
        });
        runtime.session.record(envelope);
        runtime.guide.deliver(ctx);
        return {
          content: [{ type: "text" as const, text: renderEnvelope(envelope) }],
          details: result,
        };
      };
      const textResult = (text: string) =>
        finish({ ok: false, error: text }, { refusal: text });
      if (!client) return textResult(NOT_CONFIGURED);
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
      const asks = compileAsks(args.asks, { surface: "ask" });
      if (!asks.ok) return textResult(asks.error);
      const files = await collectFiles(ctx.cwd, args.paths ?? [], signal, {
        exec,
        allowEmpty: true,
        skipInvalidUtf8: true,
      });
      if (!files.ok) return textResult(files.error);
      if (
        !Object.keys(files.files).length &&
        args.state === undefined &&
        !args.command &&
        files.skipped.length
      )
        return textResult(`No readable evidence: ${files.skipped.join("; ")}`);
      const proofLimitations: Array<
        NonNullable<EnvelopeInput["limitations"]>[number]
      > = files.skipped.map((fact) => ({
        fact,
        next: "Provide this file as UTF-8 text if the judgment needs it.",
      }));
      let repository = await collectAskRepository(
        exec,
        ctx.cwd,
        args.base,
        signal,
      );
      if (!repository.ok && args.base) return textResult(repository.error);
      if (!repository.ok)
        proofLimitations.push({
          fact: `closure unavailable: ${repository.error}`,
          next: "pass dependencies explicitly in paths",
        });
      const command = args.command
        ? await captureCommand(
            exec,
            repository.ok ? repository.root : ctx.cwd,
            args.command,
            args.timeout_s,
            signal,
          )
        : undefined;
      if (command && !command.ok) return textResult(command.error);
      if (command?.ok) {
        repository = await collectAskRepository(
          exec,
          ctx.cwd,
          args.base,
          signal,
        );
        if (!repository.ok && args.base) return textResult(repository.error);
      }
      const initialState = assembleState(args.state, files.files);
      if (!initialState.ok) return textResult(initialState.error);
      if (command?.ok && Object.hasOwn(initialState.state, "output"))
        return textResult(
          "state contains reserved key output when command is supplied; rename it in your note",
        );
      let outputNotIdentifiable = false;
      if (command?.ok && repository.ok) {
        for (const target of command.targets) {
          if (target.path.startsWith(`${repository.root}/`))
            target.path = target.path.slice(repository.root.length + 1);
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
          const local = repositoryPath(ctx.cwd, repository.root, path);
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
        files.files,
        repository?.ok ? [...repository.known] : [],
      );
      const unresolved = [...references.unresolved];
      if (repository?.ok) {
        const root = repository.root;
        const additions = await Promise.all(
          references.additions.map(async (addition) => ({
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
            files.files[addition.reference] = added.files[addition.path] ?? "";
            files.identities.push(
              ...added.identities.map((identity) => ({
                ...identity,
                requestedPath: addition.reference,
              })),
            );
          } else
            unresolved.push({
              reference: addition.reference,
              reason: added.error,
            });
        }
      }
      const state = assembleState(args.state, files.files);
      if (!state.ok) return textResult(state.error);
      if (command?.ok && Object.hasOwn(state.state, "output"))
        return textResult(
          "state contains reserved key output when command is supplied; rename it in your note",
        );
      if (command?.ok) state.state.output = { ...command.output };
      if (repository?.ok) {
        const canonical = Object.fromEntries(
          Object.entries(files.files).map(([path, text]) => [
            repositoryPath(repository.root, ctx.cwd, path),
            text,
          ]),
        );
        for (const addition of references.additions)
          canonical[addition.path] = files.files[addition.reference] ?? "";
        const sources: ImportSource[] = Object.entries(canonical).map(
          ([path, text]) => ({ path, text }),
        );
        const before: Record<string, string | null> = {};
        if (args.base) {
          for (const path of Object.keys(canonical)) {
            const old = await repository.readBefore(path);
            if (!old.ok) return textResult(old.error);
            before[path] = old.text;
          }
          state.state.base_sha = repository.baseSha ?? "";
          state.state.files_before = Object.fromEntries(
            Object.keys(files.files).map((path) => {
              const canonicalPath =
                references.additions.find(
                  (addition) => addition.reference === path,
                )?.path ?? repositoryPath(repository.root, ctx.cwd, path);
              return [path, before[canonicalPath] ?? null];
            }),
          );
          const stateSize = JSON.stringify(state.state).length;
          if (stateSize > STATE_MAX_CHARS) {
            const partSizes = Object.entries(state.state)
              .map(([part, value]) => `${part} ${JSON.stringify(value).length}`)
              .join(", ");
            return textResult(
              `serialized state including files_before exceeds ${STATE_MAX_CHARS} chars (${stateSize}); serialized parts: ${partSizes}; split the situation into smaller states.`,
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
        const closure = buildAskClosure({
          graph: { edges, limits },
          syntax,
          paths: Object.keys(canonical),
          intentions: JSON.stringify(asks.asks),
          state: state.state,
        });
        state.state = closure.state;
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
      const blocked = blockedAskReadings(
        asks,
        state.state,
        unresolved,
        args.state,
      );
      const inserted = isRecord(state.state.files) ? state.state.files : {};
      const identities = files.identities.map((file) => {
        const content = inserted[file.requestedPath];
        const insertedPath = Object.keys(inserted).find(
          (path) => resolve(ctx.cwd, path) === file.resolvedPath,
        );
        return {
          ...file,
          insertedPath: insertedPath ? resolve(ctx.cwd, insertedPath) : "",
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
      const questions = Object.fromEntries(
        Object.entries(asks.questions).filter(
          ([id]) => !blockedMembers.has(id),
        ),
      );
      const integrity = checkIntegrity(
        state.state,
        asks.asks,
        identities.filter((identity) => identity.content.trim().length > 0),
      );
      let sent = 0;
      let refusal: BudgetRefusal | undefined;
      const findResults: Judgment[] = [];
      const options = {
        signal,
        cache: !args.command,
        beforeRequest: (questionCount: number) => {
          if (args.max_calls !== undefined && sent >= args.max_calls) {
            refusal = {
              kind: "max_calls",
              message: `max_calls=${args.max_calls} reached`,
            };
            return { ok: false, error: refusal.message };
          }
          const admitted = runtime.session.admit(questionCount);
          if (!admitted.ok) {
            refusal = { kind: "session", message: admitted.error };
            return admitted;
          }
          sent++;
          return admitted;
        },
        onUsage: (usage: { inputTokens: number; costUsd: number }) =>
          runtime.session.recordUsage(usage),
      };
      if (command?.ok) {
        const output = command.output;
        const text = output.stdout + output.stderr;
        const size = JSON.stringify({ ...state.state, output }).length;
        if (size > STATE_MAX_CHARS) {
          const stdoutChunks = outputChunks(output.stdout);
          const stderrChunks = outputChunks(output.stderr);
          const chunks = [...stdoutChunks, ...stderrChunks];
          if (
            command.compressedChars >
              OUTPUT_CHUNK_CHARS * OUTPUT_FIND_MAX_CALLS ||
            chunks.length > OUTPUT_FIND_MAX_CALLS
          )
            return textResult(
              `output requires more than ${OUTPUT_FIND_MAX_CALLS} find calls: ${command.originalBytes} bytes before, ${command.compressedChars} chars after compression; narrow command (remove verbosity or filter)`,
            );
          const found = await Promise.all(
            chunks.map(async (chunk) => {
              const judgment = await client.judge(
                { output: chunk.text },
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
          const emptySize = JSON.stringify({
            ...state.state,
            output: { ...output, stdout: "", stderr: "", truncated: true },
          }).length;
          const budget = STATE_MAX_CHARS - emptySize - 16;
          if (budget < 100)
            return textResult(
              "No space for command output; reduce paths or state.",
            );
          const stderrSize = JSON.stringify(output.stderr).length;
          const stdoutSize = JSON.stringify(output.stdout).length;
          const stdoutBudget = !output.stderr
            ? budget
            : stderrSize < budget / 2
              ? budget - stderrSize
              : stdoutSize < budget / 2
                ? stdoutSize
                : Math.floor(
                    (budget * output.stdout.length) / Math.max(1, text.length),
                  );
          output.stdout = output.stdout
            ? selectOutput(
                output.stdout,
                stdoutChunks,
                found.slice(0, stdoutChunks.length),
                stdoutBudget,
              )
            : "";
          output.stderr = output.stderr
            ? selectOutput(
                output.stderr,
                stderrChunks,
                found.slice(stdoutChunks.length),
                budget - stdoutBudget,
              )
            : "";
          if (
            chunks.some(
              (chunk, index) =>
                (found[index] ?? 0) >= 0.5 &&
                !(
                  index < stdoutChunks.length ? output.stdout : output.stderr
                ).includes(chunk.text),
            )
          )
            integrity.controls.push({
              fact: "failing output passages omitted: insufficient state budget",
              next: "narrow command or reduce paths",
            });
          output.truncated = true;
          command.selectedPassages =
            output.stdout.length + output.stderr.length < text.length;
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
            usage: {
              inputTokens:
                (first.usage?.inputTokens ?? 0) +
                (reversed.usage?.inputTokens ?? 0),
              costUsd:
                (first.usage?.costUsd ?? 0) + (reversed.usage?.costUsd ?? 0),
            },
          };
        }
      }
      for (const found of findResults)
        result = {
          ...result,
          calls: (result.calls ?? 0) + (found.calls ?? 0),
          questions: (result.questions ?? 0) + (found.questions ?? 0),
          usage: {
            inputTokens:
              (result.usage?.inputTokens ?? 0) +
              (found.usage?.inputTokens ?? 0),
            costUsd: (result.usage?.costUsd ?? 0) + (found.usage?.costUsd ?? 0),
          },
        };
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
            continue;
          }
          if (!Object.hasOwn(inserted, selected)) {
            attribution.push({
              fact: `attribution ${reading.label}: designated piece ${selected} is absent`,
              next: `add ${selected} to paths before acting`,
            });
            continue;
          }
          const selectedPath = repository?.ok
            ? (references.additions.find(
                (addition) => addition.reference === selected,
              )?.path ?? repositoryPath(repository.root, ctx.cwd, selected))
            : selected;
          const retained = (path: string) => {
            if (!repository?.ok) return path !== selected;
            return (
              (references.additions.find(
                (addition) => addition.reference === path,
              )?.path ?? repositoryPath(repository.root, ctx.cwd, path)) !==
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
            usage: {
              inputTokens:
                (result.usage?.inputTokens ?? 0) +
                (control.usage?.inputTokens ?? 0),
              costUsd:
                (result.usage?.costUsd ?? 0) + (control.usage?.costUsd ?? 0),
            },
          };
        }
      }
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
