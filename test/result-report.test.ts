import assert from "node:assert/strict";
import test from "node:test";
import { compileAsks, readAsks } from "../src/core/asks.ts";
import { buildEnvelope } from "../src/core/output.ts";
import {
  answerItemFromInput,
  buildResultReport,
  contextFromEvidence,
  type Diagnostic,
  type Item,
  type ItemCommon,
  known,
  type ReportInput,
  resultIsError,
  uncollectedContext,
  unknown,
  validateResultReport,
} from "../src/core/result-report.ts";
import { createJevClient } from "../src/jev/client.ts";
import { renderResultReport } from "../src/render.ts";
import { isMcpStructuredResult, isResultReport } from "../src/report-schema.ts";

const common = (id: string): ItemCommon => ({
  id,
  kind: "claim",
  label: id,
  groupId: id,
  evidence: [],
  diagnosticIds: [],
  actionIds: [],
});
const auxiliary = {
  controls: { fresh: 0, cache: 0, notJudged: 0, static: 0 },
  passages: { fresh: 0, cache: 0, notJudged: 0 },
};
const metrics = {
  calls: 0,
  questions: 0,
  cacheHits: 0,
  cacheRequests: 0,
  elapsedMs: 0,
};
const diagnostic = (
  cause: Diagnostic["cause"],
  effect: Diagnostic["effect"] = "blocking",
): Diagnostic => ({
  id: cause,
  cause,
  fact: `observed ${cause}`,
  target: unknown("target not established"),
  origin: "collection",
  scope: { kind: "call" },
  effect,
  material: true,
  omittedMembers: [],
  memberCount: unknown("not enumerated"),
  actionIds: [],
});
const input = (items: Item[], diagnostics: Diagnostic[] = []): ReportInput => ({
  tool: "jev_ask",
  context: uncollectedContext({ authority: unknown("not established") }),
  items,
  diagnostics,
  actions: [],
  metrics,
  auxiliary,
  total: known(items.length),
});

test("closed report schema accepts all four item variants and explicit unknowns", () => {
  const fresh = answerItemFromInput(common("fresh"), {
    label: "fresh",
    answer: { type: "bool", p: 0.9, source: "fresh" },
  });
  const cache = answerItemFromInput(common("cache"), {
    label: "cache",
    answer: { type: "bool", p: 0.1, source: "cache" },
  });
  assert.equal(fresh.treatment, "judged");
  if (fresh.treatment !== "judged") return;
  const staticItem: Item = {
    ...common("static"),
    treatment: "static",
    source: "none",
    staticReason: "touched",
  };
  const missing: Item = {
    ...common("missing"),
    treatment: "not_judged",
    source: "none",
    selection: { selected: true, reason: "conservative_fallback" },
  };
  const report = buildResultReport(
    input([fresh, cache, staticItem, missing], [diagnostic("call_budget")]),
  );
  assert.equal(report.execution, "partial");
  assert.deepEqual(report.accounting.requestedResults, {
    total: known(4),
    fresh: 1,
    cache: 1,
    notJudged: 1,
    static: 1,
  });
  assert.equal(isMcpStructuredResult({ result: report }), true);
  assert.equal(isResultReport(report), true);
  assert.equal(
    isResultReport({
      ...report,
      accounting: {
        ...report.accounting,
        requestedResults: { ...report.accounting.requestedResults, fresh: 100 },
      },
    }),
    false,
  );
  assert.equal(
    isResultReport({
      ...report,
      items: report.items.map((i) => ({ ...i, diagnosticIds: ["unknown"] })),
    }),
    false,
  );
  for (const bad of [
    { ...missing, judgment: fresh.judgment },
    { ...staticItem, source: "cache" },
    { ...fresh, source: "none" },
    {
      ...fresh,
      judgment: {
        ...fresh.judgment,
        measure: { kind: "probability", value: known(1.1) },
      },
    },
  ]) {
    assert.equal(
      isMcpStructuredResult({ result: { ...report, items: [bad] } }),
      false,
    );
  }
  assert.equal(isMcpStructuredResult({ result: report, extra: true }), false);
  for (const key of ["__proto__", "constructor", "toString"]) {
    const wrapper = JSON.parse(JSON.stringify({ result: report }));
    Object.defineProperty(wrapper, key, { value: {}, enumerable: true });
    assert.equal(isMcpStructuredResult(wrapper), false);
    const nested = JSON.parse(JSON.stringify(report));
    Object.defineProperty(nested.context, key, { value: {}, enumerable: true });
    assert.equal(isResultReport(nested), false);
  }
});

test("execution priority preserves useful fallback and separates expected absence from failure", () => {
  const absent = {
    ...common("missing"),
    treatment: "not_judged",
    source: "none",
  } as const;
  const empty = buildResultReport(
    input([], [diagnostic("no_changed_units", "reservation")]),
  );
  assert.equal(empty.execution, "not_judged");
  assert.equal(resultIsError(empty), false);
  const failed = buildResultReport(
    input([absent], [diagnostic("service_unavailable")]),
  );
  assert.equal(resultIsError(failed), true);
  const fallback = buildResultReport(
    input(
      [
        {
          ...absent,
          selection: { selected: true, reason: "conservative_fallback" },
        },
      ],
      [diagnostic("service_unavailable")],
    ),
  );
  assert.equal(fallback.execution, "partial");
  assert.equal(resultIsError(fallback), false);
  const refused = buildResultReport({
    ...input([], [diagnostic("invalid_arguments")]),
    refused: true,
  });
  assert.equal(refused.execution, "refused");
  assert.equal(resultIsError(refused), true);
  const staticItem: Item = {
    ...common("touched"),
    treatment: "static",
    source: "none",
    staticReason: "touched",
  };
  assert.equal(
    buildResultReport(
      input([staticItem], [diagnostic("conservative_widening", "reservation")]),
    ).execution,
    "complete",
  );
  assert.equal(
    buildResultReport(
      input([staticItem], [diagnostic("criteria_no_match", "reservation")]),
    ).execution,
    "partial",
  );
});

