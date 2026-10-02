import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLocateFile, scanRange } from "../src/adapters/locate-file.ts";

test("unterminated final eighty-line streaming window is retained", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-stream-"));
  try {
    await writeFile(
      join(cwd, "large.txt"),
      Array.from(
        { length: 720 },
        (_, i) => `line ${i + 1} ${"x".repeat(500)}`,
      ).join("\n"),
    );
    const file = await readLocateFile(cwd, "large.txt");
    assert.ok(file.ok && file.kind === "outline");
    assert.equal(file.lines, 720);
    const last = file.windows.at(-1);
    assert.ok((last?.start ?? 0) <= 720);
    assert.equal(last?.end, 720);
    assert.match(last?.text ?? "", /line 720/);
    assert.ok((last?.serializedTextChars ?? 0) > 0);
  } finally {
    await rm(cwd, { recursive: true });
  }
});
test("NUL is refused in both bounded file collection and streaming first chunk", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-binary-"));
  try {
    await writeFile(join(cwd, "binary"), `text\0${"x".repeat(400000)}`);
    for (const result of [
      await readLocateFile(cwd, "binary"),
      await scanRange(cwd, "binary"),
    ]) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /Not a text file/);
    }
  } finally {
    await rm(cwd, { recursive: true });
  }
});
test("absolute, parent and symlink escapes are refused before reading", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-sandbox-"));
  const cwd = join(root, "repo");
  try {
    await mkdir(cwd);
    await writeFile(join(root, "secret"), "private content");
    await symlink(join(root, "secret"), join(cwd, "link"));
    for (const path of [join(root, "secret"), "../secret", "link"]) {
      for (const result of [
        await readLocateFile(cwd, path),
        await scanRange(cwd, path),
      ]) {
        assert.equal(result.ok, false);
      }
    }
  } finally {
    await rm(root, { recursive: true });
  }
});
