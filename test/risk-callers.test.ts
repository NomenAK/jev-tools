import assert from "node:assert/strict";
import test from "node:test";
import { loadCallerParser } from "../src/adapters/risk-callers.ts";
import {
  type CallerSource,
  prepareRiskCallers,
} from "../src/core/risk-callers.ts";
import type { EvidenceUnit } from "../src/core/units.ts";

const unit = (
  before: string,
  after: string,
  file = "src/dispatch.ts",
): EvidenceUnit => ({
  id: "u001",
  kind: "function",
  file,
  name: "deliver",
  exported: true,
  before,
  after,
  beforeRange: { start: 1, end: 1 },
  afterRange: { start: 1, end: 1 },
});
const old = "export function deliver(client) { return client.get(); }";
const next = "export function deliver(client) { return client.fetch(); }";
const sources = (
  caller = "import { deliver } from './dispatch';\nconst provider = { get() { return 1; } };\nexport function run() { return deliver(provider); }",
): CallerSource[] => [
  { path: "src/dispatch.ts", before: old, after: next },
  { path: "src/caller.ts", before: caller, after: caller },
];
test("wrapped arrow targets retain the enclosing declarator identity", async () => {
  const parser = await loadCallerParser();
  for (const before of [
    "export const deliver = cond ? (client) => client.get() : (client) => client.get();",
    "export const deliver = ((client) => client.get()).bind(client.get);",
  ]) {
    const after = before.replace("client.get()", "client.fetch()");
    const result = prepareRiskCallers(
      [unit(before, after)],
      [{ path: "src/dispatch.ts", before, after }],
      parser,
    );
    assert.deepEqual(result.proofs, []);
    assert.ok(
      result.limits.some(
        (limit) =>
          limit.kind === "caller_missing" &&
          limit.missing === "statically bound local caller",
      ),
      before,
    );
  }
});
test("anonymous callers keep their named identity when preceding lines move", async () => {
  const parser = await loadCallerParser();
  for (const declaration of [
    "export const run = memo(() => deliver(provider));",
    "export const run = [1].map(() => deliver(provider));",
    "export const run = (() => deliver(provider));",
    "export const run = (() => deliver(provider)) as () => number;",
  ]) {
    const before = `import { deliver } from './dispatch';\nconst provider = { get() { return 1; } };\n${declaration}`;
    const inputs = sources(before);
    inputs[1] = { path: "src/caller.ts", before, after: `// moved\n${before}` };
    const result = prepareRiskCallers([unit(old, next)], inputs, parser);
    assert.equal(result.proofs.length, 1, declaration);
    assert.deepEqual(result.limits, [], declaration);
    assert.match(JSON.stringify(result.proofs[0]?.state), /get\(\)/);
  }
});
test("inserting another anonymous caller never substitutes its provider", async () => {
  const parser = await loadCallerParser();
  const head =
    "import { deliver } from './dispatch';\nconst bad = { get() { return 1; } };\nconst good = { get() { return 1; }, fetch() { return 2; } };\n";
  const before = `${head}export const r1 = [1].map(() => deliver(bad));`;
  const after = `${head}export const r0 = [1].map(() => deliver(good));\nexport const r1 = [1].map(() => deliver(bad));`;
  const inputs = sources(before);
  inputs[1] = { path: "src/caller.ts", before, after };
  const result = prepareRiskCallers([unit(old, next)], inputs, parser);
  assert.equal(result.proofs.length, 1);
  const evidence = result.proofs[0]?.state.callerEvidence;
  assert.ok(
    evidence && typeof evidence === "object" && !Array.isArray(evidence),
  );
  assert.match(JSON.stringify(evidence.caller), /r1/);
  assert.doesNotMatch(JSON.stringify(evidence.caller), /r0/);
  assert.match(JSON.stringify(evidence.provider), /const bad/);
  assert.doesNotMatch(JSON.stringify(evidence.provider), /const good/);
});
test("calls inside invalid functions never supply caller or shadowed provider evidence", async () => {
  const parser = await loadCallerParser();
  for (const declaration of [
    "export function run() { const x = ; return [1].map(() => deliver(provider)); }",
    "export function run() { const x = ; return deliver(provider); }",
    "export function run(provider) { const x = ; return [1].map(() => deliver(provider)); }",
  ]) {
    const caller = `import { deliver } from './dispatch';\nconst provider = { get() { return 1; }, fetch() { return 2; } };\n${declaration}`;
    const result = prepareRiskCallers(
      [unit(old, next)],
      sources(caller),
      parser,
    );
    assert.deepEqual(result.proofs, [], declaration);
    assert.ok(
      result.limits.some(
        (limit) =>
          limit.kind === "caller_missing" &&
          limit.missing === "statically bound local caller",
      ),
      declaration,
    );
    assert.ok(result.limits.some((limit) => limit.kind === "parse_partial"));
    assert.ok(
      !result.limits.some(
        (limit) =>
          limit.kind === "caller_missing" &&
          limit.missing === "complete after caller",
      ),
    );
  }
});

