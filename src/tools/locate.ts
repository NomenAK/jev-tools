import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { canonicalPath } from "../adapters/canonical-path.ts";
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
import { type Section, sectionFile } from "../core/sections.ts";
import type { SyntaxParser } from "../core/units.ts";
import { interpolate } from "../describe.ts";
import type { GuideContext } from "../guide.ts";
import type { Judgment } from "../jev/types.ts";
import { renderEnvelope } from "../render.ts";
import type { ToolDependencies } from "../runtime.ts";
import { NOT_CONFIGURED } from "../texts/configuration.ts";
import { LOCATE_DESCRIPTION } from "../texts/locate.ts";

const parameters = Type.Object(
  { path: Type.String({ minLength: 1 }), goal: Type.String({ minLength: 1 }) },
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
      const cwd = await canonicalPath(ctx.cwd);
      const started = performance.now();
      const exec = shareGitInventory(execute);
      const results: Judgment[] = [];
      const limitations: Limitation[] = [];
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
        runtime.session.record(envelope);
        runtime.guide.deliver(ctx);
        return {
          content: [{ type: "text" as const, text: renderEnvelope(envelope) }],
          details: { results },
          ...hostUsage(
            host.isOmp,
            results.some((r) => r.usage) ? usage : undefined,
          ),
        };
      };
      const file = await readLocateFile(cwd, args.path, signal, exec);
      if (!file.ok) return finish({ refusal: file.error });
      if (file.bytes < LOCATE_MIN_KB * 1000)
        return finish({
          refusal: `small file (${file.lines} lines): read it directly`,
        });
      if (!client) return finish({ refusal: NOT_CONFIGURED });
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
      const judge = async (candidates: Section[], outline = false) => {
        const state = sectionState(args.path, args.goal, candidates, outline);
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
              onUsage: (usage) => runtime.session.recordUsage(usage),
            },
          );
          results.push(result);
          if (!result.ok) return { ok: false as const, error: result.error };
          const answer = result.answers.pointer;
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
          const second = await ask(true);
          if (!second.ok) return second;
          pointer = readPointer(first.probabilities, second.probabilities);
        }
        return { ok: true as const, ...pointer };
      };
      const fits = (candidates: Section[]) =>
        sectionStateFits(args.path, args.goal, candidates);
      const twoStage = file.kind === "outline" || !fits(sections);
      let planUnsure = false;
      if (twoStage) {
        const outline = sectionOutline(args.path, args.goal, sections);
        if (outline.length < 2 || outline.length >= CHOICE_MAX_OPTIONS)
          return finish({
            refusal:
              "No usable multi-section plan fits the budget; use grep or read directly.",
          });
        const evidence = outlineEvidence(args.path, args.goal, outline);
        if (!sectionStateFits(args.path, args.goal, evidence))
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
          if (!selected.ok) return finish({ refusal: selected.error });
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
      const { primary, band, candidates } = displayed;
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
            ...primary,
            band,
            orderDependent: pointer.orderDependent,
            candidates,
          },
        ],
        lines:
          head.id !== "none"
            ? [{ type: "list", title: "read", items: [primary.label] }]
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