test("unknown total and cost remain unknown and semantic references/counts are enforced", () => {
  const item = answerItemFromInput(common("a"), {
    label: "a",
    answer: { type: "bool", p: 0.9, source: "cache" },
  });
  const report = buildResultReport({
    ...input([item]),
    total: unknown("inventory not enumerable"),
  });
  assert.equal(report.accounting.costUsd.status, "unknown");
  assert.equal(report.accounting.requestedResults.total.status, "unknown");
  assert.throws(
    () => buildResultReport({ ...input([item]), total: known(2) }),
    /total/,
  );
  assert.ok(report.items[0]);
  report.items[0].diagnosticIds.push("absent");
  assert.match(validateResultReport(report).join(";"), /unknown diagnostic/);
});

test("boolean result and leading probability are not provider confidence", () => {
  const bool = answerItemFromInput(common("bool"), {
    label: "bool",
    value: { head: "yes", p: 0.9 },
    answer: { type: "bool", p: 0.9, source: "fresh" },
  });
  assert.equal(bool.treatment, "judged");
  if (bool.treatment !== "judged") return;
  assert.equal(bool.judgment.result, true);
  const choice = answerItemFromInput(common("choice"), {
    label: "choice",
    answer: {
      type: "choice",
      choice: "a",
      confidence: 0.99,
      probabilities: { a: 0.6, b: 0.4 },
      source: "fresh",
    },
  });
  assert.equal(choice.treatment, "judged");
  if (choice.treatment !== "judged") return;
  assert.deepEqual(choice.judgment.measure, {
    kind: "probability",
    value: known(0.6),
  });
  assert.equal(choice.judgment.band, "unsure");
  assert.throws(
    () =>
      answerItemFromInput(common("unknown"), {
        label: "unknown",
        answer: { type: "bool", p: 0.9 },
      }),
    /source not established/,
  );
});

test("missing required control yields unjudged without synthetic probability", () => {
  const plan = compileAsks(
    [{ intent: "verify", claims: { exact: "The claim holds" } }],
    { surface: "ask" },
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const answers = readAsks(plan, {});
  assert.equal(answers[0]?.unjudged, true);
  assert.equal(answers[0]?.value, undefined);
  const envelope = buildEnvelope({ answers, yield: metrics });
  assert.equal(envelope.lines[0]?.type, "unjudged");
});

test("projection shows material diagnostics, exclusions, command effects and precise metric units", () => {
  const item: Item = {
    ...common("touched"),
    treatment: "static",
    source: "none",
    staticReason: "touched",
  };
  const report = buildResultReport(
    input([item], [diagnostic("unsupported_syntax", "reservation")]),
  );
  report.context.command = {
    execution: "finished",
    cwd: known("/repo"),
    exitCode: known(null),
    timedOut: known(true),
  };
  const text = renderResultReport(report);
  assert.match(text, /^complete — static selection; no Jev judgment/);
  assert.match(text, /material reservation.*unsupported_syntax/);
  assert.match(text, /command: finished.*exit null.*timedOut true/);
  assert.match(
    text,
    /HTTP attempts 0.*questions sent 0.*cache probes 0\/0.*current cost USD unknown/,
  );
  assert.equal(
    contextFromEvidence({
      authority: { path: "", origin: "server" },
      authorityReason: "realpath failed",
    }).authority.status,
    "unknown",
  );
});

test("real client preserves per-answer source in a mixed cache/fresh batch and cached controls", async () => {
  const client = createJevClient(
    { url: "http://simulated", apiKey: "secret", model: "model" },
    {
      fetch: async (_url, options) => {
        assert.ok(options);
        const body = JSON.parse(options.body as string) as {
          questions: Record<string, unknown>;
        };
        return Response.json({
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id) => [id, { noul: 0.9 }]),
          ),
        });
      },
    },
  );
  const q = { type: "bool" as const, instructions: "a" };
  const first = await client.judge(
    { text: "state" },
    { a: q, witness: { ...q, instructions: "control" } },
    { groups: [["a"]], witnesses: ["witness"] },
  );
  assert.equal(first.ok, true);
  const second = await client.judge(
    { text: "state" },
    {
      a: q,
      b: { ...q, instructions: "b" },
      witness: { ...q, instructions: "control" },
    },
    { groups: [["a"], ["b"]], witnesses: ["witness"] },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.answers.a?.source, "cache");
  assert.equal(second.answers.b?.source, "fresh");
  assert.equal(second.answers.witness?.source, "cache");
  assert.ok(
    second.batches?.some((batch) => batch.answers.witness?.source === "fresh"),
  );
});
