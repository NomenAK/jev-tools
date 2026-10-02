import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleState } from "../src/core/state.ts";

test("JSON notes merge at the root and files remain intact", () => {
  assert.deepEqual(assembleState('{"goal":"review"}', { "src/a.ts": "😀\n" }), {
    ok: true,
    state: { goal: "review", files: { "src/a.ts": "😀\n" } },
  });
});

test("oversized notes and assembled files are refused, never truncated", () => {
  assert.equal(assembleState("x".repeat(8001), {}).ok, false);
  const result = assembleState("review", { "huge.ts": "x".repeat(80000) });
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.match(result.error, /serialized parts: note 18, huge.ts 80014/);
});

test("literal notes and valid JSON scalars remain under state", () => {
  assert.deepEqual(assembleState("hello", {}), {
    ok: true,
    state: { state: "hello" },
  });
  assert.deepEqual(assembleState("false", {}), {
    ok: true,
    state: { state: false },
  });
});

test("reserved files in a JSON note is refused instead of silently replaced", () => {
  const result = assembleState('{"files":{"note":"keep me"}}', {
    "a.ts": "export {}",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /reserved key files; rename it/);
});

for (const key of ["files_before", "base_sha", "closure"]) {
  test(`JSON note cannot impersonate reserved ${key} evidence`, () => {
    const result = assembleState(JSON.stringify({ [key]: "agent text" }), {});
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.match(result.error, new RegExp(`reserved key ${key}; rename it`));
  });
}
