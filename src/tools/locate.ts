import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import {
  resolveEvidenceContext,
  withEvidenceContext,
} from "../adapters/evidence-context.ts";
import { shareGitInventory } from "../adapters/git-inventory.ts";
import { readLocateFile, scanRange } from "../adapters/locate-file.ts";
import { loadSyntaxParser } from "../adapters/syntax.ts";
import { hostUsage } from "../adapters/usage.ts";
import {
  CHOICE_MAX_OPTIONS,
  LOCATE_GRAY_MIN,
  LOCATE_MIN_KB,
  LOCATE_SECTION_MAX_LINES,
  LOCATE_SHRINK_TOP,
  LOCATE_VERDICT_MIN,
  STATE_MAX_CHARS,
} from "../constants.ts";
import {
  locateDisplay,
  outlineEvidence,
  sectionOutline,
  sectionState,
  sectionStateFits,
} from "../core/locate.ts";
import {
  buildEnvelope,
  type EnvelopeInput,
  type Limitation,
} from "../core/output.ts";
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
  unknown,
} from "../core/result-report.ts";
import { type Section, sectionFile } from "../core/sections.ts";
import type { SyntaxParser } from "../core/units.ts";
import { interpolate } from "../describe.ts";
import type { GuideContext } from "../guide.ts";
import type { Answer, Judgment } from "../jev/types.ts";
import { renderResultReport } from "../render.ts";
import type { ToolDependencies } from "../runtime.ts";
import { NOT_CONFIGURED } from "../texts/configuration.ts";
import { LOCATE_DESCRIPTION } from "../texts/locate.ts";