test("a concrete unchanged provider and caller accompany the changed unit", async () => {
  const parser = await loadCallerParser();
  assert.ok(parser);
  const result = prepareRiskCallers([unit(old, next)], sources(), parser);
  assert.equal(result.proofs.length, 1);
  assert.match(JSON.stringify(result.proofs[0]?.state), /get\(\)/);
  assert.match(JSON.stringify(result.proofs[0]?.state), /deliver\(provider\)/);
  assert.equal(result.limits.length, 0);
});
test("an incomplete hunk uses admitted source syntax and retains cut evidence limits", async () => {
  const parser = await loadCallerParser();
  const before = "export function deliver(client) {\n  return client.get();\n}";
  const after = before.replace("get", "fetch");
  const changed = {
    ...unit("  return client.get();\n}", "  return client.fetch();\n}"),
    kind: "hunk" as const,
    name: "lines 2-3",
    beforeRange: { start: 2, end: 3 },
    afterRange: { start: 2, end: 3 },
  };
  const result = prepareRiskCallers(
    [changed],
    [{ path: changed.file, before, after }],
    parser,
  );
  assert.equal(result.proofs.length, 0);
  assert.ok(result.limits.some((limit) => limit.kind === "piece_cut"));
  assert.ok(!result.limits.some((limit) => limit.kind === "parse_partial"));
});
test("non-callable slices locate complete constant declarations by name and range", async () => {
  const parser = await loadCallerParser();
  const before = "const config = {\n  value: client.get(),\n};";
  const after = before.replace("get", "fetch");
  const changed = {
    ...unit(
      "const config = {\n// omitted\n}",
      "const config = {\n// omitted\n}",
    ),
    kind: "slice" as const,
    name: "config",
    beforeRange: { start: 1, end: 3 },
    afterRange: { start: 1, end: 3 },
  };
  const result = prepareRiskCallers(
    [changed],
    [{ path: changed.file, before, after }],
    parser,
  );
  assert.deepEqual(result.proofs, []);
  assert.ok(result.limits.some((limit) => limit.kind === "piece_cut"));
  assert.ok(!result.limits.some((limit) => limit.kind === "parse_partial"));
});

