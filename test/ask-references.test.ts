import assert from "node:assert/strict";
import { test } from "node:test";
import { ASK_MAX_FILES } from "../src/constants.ts";
import {
  blockedAskReadings,
  citedPaths,
  resolveAskReferences,
} from "../src/core/ask-references.ts";
import { compileAsks } from "../src/core/asks.ts";

function plan(claims: Record<string, string>, about?: string) {
  const result = compileAsks(
    { intent: "verify", claims, ...(about ? { about } : {}) },
    { surface: "ask" },
  );
  if (!result.ok) throw new Error(result.error);
  return result;
}
test("ordinary expressions and missing lexical hints do not veto judgments", () => {
  const compiled = plan({
    a: "process.env and .only appear in admitted code",
    b: "missing.json is mentioned",
  });
  const resolution = resolveAskReferences(
    compiled,
    "unrelated.json",
    { "src/a.ts": "code" },
    [],
  );
  assert.deepEqual(resolution.unresolved, []);
  assert.equal(
    blockedAskReadings(
      compiled,
      { files: { "src/a.ts": "code" } },
      resolution.unresolved,
      "unrelated.json",
    ).size,
    0,
  );
  assert.deepEqual(
    citedPaths("process.env .only 1.25 https://host.test/a.ts"),
    [],
  );
});
test("supplied basename priority and exact directory paths never substitute", () => {
  const compiled = plan({ a: 'files["find.ts"] contains code' });
  const resolved = resolveAskReferences(
    compiled,
    undefined,
    { "src/find.ts": "code" },
    ["src/find.ts", "other/find.ts"],
  );
  assert.equal(resolved.aliases["find.ts"], "src/find.ts");
  assert.equal(resolved.unresolved.length, 0);
  assert.equal(resolved.additions.length, 0);
  const ambiguous = resolveAskReferences(
    compiled,
    undefined,
    { "src/find.ts": "a", "other/find.ts": "b" },
    [],
  );
  assert.match(ambiguous.unresolved[0]?.reason ?? "", /ambiguous/);
  const exact = resolveAskReferences(
    plan({ a: 'files["src/missing/find.ts"] contains code' }),
    undefined,
    { "other/find.ts": "code" },
    ["other/find.ts"],
  );
  assert.equal(exact.unresolved.length, 1);
  assert.equal(exact.additions.length, 0);
});
test("exact identities beat aliases and alias collisions stay ambiguous", () => {
  const compiled = plan({ a: 'files["a.ts"] contains code' });
  assert.equal(
    resolveAskReferences(
      compiled,
      undefined,
      {
        files: { "a.ts": "a", "src/a.ts": "b" },
        aliases: { "a.ts": "src/a.ts" },
      },
      [],
    ).aliases["a.ts"],
    "a.ts",
  );
  assert.match(
    resolveAskReferences(
      compiled,
      undefined,
      {
        files: { "src/a.ts": "a", "other/a.ts": "b" },
        aliases: { "a.ts": ["src/a.ts", "other/a.ts"] },
      },
      [],
    ).unresolved[0]?.reason ?? "",
    /ambiguous/,
  );
});
test("explicit missing requirements block causal groups and global note requirements block all", () => {
  const compiled = plan({
    a: 'files["missing.md"] documents behavior',
    b: 'files["a.ts"] contains code',
  });
  const files = { "a.ts": "code" };
  const local = resolveAskReferences(compiled, undefined, files, []);
  assert.deepEqual(
    [...blockedAskReadings(compiled, { files }, local.unresolved).keys()],
    [compiled.readings[0]?.id],
  );
  const note = 'Consult files["global.md"]';
  const global = resolveAskReferences(compiled, note, files, []);
  assert.equal(
    blockedAskReadings(compiled, { files }, global.unresolved, note).size,
    compiled.readings.length,
  );
});
test("output literals are observations but explicit files selectors remain required", () => {
  const compiled = plan({ a: "server.json was printed" }, "output");
  const resolution = resolveAskReferences(compiled, undefined, {}, [
    "server.json",
  ]);
  assert.equal(resolution.additions.length, 0);
  assert.equal(
    blockedAskReadings(
      compiled,
      { output: { stdout: '{"server.json":true}' } },
      resolution.unresolved,
    ).size,
    0,
  );
  assert.equal(blockedAskReadings(compiled, {}, []).size, 1);
  const explicit = resolveAskReferences(
    plan({ a: 'files["server.json"] describes the output' }, "output"),
    undefined,
    {},
    [],
  );
  assert.equal(explicit.unresolved.length, 1);
});
test("false zero and established creation are evidence, explicit empty files are not", () => {
  assert.equal(
    blockedAskReadings(
      plan({ a: "enabled is false" }, "state.enabled"),
      { enabled: false },
      [],
    ).size,
    0,
  );
  assert.equal(
    blockedAskReadings(
      plan({ a: "count is zero" }, "state.count"),
      { count: 0 },
      [],
    ).size,
    0,
  );
  const compiled = plan({
    a: 'files_before["new.ts"] is absent before creation',
  });
  assert.equal(
    blockedAskReadings(
      compiled,
      { files_before: { "new.ts": null }, base_sha: "abc" },
      [],
    ).size,
    0,
  );
  assert.equal(
    blockedAskReadings(compiled, { files_before: { "new.ts": null } }, []).size,
    1,
  );
  assert.equal(
    blockedAskReadings(
      plan({ a: 'files["empty.ts"] contains code' }),
      { files: { "empty.ts": " " } },
      [],
    ).size,
    1,
  );
});
test("aliases resolve emptiness by identity without duplicate content", () => {
  const compiled = plan({ a: 'files["a.ts"] contains code' });
  const state = {
    files: { "src/a.ts": "code" },
    evidence: { aliases: { "a.ts": "src/a.ts" } },
  };
  assert.equal(blockedAskReadings(compiled, state, []).size, 0);
  assert.equal(Object.keys(state.files).length, 1);
});
test("canonical file ceiling ignores aliases and reports omitted additions", () => {
  const files = Object.fromEntries(
    Array.from({ length: ASK_MAX_FILES }, (_, i) => [
      `src/file${i}.ts`,
      "code",
    ]),
  );
  const resolution = resolveAskReferences(
    plan({
      a: 'files["file0.ts"] is admitted',
      b: 'files["extra.ts"] is required',
    }),
    undefined,
    files,
    ["extra.ts"],
  );
  assert.equal(resolution.additions.length, 0);
  assert.equal(resolution.aliases["file0.ts"], "src/file0.ts");
  assert.match(resolution.unresolved[0]?.reason ?? "", /ASK_MAX_FILES/);
});
test("forbidden explicit references refuse rather than becoming hints", () => {
  for (const path of [
    "../secret.ts",
    "/secret.ts",
    ".git/config",
    "C:\\secret.ts",
  ])
    assert.equal(
      resolveAskReferences(
        plan({ a: `files[${JSON.stringify(path)}] is present` }),
        undefined,
        {},
        [],
      ).invalid.length,
      1,
    );
  assert.equal(
    resolveAskReferences(
      plan({ a: 'files[".only"] is present' }),
      undefined,
      {},
      [],
    ).unresolved.length,
    1,
  );
});
test("extensionless prototype-looking aliases preserve exact file identities", () => {
  for (const name of ["constructor", "__proto__", "toString"]) {
    const compiled = plan({ a: `files[${JSON.stringify(name)}] is present` });
    const resolution = resolveAskReferences(
      compiled,
      undefined,
      { files: { [`src/${name}`]: "code" }, aliases: {} },
      [],
    );
    assert.equal(resolution.aliases[name], `src/${name}`);
    assert.equal(resolution.unresolved.length, 0);
    assert.equal(
      blockedAskReadings(
        compiled,
        {
          files: { [`src/${name}`]: "code" },
          evidence: { aliases: resolution.aliases },
        },
        [],
      ).size,
      0,
    );
  }
});
test("repeated controls deduplicate requirements within a reading, not across readings or sides", () => {
  const compiled = plan({
    a: 'files["missing.ts"] and files_before["missing.ts"] describe the change',
    b: 'files["missing.ts"] documents the behavior',
  });
  const resolution = resolveAskReferences(compiled, undefined, {}, []);
  assert.deepEqual(
    resolution.unresolved.map(({ reference, scope, side, required }) => ({
      reference,
      scope,
      side,
      required,
    })),
    [
      {
        reference: "missing.ts",
        scope: compiled.readings[0]?.id,
        side: "files",
        required: true,
      },
      {
        reference: "missing.ts",
        scope: compiled.readings[0]?.id,
        side: "files_before",
        required: true,
      },
      {
        reference: "missing.ts",
        scope: compiled.readings[1]?.id,
        side: "files",
        required: true,
      },
    ],
  );
  assert.equal(blockedAskReadings(compiled, {}, resolution.unresolved).size, 2);
});

