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

test("explicit paths include selectors and quoted names without numerical or URL noise", () => {
  assert.deepEqual(
    citedPaths(
      'Compare files["src/a.ts"], `README` and "docs/guide.md" with src/b.py.',
    ),
    ["src/a.ts", "README", "docs/guide.md", "src/b.py"],
  );
  assert.deepEqual(
    citedPaths(
      "There are 3 files, 1.25 seconds, 2026-09-30 and 30/09/2026; visit https://host.test/docs/a.md. The behavior is correct.",
    ),
    [],
  );
  assert.deepEqual(
    citedPaths("The first statement holds and the second is wrong."),
    [],
  );
  assert.deepEqual(citedPaths("files['extensionless'] is present"), [
    "extensionless",
  ]);
  assert.deepEqual(citedPaths('The claim "src/a.ts validates tokens" holds'), [
    "src/a.ts",
  ]);
  assert.deepEqual(citedPaths('docs["api.md"].text explains the API'), []);
  assert.deepEqual(
    citedPaths(
      "Node.js validates req.headers using check.ts, e.g. version 2.0.",
    ),
    ["check.ts"],
  );
  assert.deepEqual(
    citedPaths(
      "Next.js or Vue.js returns null and/or throws across input/output and client/server",
    ),
    [],
  );
  assert.deepEqual(citedPaths("Read src/config.json or `bin/start`"), [
    "bin/start",
    "src/config.json",
  ]);
});

test("unique suffix resolves while exact repository path beats ambiguous basenames", () => {
  const compiled = plan({
    a: "src/a.ts uses rules.json",
    b: "README documents behavior",
  });
  assert.deepEqual(
    resolveAskReferences(compiled, undefined, { "src/a.ts": "code" }, [
      "src/a.ts",
      "config/rules.json",
      "README",
      "docs/README",
    ]),
    {
      additions: [
        { reference: "rules.json", path: "config/rules.json" },
        { reference: "README", path: "README" },
      ],
      unresolved: [],
    },
  );
  assert.deepEqual(
    resolveAskReferences(
      plan({ a: "a.ts validates tokens" }),
      undefined,
      { "src/a.ts": "code" },
      [],
    ).additions,
    [{ reference: "a.ts", path: "src/a.ts" }],
  );
});

test("missing and ambiguous references block only the reading citing them", () => {
  const compiled = plan({
    a: "a.ts handles errors",
    b: "missing.md describes errors",
    c: "utils.ts validates tokens",
  });
  const resolution = resolveAskReferences(
    compiled,
    undefined,
    { "a.ts": "code" },
    ["a.ts", "src/utils.ts", "test/utils.ts"],
  );
  assert.deepEqual(resolution.additions, []);
  const blocked = blockedAskReadings(
    compiled,
    { files: { "a.ts": "code" } },
    resolution.unresolved,
  );
  assert.deepEqual(
    [...blocked.keys()],
    compiled.readings.slice(1).map(({ id }) => id),
  );
});

test("note references are resolved and an unresolved note reference blocks every reading", () => {
  const compiled = plan({
    a: "a.ts handles errors",
    b: "The behavior is correct",
  });
  assert.deepEqual(
    resolveAskReferences(
      compiled,
      "Consult docs/guide.md",
      { "a.ts": "code" },
      ["docs/guide.md"],
    ).additions,
    [{ reference: "docs/guide.md", path: "docs/guide.md" }],
  );
  const resolution = resolveAskReferences(
    compiled,
    "Consult missing.md",
    { "a.ts": "code" },
    [],
  );
  assert.deepEqual(
    [
      ...blockedAskReadings(
        compiled,
        { files: { "a.ts": "code" } },
        resolution.unresolved,
        "Consult missing.md",
      ).keys(),
    ],
    compiled.readings.map(({ id }) => id),
  );
});

test("file ceiling includes originals but aliases of selected files do not consume slots", () => {
  const files = Object.fromEntries(
    Array.from({ length: ASK_MAX_FILES }, (_, i) => [
      `src/file${i}.ts`,
      "code",
    ]),
  );
  const compiled = plan({
    a: "file0.ts handles errors",
    b: "extra.ts handles errors",
  });
  const resolution = resolveAskReferences(compiled, undefined, files, [
    ...Object.keys(files),
    "extra.ts",
  ]);
  assert.deepEqual(resolution.additions, [
    { reference: "file0.ts", path: "src/file0.ts" },
  ]);
  assert.equal(resolution.unresolved[0]?.reference, "extra.ts");
  assert.match(resolution.unresolved[0]?.reason ?? "", /ASK_MAX_FILES/);
});

test("empty explicitly cited files block their claim without contaminating its neighbor", () => {
  const compiled = plan({
    a: 'files["a.ts"] validates tokens',
    b: 'files["b.ts"] validates tokens',
  });
  const blocked = blockedAskReadings(
    compiled,
    { files: { "a.ts": " \n ", "b.ts": "export const valid = true" } },
    [],
  );
  const reading = compiled.readings[0];
  assert.ok(reading);
  assert.deepEqual([...blocked.keys()], [reading.id]);
});

test("empty state and null fields are blocked, but false and zero are evidence", () => {
  const compiled = plan({ a: "The behavior is correct" });
  assert.equal(blockedAskReadings(compiled, {}, []).size, 1);
  assert.equal(
    blockedAskReadings(
      plan({ a: "The behavior is correct" }, "state.doc"),
      { doc: null, files: { "a.ts": "code" } },
      [],
    ).size,
    1,
  );
  assert.equal(
    blockedAskReadings(
      plan({ a: "The behavior is correct" }, "state.enabled"),
      { enabled: false },
      [],
    ).size,
    0,
  );
  assert.equal(
    blockedAskReadings(
      plan({ a: "The behavior is correct" }, "state.count"),
      { count: 0 },
      [],
    ).size,
    0,
  );
});

test("nested document selectors traverse JSON strings without eval and stay reading-local", () => {
  const compiled = plan({
    a: 'docs["api"].text explains authentication',
    b: 'docs["other"].text explains authorization',
  });
  const blocked = blockedAskReadings(
    compiled,
    {
      docs: JSON.stringify({
        api: { text: " " },
        other: { text: "Documented" },
      }),
    },
    [],
  );
  assert.deepEqual([...blocked.keys()], [compiled.readings[0]?.id]);
  assert.equal(
    blockedAskReadings(
      plan({ a: "The behavior is correct" }, "docs.api.text"),
      { docs: '{"api":{"text":""}}' },
      [],
    ).size,
    1,
  );
});

test("added reference aliases are usable as proof and empty note-cited proof is global", () => {
  const compiled = plan({
    a: "rules.json validates tokens",
    b: "The behavior is correct",
  });
  assert.equal(
    blockedAskReadings(compiled, { files: { "rules.json": "rules" } }, []).size,
    0,
  );
  assert.equal(
    blockedAskReadings(
      compiled,
      { files: { "rules.json": "rules", "guide.md": "" } },
      [],
      "Read guide.md",
    ).size,
    2,
  );
});

test("a null base file is valid creation evidence rather than an empty document", () => {
  const compiled = plan({
    a: 'files_before["new.ts"] did not exist before files["new.ts"] was added',
  });
  assert.equal(
    blockedAskReadings(
      compiled,
      { files: { "new.ts": "code" }, files_before: { "new.ts": null } },
      [],
    ).size,
    0,
  );
});