const parameters = Type.Object(
  {
    root: Type.Optional(Type.String()),
    path: Type.String({ minLength: 1 }),
    goal: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
type LocateArgs = Static<typeof parameters>;

export function createLocateTool(
  dependencies: ToolDependencies,
  loadParser: () => Promise<SyntaxParser | undefined> = loadSyntaxParser,
) {
  const { host, runtime, exec: execute } = dependencies;
  return {
    name: "jev_locate_in_file",
    label: "Jev locate in file",
    description: interpolate(
      LOCATE_DESCRIPTION.replace(
        "{{ompOutline}}",
        host.isOmp
          ? " read already outlines code files; use this when the outline does not tell you which range to open."
          : "",
      ),
      host.names,
    ),
    parameters,
    ...(host.isOmp
      ? { approval: "read" as const, loadMode: "essential" as const }
      : {
          promptSnippet:
            "Find which line range of one large file serves a goal",
        }),
    async execute(
      _id: string,
      args: LocateArgs,
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
      const results: Judgment[] = [];
      const limitations: Limitation[] = [];
      const context = contextFromEvidence(evidenceContext);
      const diagnostics: Diagnostic[] = [];
      const actions: Action[] = [];
      const auxiliary = {
        controls: { fresh: 0, cache: 0, notJudged: 0, static: 0 },
        passages: { fresh: 0, cache: 0, notJudged: 0 },
      };
      let primary: Answer | undefined;
      let control: Answer | undefined;
      let requiredControl = false;
      let failureCause: Cause = "invalid_response";
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
      const diagnose = (cause: Cause, fact: string, members: string[] = []) => {
        const id = `d${diagnostics.length + 1}`,
          actionId = `a${actions.length + 1}`;
        const code =
          cause === "invalid_root"
            ? "correct_context"
            : cause === "not_configured"
              ? "configure_client"
              : cause === "transport_failure" || cause === "service_unavailable"
                ? "recover_service"
                : "inspect_native";
        actions.push({
          id: actionId,
          code,
          target: known(args.path),
          scope: { kind: "call" },
          condition:
            code === "correct_context"
              ? "If the requested root is incorrect"
              : code === "recover_service"
                ? "Only after service recovery is observed"
                : "If the range decision remains open",
          instruction:
            code === "correct_context"
              ? "Use the exact registered worktree top-level; no fallback was performed."
              : code === "configure_client"
                ? "Configure the Jev client or inspect the file natively."
                : "Read or search the cited file within existing permissions; revisit Jev only with decisive new evidence or materially changed context.",
          repeatUnchanged: false,
        });
        diagnostics.push({
          id,
          cause,
          fact,
          target: known(
            cause === "invalid_root" ? (args.root ?? cwd) : args.path,
          ),
          origin:
            cause === "invalid_root" || cause === "forbidden_path"
              ? "input"
              : cause === "control_failure"
                ? "control"
                : cause === "session_budget"
                  ? "budget"
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
        const usage = results.reduce(
          (sum, result) => ({
            inputTokens: sum.inputTokens + (result.usage?.inputTokens ?? 0),
            costUsd: sum.costUsd + (result.usage?.costUsd ?? 0),
          }),
          { inputTokens: 0, costUsd: 0 },
        );
        const metrics = {
          calls: 0,
          questions: 0,
          cacheHits: 0,
          cacheRequests: 0,
        };
        for (const result of results) {
          metrics.calls += result.calls ?? 0;
          metrics.questions += result.questions ?? 0;
          metrics.cacheHits += result.cacheHits ?? 0;
          metrics.cacheRequests += result.cacheRequests ?? 0;
        }
        const envelope = buildEnvelope({
          ...input,
          limitations: [...limitations, ...(input.limitations ?? [])],
          yield: {
            ...metrics,
            costUsd: usage.costUsd,
            elapsedMs: performance.now() - started,
          },
        });
        if (input.refusal) diagnose(failureCause, input.refusal);
        if (input.answers?.[0] && primary?.source)
          actions.push({
            id: `a${actions.length + 1}`,
            code: "inspect_native",
            target: known(
              input.answers[0].label === "none"
                ? args.path
                : input.answers[0].label,
            ),
            scope: { kind: "group", groupIds: ["pointer"] },
            condition: "If the range decision remains open",
            instruction:
              input.answers[0].label === "none"
                ? "Search elsewhere for the goal; read any cited alternative range if the result is unsure. Do not retry unchanged evidence."
                : "Read the current primary and alternative ranges; retain uncertainty if no decisive new evidence is available. Do not retry unchanged evidence.",
            repeatUnchanged: false,
          });
        if (
          !input.refusal &&
          (!primary?.source || (requiredControl && !control?.source))
        )
          diagnose(
            "invalid_response",
            "pointer decision lacks established answer provenance or its required control",
          );
        const common = {
          id: "pointer",
          kind: "pointer" as const,
          label: args.path,
          groupId: "pointer",
          evidence: primary
            ? [
                {
                  target: args.path,
                  canonicalPath: evidenceContext.effectiveRoot
                    ? known(
                        `${evidenceContext.effectiveRoot.path}/${args.path}`,
                      )
                    : unknown("file admission not established"),
                  aliases: [],
                  side: "current" as const,
                  revision: context.resolvedBase,
                },
              ]
            : [],
          diagnosticIds: diagnostics.map((d) => d.id),
          actionIds: actions.map((a) => a.id),
        };
        if (input.answers?.[0]) common.label = input.answers[0].label;
        const displayed = input.answers?.[0];
        let item: Item = { ...common, treatment: "not_judged", source: "none" };
        if (
          displayed &&
          primary?.type === "choice" &&
          primary.source &&
          (!requiredControl || (control?.type === "choice" && control.source))
        ) {
          auxiliary.passages[primary.source]--;
          item = answerItemFromInput(common, {
            ...displayed,
            answer: primary,
            publicResult: displayed.value?.head ?? primary.choice,
            reason: [...limitations, ...(input.limitations ?? [])]
              .map((limit) => limit.fact)
              .join("; "),
            rawValues: raw(primary),
            reportControls:
              control?.type === "choice" && control.source
                ? [
                    {
                      id: "pointer-order",
                      kind: "order",
                      source: control.source,
                      outcome: displayed.orderDependent
                        ? "order-dependent"
                        : "consistent",
                      rawValues: raw(control),
                    },
                  ]
                : [],
          });
        }
        const report = buildResultReport({
          tool: "jev_locate_in_file",
          context,
          items: [item],
          diagnostics,
          actions,
          metrics: {
            ...metrics,
            costUsd: results.every((r) => !r.calls || r.usage !== undefined)
              ? usage.costUsd
              : undefined,
            elapsedMs: performance.now() - started,
          },
          auxiliary,
          total: known(1),
          refused: Boolean(
            input.refusal &&
              (failureCause === "invalid_root" ||
                failureCause === "forbidden_path" ||
                failureCause === "outside_inventory" ||
                failureCause === "group_too_large" ||
                failureCause === "evidence_too_large"),
          ),
        });
        runtime.session.record(envelope);
        runtime.guide.deliver(ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: renderResultReport(report, {
                details: {
                  lines: [
                    ...envelope.lines,
                    {
                      type: "list" as const,
                      title: "pointer reservations",
                      items: [...limitations, ...(input.limitations ?? [])].map(
                        (limit) => limit.fact,
                      ),
                    },
                    ...(displayed
                      ? [
                          {
                            type: "list" as const,
                            title: "read ranges",
                            items: [
                              ...(displayed.label === "none"
                                ? []
                                : [displayed.label]),
                              ...(displayed.candidates ?? [])
                                .filter(
                                  (candidate) => candidate.label !== "none",
                                )
                                .map(
                                  (candidate) =>
                                    `${candidate.label} (${candidate.value.p})`,
                                ),
                            ],
                          },
                        ]
                      : []),
                  ],
                },
              }),
            },
          ],
          details: { results, evidenceContext, result: report },
          ...hostUsage(
            host.isOmp,
            results.some((r) => r.usage) ? usage : undefined,
          ),
        };
      };
      if (!evidence.ok) {
        failureCause = evidence.cause ?? "invalid_root";
        return finish({ refusal: evidence.error });
      }
      failureCause = "file_unavailable";
      const file = await readLocateFile(cwd, args.path, signal, exec);
      if (!file.ok) {
        failureCause = file.cause ?? "file_unavailable";
        return finish({ refusal: file.error });
      }
      failureCause = "outside_inventory";
      if (file.bytes < LOCATE_MIN_KB * 1000)
        return finish({
          refusal: `small file (${file.lines} lines): read it directly`,
        });
      if (!client) {
        failureCause = "not_configured";
        return finish({ refusal: NOT_CONFIGURED });
      }
      let sections: Section[];
      if (file.kind === "whole") {
        const parser = await loadParser();
        const declarations = parser?.supports(args.path)
          ? parser.declarations(args.path, file.text, {
              descendAbove: LOCATE_SECTION_MAX_LINES,
            })
          : undefined;
        if (args.path.endsWith(".py") && !parser?.supports(args.path))
          limitations.push({
            fact: "Python: unsupported language (plugin missing), heuristic sections",
            next: "install @ast-grep/lang-python",
          });
        for (const limit of declarations?.limits ?? [])
          limitations.push({
            fact:
              limit.kind === "parse_failed"
                ? "syntax parse failed: heuristic sections"
                : `parse_partial: ${args.path}${limit.declaration ? `: ${limit.declaration}` : ""}`,
            next:
              limit.kind === "parse_failed"
                ? "read the selected range directly"
                : "read the complete source and check its syntax",
          });
        sections = sectionFile(
          args.path,
          file.text,
          declarations?.limits.some((limit) => limit.kind === "parse_failed")
            ? undefined
            : declarations?.declarations,
        ).sections;
      } else {
        sections = file.windows.map((window, index) => ({
          id: `S${index + 1}`,
          ...window,
        }));
        limitations.push({
          fact: "large file: window outline, not declarations",
          next: "read the selected range directly",
        });
      }
      const sectionCount = sections.length;
      context.inventories.push({
        id: "sections",
        kind: "sections",
        rules: [
          file.kind === "whole"
            ? "declarations or heuristic sections from complete file"
            : "bounded window outline",
        ],
        restrictions: [
          args.path,
          ...sections.map(
            (section) => `${section.id}: ${section.start}-${section.end}`,
          ),
        ],
        discovered: known(sectionCount),
        considered: known(sectionCount),
        scopeRestricted: true,
        criteria: [],
      });
      if (!sectionCount) {
        diagnose(
          "collection_empty",
          "no sections discovered; no pointer judgment",
        );
        return finish({});
      }
      failureCause = "group_too_large";
      const judge = async (candidates: Section[], outline = false) => {
        primary = undefined;
        control = undefined;
        requiredControl = false;
        const inventory = context.inventories.find(
          (inventory) => inventory.id === "pointer-candidates",
        );
        const restricted = {
          id: "pointer-candidates",
          kind: "sections" as const,
          rules: ["actual candidates for the latest pointer stage"],
          restrictions: [
            args.path,
            ...candidates.map(
              (section) => `${section.id}: ${section.start}-${section.end}`,
            ),
          ],
          discovered: known(candidates.length),
          considered: known(candidates.length),
          scopeRestricted: true,
          criteria: [],
        };
        if (inventory) Object.assign(inventory, restricted);
        else context.inventories.push(restricted);
        const state = withEvidenceContext(
          sectionState(args.path, args.goal, candidates, outline),
          evidenceContext,
        );
        if (JSON.stringify(state).length > STATE_MAX_CHARS)
          return {
            ok: false as const,
            error: `required evidence exceeds STATE_MAX_CHARS=${STATE_MAX_CHARS}`,
          };
        const ask = async (reverse: boolean) => {
          const result = await client.judge(
            state,
            {
              pointer: pointerQuestion({
                instructions: `Which section serves this goal: ${args.goal}? Choose none if no section fits. Judge the supplied text, not the label alone.`,
                noneLabel: "No section serves the goal",
                candidates,
                reverse,
              }),
            },
            {
              signal,
              ...runtime.session.requestGate(),
              beforeRequest: (n) => runtime.session.admit(n),
              admissionCause: () => "session_budget",
              onUsage: (usage) => runtime.session.recordUsage(usage),
            },
          );
          results.push(result);
          if (!result.ok) {
            failureCause = result.failureCause ?? "invalid_response";
            if (reverse) auxiliary.controls.notJudged++;
            else auxiliary.passages.notJudged++;
          }
          if (!result.ok) return { ok: false as const, error: result.error };
          const answer = result.answers.pointer;
          if (reverse) control = answer;
          else primary = answer;
          if (answer?.type === "unjudged")
            failureCause = answer.cause ?? "invalid_response";
          if (answer?.type === "choice" && answer.source) {
            if (reverse) auxiliary.controls[answer.source]++;
            else auxiliary.passages[answer.source]++;
          } else if (reverse) auxiliary.controls.notJudged++;
          else auxiliary.passages.notJudged++;
          return answer?.type === "choice"
            ? { ok: true as const, probabilities: answer.probabilities }
            : {
                ok: false as const,
                error:
                  answer?.type === "unjudged"
                    ? answer.reason
                    : "Pointer answer missing.",
              };
        };
        const first = await ask(false);
        if (!first.ok) return first;
        let pointer = readPointer(first.probabilities);
        if (needsReverse(first.probabilities, candidates.length)) {
          requiredControl = true;
          const second = await ask(true);
          if (!second.ok) {
            if (failureCause === "invalid_response")
              failureCause = "control_failure";
            return second;
          }
          pointer = readPointer(first.probabilities, second.probabilities);
        }
        return { ok: true as const, ...pointer };
      };
      const emptyState = sectionState(args.path, args.goal, []);
      const contextChars =
        JSON.stringify(withEvidenceContext(emptyState, evidenceContext))
          .length - JSON.stringify(emptyState).length;
      const evidenceMaxChars = STATE_MAX_CHARS - contextChars;
      const fits = (candidates: Section[]) =>
        sectionStateFits(
          args.path,
          args.goal,
          candidates,
          false,
          evidenceMaxChars,
        );
      const twoStage = file.kind === "outline" || !fits(sections);
      let planUnsure = false;
      if (twoStage) {
        const outline = sectionOutline(
          args.path,
          args.goal,
          sections,
          evidenceMaxChars,
        );
        if (outline.length < 2 || outline.length >= CHOICE_MAX_OPTIONS)
          return finish({
            refusal:
              "No usable multi-section plan fits the budget; use grep or read directly.",
          });
        const evidence = outlineEvidence(
          args.path,
          args.goal,
          outline,
          evidenceMaxChars,
        );
        if (!fits(evidence))
          return finish({
            refusal: "Block plan exceeds the state budget; use grep.",
          });
        if (outline.length < sections.length)
          limitations.push({
            fact: "adjacent sections grouped; a class may span outline blocks",
            next: "read neighboring blocks when needed",
          });
        const plan = await judge(evidence);
        if (!plan.ok) return finish({ refusal: plan.error });
        const head = plan.ranked[0];
        if (!head) return finish({ refusal: "Pointer probabilities missing." });
        if (head.id === "none") {
          const display = locateDisplay(args.path, outline, plan.ranked, false);
          if (!display)
            return finish({ refusal: "Pointer probabilities missing." });
          return finish({
            answers: [
              {
                ...display.primary,
                band: display.band,
                candidates: display.candidates,
                orderDependent: plan.orderDependent,
              },
            ],
            limitations: [
              {
                fact: "no block serves the goal",
                next:
                  display.band === "unsure"
                    ? "read the alternative block or search elsewhere"
                    : "search elsewhere",
              },
            ],
          });
        }
        const block = outline.find((s) => s.id === head.id);
        if (!block)
          return finish({ refusal: "Pointer named an unknown block." });
        planUnsure = head.p < LOCATE_VERDICT_MIN;
        if (planUnsure) {
          const alternative = outline.find((s) => s.id === plan.ranked[1]?.id);
          limitations.push({
            fact: `plan unsure: refined only the top block; also consider ${alternative ? `${args.path}:${alternative.start}-${alternative.end}` : "none"}`,
            next: "read the other block if needed",
          });
        }
        if (file.kind === "outline") {
          const selected = await scanRange(cwd, args.path, block, signal, exec);
          if (!selected.ok) {
            failureCause = selected.cause ?? "file_unavailable";
            return finish({ refusal: selected.error });
          }
          const lines = selected.text.split("\n");
          sections = sections
            .filter((s) => s.start >= block.start && s.end <= block.end)
            .map((section) => ({
              ...section,
              label: `lines ${section.start}-${section.end}`,
              text: lines
                .slice(
                  section.start - block.start,
                  section.end - block.start + 1,
                )
                .join("\n"),
            }));
        } else
          sections = sections.filter(
            (s) => s.start >= block.start && s.end <= block.end,
          );
        if (sections.length < 2)
          return finish({
            refusal:
              "Selected block has fewer than two sections; use grep or read directly.",
          });
      }
      if (!fits(sections))
        return finish({
          refusal: `Selected block exceeds ${STATE_MAX_CHARS} chars or the choice limit; read ${args.path}:${sections[0]?.start}-${sections.at(-1)?.end} directly.`,
        });
      let pointer = await judge(sections);
      if (!pointer.ok) return finish({ refusal: pointer.error });
      let shrunk = false;
      if ((pointer.ranked[0]?.p ?? 0) < LOCATE_GRAY_MIN) {
        const ids = pointer.ranked
          .filter((s) => s.id !== "none")
          .slice(0, LOCATE_SHRINK_TOP)
          .map((s) => s.id);
        sections = ids.flatMap((id) => sections.filter((s) => s.id === id));
        pointer = await judge(sections);
        if (!pointer.ok) return finish({ refusal: pointer.error });
        shrunk = true;
        if (twoStage)
          limitations.push({
            fact: "two-stage pointer: shrinking re-ask not measured for outlines",
            next: "read the selected evidence",
          });
        limitations.push({
          fact: "pointer below gray threshold: narrowed to top three plus none",
          next: "read both candidates or search elsewhere",
        });
      }
      const head = pointer.ranked[0];
      if (!head) return finish({ refusal: "Pointer probabilities missing." });
      const displayed = locateDisplay(
        args.path,
        sections,
        pointer.ranked,
        shrunk || planUnsure,
      );
      if (!displayed)
        return finish({ refusal: "Pointer probabilities missing." });
      const { primary: displayedPrimary, band, candidates } = displayed;
      if (band === "unsure" || head.id === "none")
        limitations.push({
          fact:
            head.id === "none"
              ? "no section fits"
              : "two sections share the mass",
          next: head.id === "none" ? "search elsewhere" : "read both",
        });
      return finish({
        answers: [
          {
            ...displayedPrimary,
            band,
            orderDependent: pointer.orderDependent,
            candidates,
          },
        ],
        lines:
          head.id !== "none"
            ? [{ type: "list", title: "read", items: [displayedPrimary.label] }]
            : [],
        limitations: [
          {
            fact: `${file.lines} lines, ${sectionCount} sections`,
            next: "open the cited line range",
          },
        ],
      });
    },
  } satisfies ToolDefinition<typeof parameters>;
}