test("a genuinely malformed source interval keeps its parse limitation", async () => {
  const parser = await loadCallerParser();
  const before =
    "function deliver(client) {\n const value = ; return client.get();\n}";
  const after = before.replace("get", "fetch");
  const changed = {
    ...unit(
      "const value = ; return client.get();",
      "const value = ; return client.fetch();",
    ),
    kind: "hunk" as const,
    name: "lines 2-2",
    beforeRange: { start: 2, end: 2 },
    afterRange: { start: 2, end: 2 },
  };
  const result = prepareRiskCallers(
    [changed],
    [{ path: changed.file, before, after }],
    parser,
  );
  assert.deepEqual(result.proofs, []);
  assert.ok(result.limits.some((limit) => limit.kind === "parse_partial"));
});
test("cut pieces retain errors elsewhere in their enclosing function", async () => {
  const parser = await loadCallerParser();
  const before =
    "function deliver(client) {\n const x = ;\n const y = 1;\n return client.get();\n}";
  for (const kind of ["slice", "hunk"] as const) {
    const changed = {
      ...unit(" return client.get();", " return client.fetch();"),
      kind,
      name: kind === "hunk" ? "lines 4-4" : "deliver",
      beforeRange: { start: 4, end: 4 },
      afterRange: { start: 4, end: 4 },
    };
    const result = prepareRiskCallers(
      [changed],
      [{ path: changed.file, before, after: before.replace("get", "fetch") }],
      parser,
    );
    assert.deepEqual(result.proofs, []);
    assert.ok(
      result.limits.some((limit) => limit.kind === "parse_partial"),
      kind,
    );
  }
});
test("unlocated slices retain errors in their admitted source interval", async () => {
  const parser = await loadCallerParser();
  const before = "const unrelated = 1;\nconst broken = ;\nclient.get();";
  const after = before.replace("get", "fetch");
  const changed = {
    ...unit("const healthy = 1;", "const healthy = 2;"),
    kind: "slice" as const,
    name: "missing",
    beforeRange: { start: 2, end: 3 },
    afterRange: { start: 2, end: 3 },
  };
  const result = prepareRiskCallers(
    [changed],
    [{ path: changed.file, before, after }],
    parser,
  );
  assert.deepEqual(result.proofs, []);
  assert.ok(result.limits.some((limit) => limit.kind === "parse_partial"));
});
test("method pieces retain syntax errors in their enclosing class", async () => {
  const parser = await loadCallerParser();
  for (const [file, before, name] of [
    [
      "src/dispatch.ts",
      "class Svc {\n broken() { const x = ; }\n deliver(client) { return client.get(); }\n}",
      "Svc.deliver",
    ],
    [
      "src/dispatch.py",
      "class Svc:\n def broken(self):\n  x =\n def deliver(self, client):\n  return client.get()",
      "Svc.deliver",
    ],
  ] as const) {
    const start = file.endsWith(".py") ? 4 : 3;
    const end = file.endsWith(".py") ? 5 : 3;
    const changed = {
      ...unit(
        before
          .split("\n")
          .slice(start - 1, end)
          .join("\n"),
        before
          .split("\n")
          .slice(start - 1, end)
          .join("\n")
          .replace("get", "fetch"),
        file,
      ),
      name,
      kind: "slice" as const,
      beforeRange: { start, end },
      afterRange: { start, end },
    };
    const result = prepareRiskCallers(
      [changed],
      [{ path: file, before, after: before.replace("get", "fetch") }],
      parser,
    );
    assert.deepEqual(result.proofs, []);
    assert.ok(
      result.limits.some((limit) => limit.kind === "parse_partial"),
      file,
    );
  }
});
test("unlocated declarations never borrow member accesses from other declarations", async () => {
  const parser = await loadCallerParser();
  const before =
    "export class Svc { deliver(client) { return client.get(); } }";
  const after = before.replace("get", "fetch");
  const changed = {
    ...unit(before, after),
    name: "Svc",
    kind: "declaration" as const,
  };
  const result = prepareRiskCallers(
    [changed],
    [
      {
        path: changed.file,
        before: `${before}\nfunction unrelated(client) { return client.get(); }`,
        after: `${after}\nfunction unrelated(client) { return client.get(); }`,
      },
    ],
    parser,
  );
  assert.deepEqual(result.proofs, []);
  assert.ok(result.limits.some((limit) => limit.kind === "binding_unknown"));
});
test("exported arrow functions retain concrete caller and provider proof", async () => {
  const parser = await loadCallerParser();
  const before = "export const deliver = (client) => client.get();";
  const after = before.replace("get", "fetch");
  const files = sources();
  files[0] = { path: "src/dispatch.ts", before, after };
  const result = prepareRiskCallers([unit(before, after)], files, parser);
  assert.equal(result.proofs.length, 1);
  assert.deepEqual(result.limits, []);
  assert.match(JSON.stringify(result.proofs[0]?.state), /deliver\(provider\)/);
});
test("unlocated default export slices keep cut proof limits", async () => {
  const parser = await loadCallerParser();
  const before = "export default {\n value: client.get(),\n};";
  const after = before.replace("get", "fetch");
  const changed = {
    ...unit(before, after),
    name: "default",
    kind: "slice" as const,
    beforeRange: { start: 1, end: 3 },
    afterRange: { start: 1, end: 3 },
  };
  const result = prepareRiskCallers(
    [changed],
    [
      {
        path: changed.file,
        before: `${before}\nfunction unrelated(client) { return client.get(); }`,
        after: `${after}\nfunction unrelated(client) { return client.get(); }`,
      },
    ],
    parser,
  );
  assert.deepEqual(result.proofs, []);
  assert.ok(result.limits.some((limit) => limit.kind === "piece_cut"));
});
test("coordinated provider migration and imported aliases are shown on both sides", async () => {
  const parser = await loadCallerParser();
  const before =
    "import { deliver as send } from './dispatch';\nimport { Client as Service } from './provider';\nexport function run() { const callback = send; return callback(new Service()); }";
  const files: CallerSource[] = [
    { path: "src/dispatch.ts", before: old, after: next },
    { path: "src/caller.ts", before, after: before },
    {
      path: "src/provider.ts",
      before: "export class Client { get() { return 1; } }",
      after: "export class Client { fetch() { return 1; } }",
    },
  ];
  const result = prepareRiskCallers([unit(old, next)], files, parser);
  assert.equal(result.proofs.length, 1);
  const state = JSON.stringify(result.proofs[0]?.state);
  assert.match(state, /class Client.*get/);
  assert.match(state, /class Client.*fetch/);
  assert.equal(result.limits.length, 0);
});
test("unknown configuration providers never manufacture a caller proof", async () => {
  const parser = await loadCallerParser();
  const result = prepareRiskCallers(
    [unit(old, next)],
    sources(
      "import { deliver } from './dispatch';\nexport function run(config) { return deliver(config.client); }",
    ),
    parser,
  );
  assert.equal(result.proofs.length, 0);
  assert.ok(
    result.limits.some(
      (limit) =>
        limit.kind === "provider_missing" && limit.missing.includes("provider"),
    ),
  );
});
test("all established callers share one state and oversized evidence remains named", async () => {
  const parser = await loadCallerParser();
  const files = sources();
  files.push({
    path: "src/second.ts",
    before: files[1]?.before ?? null,
    after: files[1]?.after ?? null,
  });
  const result = prepareRiskCallers([unit(old, next)], files, parser);
  assert.equal(result.proofs.length, 1);
  assert.ok(
    result.proofs[0]?.paths.some((span) => span.path === "src/second.ts"),
  );
  const limited = prepareRiskCallers([unit(old, next)], files, parser, {
    closure: 1,
  });
  assert.equal(limited.proofs.length, 0);
  assert.ok(
    limited.limits.some(
      (limit) =>
        limit.kind === "budget" && limit.paths.includes("src/caller.ts"),
    ),
  );
});
test("Python aliased imports and concrete class providers are static evidence", async () => {
  const parser = await loadCallerParser();
  const before = "def deliver(client):\n    return client.get()";
  const after = "def deliver(client):\n    return client.fetch()";
  const caller =
    "from dispatch import deliver as send\nclass Client:\n    def get(self):\n        return 1\ndef run():\n    callback = send\n    return callback(Client())";
  const result = prepareRiskCallers(
    [unit(before, after, "src/dispatch.py")],
    [
      { path: "src/dispatch.py", before, after },
      { path: "src/caller.py", before: caller, after: caller },
    ],
    parser,
  );
  assert.equal(result.proofs.length, 1);
  assert.match(JSON.stringify(result.proofs[0]?.state), /class Client/);
});
test("shadowed target names and incomplete parsers do not establish bindings", async () => {
  const parser = await loadCallerParser();
  const result = prepareRiskCallers(
    [unit(old, next)],
    sources(
      "import { deliver } from './dispatch';\nfunction run(deliver) { return deliver({get() {return 1;}}); }",
    ),
    parser,
  );
  assert.equal(result.proofs.length, 0);
  const absent = prepareRiskCallers([unit(old, next)], sources(), null);
  assert.equal(absent.proofs.length, 0);
  assert.equal(absent.limits[0]?.kind, "parser_absent");
});
test("partial callers retain healthy proofs without binding malformed declarations", async () => {
  const parser = await loadCallerParser();
  const healthy = sources()[1];
  assert.ok(healthy);
  const partial = `${healthy.after}\nexport function broken() { const value = ; return deliver(value); }`;
  const result = prepareRiskCallers(
    [unit(old, next)],
    [
      sources()[0] as CallerSource,
      { ...healthy, before: partial, after: partial },
    ],
    parser,
  );
  assert.equal(result.proofs.length, 1);
  assert.match(JSON.stringify(result.proofs[0]?.state), /deliver\(provider\)/);
  assert.doesNotMatch(JSON.stringify(result.proofs[0]?.state), /broken/);
  assert.ok(
    result.limits.some(
      (limit) =>
        limit.kind === "parse_partial" && limit.paths.includes(healthy.path),
    ),
  );
});
test("mutated and inherited receivers are not claimed as concrete providers", async () => {
  const parser = await loadCallerParser();
  for (const caller of [
    "import { deliver } from './dispatch';\nconst provider = { get() { return 1; } };\nprovider.fetch = external;\nexport function run() { return deliver(provider); }",
    "import { deliver } from './dispatch';\nclass Client extends External { get() { return 1; } }\nexport function run() { return deliver(new Client()); }",
  ]) {
    const result = prepareRiskCallers(
      [unit(old, next)],
      sources(caller),
      parser,
    );
    assert.equal(result.proofs.length, 0);
    assert.ok(result.limits.some((limit) => limit.kind === "provider_missing"));
  }
});
test("removing member calls while preserving an existing one is not replacement", async () => {
  const parser = await loadCallerParser();
  const before =
    "export function deliver(x) { return Math.floor(Math.min(Math.max(x,0),10)); }";
  const after =
    "export function deliver(x) { return Math.floor(clamp(x,0,10)); }";
  const result = prepareRiskCallers(
    [unit(before, after)],
    [{ path: "src/dispatch.ts", before, after }],
    parser,
  );
  assert.deepEqual(result, { proofs: [], limits: [] });
});
test("omitted slices use complete source only for trigger detection", async () => {
  const parser = await loadCallerParser();
  const sliced = {
    ...unit("not valid sliced syntax", "also incomplete"),
    kind: "slice" as const,
  };
  const unchanged = "export function deliver(x) { return x.get(); }";
  const result = prepareRiskCallers(
    [sliced],
    [{ path: "src/dispatch.ts", before: unchanged, after: unchanged }],
    parser,
  );
  assert.deepEqual(result, { proofs: [], limits: [] });
  const changed = prepareRiskCallers([sliced], sources(), parser);
  assert.equal(changed.proofs.length, 0);
  assert.ok(changed.limits.some((limit) => limit.kind === "piece_cut"));
});
test("local literal receivers include every write in the complete target", async () => {
  const parser = await loadCallerParser();
  const before =
    "export function deliver() { const opts = {}; opts.legacy = true; return opts; }";
  const after =
    "export function deliver() { const opts = {}; opts.compat = true; return opts; }";
  const caller =
    "import { deliver } from './dispatch'; export function run() { return deliver(); }";
  const result = prepareRiskCallers(
    [unit(before, after)],
    [
      { path: "src/dispatch.ts", before, after },
      { path: "src/caller.ts", before: caller, after: caller },
    ],
    parser,
  );
  assert.equal(result.proofs.length, 1);
  assert.equal(result.limits.length, 0);
  assert.match(JSON.stringify(result.proofs[0]?.state), /opts.compat = true/);
});
test("namespace imports preserve static target and provider identities", async () => {
  const parser = await loadCallerParser();
  const caller =
    "import * as dispatch from './dispatch'; import * as api from './provider'; export function run() { return dispatch.deliver(new api.Client()); }";
  const files = sources(caller);
  files.push({
    path: "src/provider.ts",
    before: "export class Client { get() { return 1; } }",
    after: "export class Client { get() { return 1; } }",
  });
  const result = prepareRiskCallers([unit(old, next)], files, parser);
  assert.equal(result.proofs.length, 1);
  assert.equal(result.limits.length, 0);
});
test("unrelated dynamic imports and metaprogramming do not pollute caller limitations", async () => {
  const parser = await loadCallerParser();
  const files = sources();
  files.push({
    path: "archive/unrelated.ts",
    before: "export async function load() { return import(config.path); }",
    after: "export function load() { return eval(config.source); }",
  });
  const result = prepareRiskCallers([unit(old, next)], files, parser);
  assert.equal(result.proofs.length, 1);
  assert.equal(result.limits.length, 0);
  const involved = sources(
    "import { deliver } from './dispatch'; const provider = { get() {return 1;} }; export function run() { eval(config); return deliver(provider); }",
  );
  const limited = prepareRiskCallers([unit(old, next)], involved, parser);
  assert.equal(limited.proofs.length, 0);
  assert.ok(
    limited.limits.some(
      (limit) =>
        limit.kind === "metaprogramming" &&
        limit.paths.includes("src/caller.ts"),
    ),
  );
});
test("preparing a thousand-line caller file stays below the local latency budget", async () => {
  const parser = await loadCallerParser();
  assert.ok(parser);
  const unrelated = Array.from(
    { length: 1000 },
    (_, index) => `const value${index} = helper${index}(input${index});`,
  ).join("\n");
  const caller = `${unrelated}\nimport { deliver as send } from './dispatch';\nconst provider = { get() { return 1; } };\nexport function run() { const callback = send; return callback(provider); }`;
  const started = performance.now();
  const result = prepareRiskCallers([unit(old, next)], sources(caller), parser);
  const elapsed = performance.now() - started;
  assert.equal(result.proofs.length, 1);
  assert.equal(result.limits.length, 0);
  assert.ok(
    elapsed < 250,
    `local preparation took ${elapsed.toFixed(1)} ms (budget 250 ms)`,
  );
});
test("runtime ESM extensions resolve source targets and providers without choosing ambiguous files", async () => {
  const parser = await loadCallerParser();
  for (const [runtime, source] of [
    ["js", "ts"],
    ["jsx", "tsx"],
    ["mjs", "mts"],
    ["cjs", "cts"],
  ]) {
    const caller = `import { deliver as send } from './dispatch.${runtime}';\nimport { Client } from './provider.${runtime}';\nexport function run() { const callback = send; return callback(new Client()); }`;
    const files: CallerSource[] = [
      { path: `src/dispatch.${source}`, before: old, after: next },
      { path: "src/caller.ts", before: caller, after: caller },
      {
        path: `src/provider.${source}`,
        before: "export class Client { get() { return 1; } }",
        after: "export class Client { fetch() { return 1; } }",
      },
    ];
    const result = prepareRiskCallers(
      [unit(old, next, `src/dispatch.${source}`)],
      files,
      parser,
    );
    assert.equal(result.proofs.length, 1, runtime);
    assert.equal(result.limits.length, 0, runtime);
    files.push({ path: `src/dispatch.${runtime}`, before: old, after: next });
    const ambiguous = prepareRiskCallers(
      [unit(old, next, `src/dispatch.${source}`)],
      files,
      parser,
    );
    assert.equal(ambiguous.proofs.length, 0, runtime);
    assert.ok(
      ambiguous.limits.some((limit) => limit.kind === "caller_missing"),
      runtime,
    );
  }
});
test("scope indices reject duplicate, written and nested shadowed target aliases", async () => {
  const parser = await loadCallerParser();
  for (const caller of [
    "import { deliver as send } from './dispatch'; const provider = { get() {return 1;} }; function run(send) { return send(provider); }",
    "import { deliver } from './dispatch'; const provider = { get() {return 1;} }; const send = deliver; send = external; function run() { return send(provider); }",
    "import { deliver } from './dispatch'; const provider = { get() {return 1;} }; function run() { { const deliver = external; return deliver(provider); } }",
    "import { deliver } from './dispatch'; const provider = { get() {return 1;} }; function run() { const send = deliver; const send = external; return send(provider); }",
  ]) {
    const result = prepareRiskCallers(
      [unit(old, next)],
      sources(caller),
      parser,
    );
    assert.equal(result.proofs.length, 0);
  }
});