test("before-first references collect both versions while counting one identity", () => {
  const files = Object.fromEntries(
    Array.from({ length: ASK_MAX_FILES - 1 }, (_, i) => [
      `file${i}.ts`,
      "code",
    ]),
  );
  const resolution = resolveAskReferences(
    plan({ a: 'files_before["changed.ts"] and files["changed.ts"] differ' }),
    undefined,
    { files, beforeInventory: ["changed.ts"] },
    ["changed.ts"],
  );
  assert.deepEqual(
    resolution.additions.map(({ path, side }) => ({ path, side })),
    [
      { path: "changed.ts", side: "files_before" },
      { path: "changed.ts", side: "files" },
    ],
  );
  assert.deepEqual(resolution.unresolved, []);
});

test("deleted before identities obey the ceiling and exact path resolution", () => {
  const paths = Array.from(
    { length: ASK_MAX_FILES + 1 },
    (_, i) => `old/file${i}.ts`,
  );
  const resolution = resolveAskReferences(
    plan(
      Object.fromEntries(
        paths.map((path, i) => [
          `c${i}`,
          `files_before[${JSON.stringify(path)}] exists`,
        ]),
      ),
    ),
    undefined,
    { files: {}, beforeInventory: paths },
    [],
  );
  assert.equal(resolution.additions.length, ASK_MAX_FILES);
  assert.ok(
    resolution.unresolved.some(
      ({ reference, reason }) =>
        reference === paths.at(-1) && reason.includes("ASK_MAX_FILES"),
    ),
  );
  const missing = resolveAskReferences(
    plan({ a: 'files_before["missing/file0.ts"] exists' }),
    undefined,
    { files: {}, beforeInventory: paths },
    [],
  );
  assert.equal(missing.additions.length, 0);
  assert.match(missing.unresolved[0]?.reason ?? "", /not found/);
});
