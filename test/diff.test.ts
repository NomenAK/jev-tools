import assert from "node:assert/strict";
import test from "node:test";
import { isTestFile, parseDiff } from "../src/core/diff.ts";

test("NUL metadata preserves rename paths, binary files and untracked paths", () => {
  const files = parseDiff({
    raw: ":100644 100644 aaaa bbbb R100\0old\t name\0new\n name\0:100644 100644 aaaa bbbb M\0image.bin\0",
    numstat: "0\t0\t\0old\t name\0new\n name\0-\t-\timage.bin\0",
    patch:
      "diff --git a/old b/new\nsimilarity index 100%\ndiff --git a/image.bin b/image.bin\nBinary files differ\n",
    untracked: ["new file.ts"],
  });
  assert.ok(files[0]);
  assert.ok(files[1]);
  assert.ok(files[2]);
  assert.equal(files[0].oldPath, "old\t name");
  assert.equal(files[0].path, "new\n name");
  assert.equal(files[1].binary, true);
  assert.equal(files[2].status, "?");
});
test("diff classification identifies evidence, not runnable entries", () => {
  for (const path of [
    "test/helper.js",
    "pkg/tests/fixture.txt",
    "__tests__/setup.ts",
    "a.test.ts",
    "a.spec.cjs",
    "a.vitest.mtsx",
    "a.test-d.cts",
    "a.spec-d.tsx",
    "test_a.py",
    "pkg/conftest.py",
    "pkg/a_test.py",
    "a_test.go",
  ])
    assert.equal(isTestFile(path), true, path);
  for (const path of [
    "contest/a.ts",
    "testing/a.js",
    "src/test.ts",
    "a.test.txt",
    "test_a.ts",
  ])
    assert.equal(isTestFile(path), false, path);
});
test("patch changes retain zero-count insertion coordinates and ignore misleading path headers", () => {
  const files = parseDiff({
    raw: ":100644 100644 aaaa bbbb M\0actual.ts\0",
    numstat: "2\t1\tactual.ts\0",
    patch:
      "diff --git ignored\n--- a/wrong.ts\n+++ b/wrong.ts\n@@ -2,2 +2,3 @@\n context\n-old\n+new\n+extra\n\\ No newline at end of file\n@@ -9,0 +11 @@\n+inserted\n",
  });
  assert.equal(files[0]?.path, "actual.ts");
  assert.deepEqual(
    files[0]?.hunks.map((h) => h.changes),
    [
      [{ beforeStart: 3, beforeCount: 1, afterStart: 3, afterCount: 2 }],
      [{ beforeStart: 9, beforeCount: 0, afterStart: 11, afterCount: 1 }],
    ],
  );
});
test("suppressed empty context still advances both coordinates", () => {
  const file = parseDiff({
    raw: ":100644 100644 aaaa bbbb M\0a.ts\0",
    numstat: "1\t1\ta.ts\0",
    patch: "diff --git a/a.ts b/a.ts\n@@ -1,3 +1,3 @@\n first\n\n-old\n+new\n",
  })[0];
  assert.deepEqual(file?.hunks[0]?.changes, [
    { beforeStart: 3, beforeCount: 1, afterStart: 3, afterCount: 1 },
  ]);
  assert.equal(file?.hunks[0]?.beforeText, "first\n\nold");
});
test("bounded patch evidence keeps code points and visible truncation", () => {
  const file = parseDiff({
    raw: ":100644 100644 aaaa bbbb M\0a.txt\0",
    numstat: "1\t1\ta.txt\0",
    patch: `diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+${"x".repeat(5999)}😀suffix\n`,
  })[0];
  assert.equal(file?.hunks[0]?.afterText, "x".repeat(5999));
  assert.equal(file?.hunks[0]?.truncated, true);
});