test("malformed changed non-callable declarations stay unchecked without a member replacement trigger", async () => {
  const parser = await loadCallerParser();
  const before = "export const check = { value: 1 };";
  const after = "export const check = { value: ; };";
  const changed = {
    ...unit(before, after),
    kind: "declaration" as const,
    name: "check",
  };
  const result = prepareRiskCallers(
    [changed],
    [{ path: changed.file, before, after }],
    parser,
  );
  assert.deepEqual(result.proofs, []);
  assert.ok(
    result.limits.some(
      (limit) =>
        limit.unitId === changed.id &&
        limit.kind === "parse_partial" &&
        limit.paths.includes(changed.file),
    ),
  );
});

test("syntax errors in another declaration do not block a healthy changed declaration", async () => {
  const parser = await loadCallerParser();
  const before = "export const check = { value: 1 };";
  const after = "export const check = { value: 2 };";
  const changed = {
    ...unit(before, after),
    kind: "declaration" as const,
    name: "check",
  };
  const result = prepareRiskCallers(
    [changed],
    [
      {
        path: changed.file,
        before: `${before}\nexport const swallowed = ;`,
        after: `${after}\nexport const swallowed = ;`,
      },
    ],
    parser,
  );
  assert.deepEqual(result.proofs, []);
  assert.deepEqual(result.limits, []);
});

test("partial syntax diagnostics aggregate errors separately for each file side", async () => {
  const parser = await loadCallerParser();
  const malformed = "export const first = ;\nexport const second = ;";
  const result = prepareRiskCallers(
    [unit(old, next)],
    sources(malformed),
    parser,
  );
  const partial = result.limits.filter(
    (limit) =>
      limit.kind === "parse_partial" && limit.paths.includes("src/caller.ts"),
  );
  assert.equal(partial.length, 2);
  assert.deepEqual(
    partial.map((limit) => limit.missing),
    [
      "before syntax at lines 1, 2 (2 errors)",
      "after syntax at lines 1, 2 (2 errors)",
    ],
  );
});
