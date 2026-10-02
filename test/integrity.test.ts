import assert from "node:assert/strict";
import { test } from "node:test";
import { checkIntegrity, type FileIdentity } from "../src/core/integrity.ts";

const file: FileIdentity = {
  requestedPath: "a.ts",
  resolvedPath: "/repo/a.ts",
  insertedPath: "/repo/a.ts",
  readSha256: "abc",
  insertedSha256: "abc",
  content: "content",
};
test("identity and fingerprints detect substitution, emptiness and byte changes without Jev", () => {
  assert.deepEqual(checkIntegrity({}, [], [file]).controls, []);
  for (const broken of [
    { ...file, insertedPath: "/repo/b.ts" },
    { ...file, content: "" },
    { ...file, insertedSha256: "def" },
  ])
    assert.equal(checkIntegrity({}, [], [broken]).controls.length, 1);
});
test("quoted output evidence must survive compression, while truncation alone is a note", () => {
  const asks = [
    {
      intent: "verify" as const,
      about: "output",
      claims: { c1: "Output contains `error: access denied`" },
    },
  ];
  assert.equal(
    checkIntegrity({ output: "error: access denied" }, asks).controls.length,
    0,
  );
  assert.match(
    checkIntegrity({ output: "done" }, asks).controls[0]?.fact ?? "",
    /cited line not in state/,
  );
  const result = checkIntegrity({}, asks, [], {
    text: "error: access denied",
    truncated: true,
    omittedChars: 700,
  });
  assert.equal(result.controls.length, 0);
  assert.match(result.notes[0]?.fact ?? "", /700 chars omitted/);
});
test("quoted literals unrelated to output are not output-integrity checks", () => {
  assert.deepEqual(
    checkIntegrity({ output: "done" }, [
      {
        intent: "verify",
        about: "files",
        claims: { c1: 'File exports "validate"' },
      },
    ]).controls,
    [],
  );
});

test("apostrophes in ordinary prose do not introduce output literals", () => {
  assert.deepEqual(
    checkIntegrity({ output: "done" }, [
      {
        intent: "verify",
        about: "output",
        claims: { c1: "The test's result isn't an error" },
      },
    ]).controls,
    [],
  );
});
