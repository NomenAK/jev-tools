import type { EvidenceContext } from "../adapters/evidence-context.ts";
import type { AnswerInput, Envelope, Yield } from "../core/output.ts";
import {
  type Action,
  answerItemFromInput,
  buildResultReport,
  type Cause,
  contextFromEvidence,
  type Diagnostic,
  type Inventory,
  type Item,
  type ItemCommon,
  known,
  type ResultReportV1,
  unknown,
} from "../core/result-report.ts";
import type { Answer, Judgment } from "../jev/types.ts";

export function reportMetrics(envelope: Envelope): Yield {
  const line = envelope.lines.find((line) => line.type === "yield");
  if (line?.type !== "yield")
    throw new Error("Report metrics missing from envelope");
  return line.value;
}

export function controlsFor(
  id: string,
  judgment: Judgment,
  witnessIds: readonly string[],
): Answer[] {
  const batches = judgment.batches?.filter((batch) =>
    batch.questionIds.includes(id),
  );
  const responses = batches?.length
    ? batches.map((batch) => batch.answers)
    : [judgment.ok ? judgment.answers : {}];
  return responses.flatMap((answers) =>
    witnessIds.map(
      (witnessId) =>
        answers[witnessId] ?? {
          type: "unjudged" as const,
          reason: "Required witness response unavailable",
        },
    ),
  );
}

/** Producer-owned inventory: register before admission, retain negative answers too. */
export class ReviewReport {
  readonly items = new Map<string, Item>();
  readonly diagnostics: Diagnostic[] = [];
  readonly actions: Action[] = [];
  readonly inventories: Inventory[] = [];
  readonly auxiliary = {
    controls: { fresh: 0, cache: 0, notJudged: 0, static: 0 },
    passages: { fresh: 0, cache: 0, notJudged: 0 },
  };
  refusal = false;
  missingWork = false;
  totalUnknown = false;
  countControls(judgment: Judgment, ids: readonly string[]): void {
    const batches = judgment.batches ?? [
      { answers: judgment.ok ? judgment.answers : {}, questionIds: ids },
    ];
    for (const batch of batches)
      for (const id of ids) {
        if (!batch.questionIds.includes(id) && judgment.batches) continue;
        const answer = batch.answers[id];
        this.auxiliary.controls[
          answer && answer.type !== "unjudged" && answer.source
            ? answer.source
            : "notJudged"
        ]++;
      }
  }

