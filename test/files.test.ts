import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectFiles } from "../src/adapters/files.ts";

const cases: {
  name: string;
  contents: Record<string, string>;
  paths: string[];
  error?: RegExp;
  files?: Record<string, string>;
}[] = [
  {
    name: "a file over 80000 characters is refused rather than truncated",
    contents: { "large.txt": "é".repeat(80001) },
    paths: ["large.txt"],
    error: /exceeds 80000 chars/,
  },
  {
    name: "an empty file is refused",
    contents: { "empty.txt": "" },
    paths: ["empty.txt"],
    error: /empty/,
  },
  {
    name: "more than 20 existing file paths are refused",
    contents: Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [
        `file-${index}.txt`,
        "content",
      ]),
    ),
    paths: Array.from({ length: 21 }, (_, index) => `file-${index}.txt`),
    error: /exceeds 20 files/,
  },
  {
    name: "a directory is refused",
    contents: {},
    paths: ["."],
    error: /Not a file/,
  },
  {
    name: "ordinary UTF-8 file contents remain intact",
    contents: { "utf8.txt": "Été — 日本語 — 😀\nDeuxième ligne.\n" },
    paths: ["utf8.txt"],
    files: { "utf8.txt": "Été — 日本語 — 😀\nDeuxième ligne.\n" },
  },
];

for (const entry of cases) {
  test(`collectFiles: ${entry.name}`, async () => {
    const cache = join(homedir(), ".cache", "jev-tools");
    await mkdir(cache, { recursive: true });
    const cwd = await mkdtemp(join(cache, "files-test-"));
    try {
      await Promise.all(
        Object.entries(entry.contents).map(([path, content]) =>
          writeFile(join(cwd, path), content, "utf8"),
        ),
      );
      const result = await collectFiles(cwd, entry.paths);
      if (entry.error) {
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, entry.error);
      } else {
        assert.equal(result.ok, true);
        if (result.ok) assert.deepEqual(result.files, entry.files);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
test("collectFiles refuses invalid UTF-8 before creating integrity evidence", async () => {
  const cwd = await mkdtemp(
    join(homedir(), ".cache", "jev-tools", "utf8-test-"),
  );
  try {
    await writeFile(join(cwd, "latin.txt"), Buffer.from([0xe9]));
    const result = await collectFiles(cwd, ["latin.txt"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /latin\.txt.*not UTF-8 text/);
    await writeFile(join(cwd, "latin.txt"), "\ufeffÉté\r\n");
    const valid = await collectFiles(cwd, ["latin.txt"]);
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal(valid.files["latin.txt"], "\ufeffÉté\r\n");
      assert.equal(
        valid.identities[0]?.readSha256,
        valid.identities[0]?.insertedSha256,
      );
    }
    await writeFile(join(cwd, "big.txt"), "é".repeat(200000));
    const large = await collectFiles(cwd, ["big.txt"]);
    assert.equal(large.ok, false);
    if (!large.ok) assert.match(large.error, /exceeds 80000 chars/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("collectFiles counts canonical identities and serializes aliases only once", async () => {
  const cwd = await mkdtemp(
    join(homedir(), ".cache", "jev-tools", "dedup-test-"),
  );
  try {
    await writeFile(join(cwd, "a.ts"), "export const value = 1;".repeat(2000));
    const result = await collectFiles(
      cwd,
      Array.from({ length: 21 }, (_, i) => `${"./".repeat(i)}a.ts`),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(Object.keys(result.files), ["a.ts"]);
      assert.equal(result.identities.length, 1);
    }
    assert.equal((await collectFiles(cwd, ["../a.ts", "a.ts"])).ok, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("collection failure causes preserve admission provenance without parsing prose", async () => {
  const cwd = await mkdtemp(
    join(homedir(), ".cache", "jev-tools", "cause-test-"),
  );
  try {
    await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 1, 2]));
    const binary = await collectFiles(cwd, ["binary.dat"]);
    assert.equal(binary.ok, false);
    if (!binary.ok) assert.equal(binary.cause, "binary_or_non_utf8");
    const forbidden = await collectFiles(cwd, ["../secret.ts"]);
    assert.equal(forbidden.ok, false);
    if (!forbidden.ok) assert.equal(forbidden.cause, "forbidden_path");
    const missing = await collectFiles(cwd, ["missing.ts"]);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.cause, "file_unavailable");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