  expect(
    id: string,
    label: string,
    kind: ItemCommon["kind"],
    groupId = id,
  ): void {
    if (!this.items.has(id))
      this.items.set(id, {
        id,
        label,
        kind,
        groupId,
        evidence: [],
        diagnosticIds: [],
        actionIds: [],
        treatment: "not_judged",
        source: "none",
      });
  }
  diagnose(
    cause: Cause,
    fact: string,
    target?: string,
    itemIds: string[] = [],
    blocking = true,
    omittedMembers: string[] = [],
  ): void {
    const id = `diagnostic:${this.diagnostics.length}`;
    const actionId = `action:${this.actions.length}`;
    const scope = itemIds.length
      ? { kind: "item" as const, itemIds }
      : { kind: "call" as const };
    const code =
      cause === "invalid_root" || cause === "invalid_base"
        ? "correct_context"
        : cause === "not_configured"
          ? "configure_client"
          : cause === "service_unavailable" || cause === "transport_failure"
            ? "recover_service"
            : "inspect_native";
    this.actions.push({
      id: actionId,
      code,
      target:
        target === undefined
          ? unknown("target not established")
          : known(target),
      scope,
      condition:
        "Only after the named context, evidence, or service condition materially changes; otherwise use native inspection or the retained runner plan.",
      instruction:
        code === "correct_context"
          ? "Correct the named repository root or base if it does not match the intended comparison."
          : code === "configure_client"
            ? "Configure the required Jev endpoint before requesting judgment; use native inspection meanwhile."
            : code === "recover_service"
              ? "Establish service recovery before another useful judgment request; do not repeat the unchanged call."
              : "Inspect the named evidence natively or execute the retained runner plan; preserve this limitation.",
      repeatUnchanged: false,
    });
    this.diagnostics.push({
      id,
      cause,
      fact,
      target:
        target === undefined
          ? unknown("target not established")
          : known(target),
      origin:
        cause === "control_failure"
          ? "control"
          : cause === "call_budget" || cause === "session_budget"
            ? "budget"
            : cause === "not_configured" ||
                cause === "service_unavailable" ||
                cause === "transport_failure" ||
                cause === "invalid_response" ||
                cause === "provider_context_refusal"
              ? "provider"
              : "collection",
      scope,
      effect: blocking ? "blocking" : "reservation",
      material: true,
      omittedMembers,
      memberCount: known(omittedMembers.length),
      actionIds: [actionId],
    });
    for (const itemId of itemIds) {
      const item = this.items.get(itemId);
      if (item) {
        item.diagnosticIds.push(id);
        item.actionIds.push(actionId);
      }
    }
  }
  static(id: string, reason: string, selected?: boolean): void {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unregistered review result ${id}`);
    this.items.set(id, {
      ...item,
      treatment: "static",
      source: "none",
      staticReason: reason,
      ...(selected === undefined ? {} : { selection: { selected, reason } }),
    });
  }
  answer(
    id: string,
    answer: Answer | undefined,
    input: Partial<AnswerInput> = {},
    controls: Answer[] = [],
    countControls = true,
  ): void {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unregistered review result ${id}`);
    const unavailable = !answer || answer.type === "unjudged" || !answer.source;
    const missingControl = controls.some(
      (control) => control.type === "unjudged" || !control.source,
    );
    if (countControls)
      for (const control of controls)
        this.auxiliary.controls[
          control.type === "unjudged" || !control.source
            ? "notJudged"
            : control.source
        ]++;
    if (unavailable || missingControl) {
      this.diagnose(
        missingControl
          ? "control_failure"
          : answer?.type === "unjudged"
            ? (answer.cause ?? "invalid_response")
            : "invalid_response",
        missingControl
          ? "Required control response is unavailable; the requested group has no admissible judgment."
          : answer?.type === "unjudged"
            ? answer.reason
            : "Requested answer or its transport provenance is unavailable.",
        item.label,
        [id],
      );
      return;
    }
    const valid = answer as Exclude<Answer, { type: "unjudged" }>;
    const rawValues =
      valid.type === "bool"
        ? [{ label: "true", value: true, probability: known(valid.p) }]
        : Object.entries(valid.probabilities).map(([label, p]) => ({
            label,
            value: label,
            probability: known(p),
          }));
    this.items.set(
      id,
      answerItemFromInput(item, {
        label: item.label,
        answer: valid,
        source: valid.source,
        band: "verdict",
        rawValues,
        ...input,
        reportControls: controls.map((control, index) => {
          const source = control.source;
          if (!source) throw new Error("Admitted control lacks provenance");
          return {
            id: `${id}:control:${index}`,
            kind: "integrity",
            source,
            outcome:
              control.type === "bool"
                ? String(control.p)
                : control.type === "choice"
                  ? control.choice
                  : control.type === "score"
                    ? String(control.score)
                    : control.reason,
            rawValues:
              control.type === "choice" || control.type === "score"
                ? Object.entries(control.probabilities).map(([label, p]) => ({
                    label,
                    value: label,
                    probability: known(p),
                  }))
                : control.type === "bool"
                  ? [
                      {
                        label: "true",
                        value: true,
                        probability: known(control.p),
                      },
                    ]
                  : [],
          };
        }),
      }),
    );
  }
  failure(judgment: Judgment, ids: string[], cause?: Cause): void {
    this.diagnose(
      cause ??
        (!judgment.ok ? judgment.cause : undefined) ??
        judgment.failureCause ??
        "invalid_response",
      judgment.ok ? "Required responses unavailable" : judgment.error,
      undefined,
      ids,
    );
  }
  build(
    tool: ResultReportV1["tool"],
    evidence: EvidenceContext,
    metrics: Yield,
  ): ResultReportV1 {
    const context = contextFromEvidence(evidence);
    context.inventories = this.inventories;
    return buildResultReport({
      tool,
      context,
      items: [...this.items.values()],
      diagnostics: this.diagnostics,
      actions: this.actions,
      metrics,
      auxiliary: this.auxiliary,
      total:
        this.totalUnknown || (!this.inventories.length && !this.items.size)
          ? unknown("Expected inventory was not completely enumerable")
          : known(this.items.size),
      refused: this.refusal,
      missingWork: this.missingWork,
    });
  }
}
