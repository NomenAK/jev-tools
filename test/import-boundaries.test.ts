import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// URL.pathname yields "/C:/..." on Windows; fileURLToPath is portable.
const script = fileURLToPath(
  new URL("../scripts/check-imports.ts", import.meta.url),
);
async function check(files: Record<string, string>) {
  const cache = join(homedir(), ".cache", "jev-tools");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "imports-fixture-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      const file = join(root, "src", path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    const result = spawnSync(process.execPath, [script, root], {
      encoding: "utf8",
    });
    return { code: result.status, output: result.stdout + result.stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("refuses an ascending core type import with file and rule", async () => {
  const result = await check({
    "core/a.ts": 'import type { A } from "../adapters/a.ts";',
    "adapters/a.ts": "export interface A {}",
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /src\/core\/a.ts.*layer-dependency/);
});

for (const [name, text, rule] of [
  [
    "static filesystem import",
    'import { readFile } from "node:fs/promises";',
    "pure-dependency",
  ],
  ["bare filesystem import", 'import "fs";', "pure-dependency"],
  [
    "child process export",
    'export { spawn } from "node:child_process";',
    "pure-dependency",
  ],
  [
    "literal dynamic native import",
    'await import("@ast-grep/napi");',
    "pure-dependency",
  ],
  [
    "literal dynamic tool import",
    'await import("../tools/a.ts");',
    "layer-dependency",
  ],
  [
    "network type import",
    'import type { Server } from "node:http";',
    "pure-dependency",
  ],
  [
    "inline adapter type",
    'type A = import("../adapters/a.ts").A;',
    "layer-dependency",
  ],
  [
    "mixed native import",
    'import { type SgNode, parse } from "@ast-grep/napi";',
    "pure-dependency",
  ],
  [
    "named native type import loads module",
    'import { type SgNode } from "@ast-grep/napi";',
    "pure-dependency",
  ],
  [
    "named native type export loads module",
    'export { type SgNode } from "@ast-grep/napi";',
    "pure-dependency",
  ],
  [
    "named local type import loads module",
    'import { type State } from "../jev/types.ts";',
    "type-contract-only",
  ],
  [
    "named local type export loads module",
    'export { type State } from "../jev/types.ts";',
    "type-contract-only",
  ],
  [
    "builtin loader property",
    'process.getBuiltinModule("node:fs");',
    "pure-io",
  ],
  ["builtin loader identifier", 'getBuiltinModule("node:fs");', "pure-io"],
  ["fetch call", 'fetch("https://example.com");', "pure-io"],
  ["global fetch call", 'globalThis.fetch("https://example.com");', "pure-io"],
  [
    "nonliteral dynamic import",
    "await import(moduleName);",
    "static-import-target",
  ],
  ["unresolved local import", 'import "./missing.ts";', "local-resolution"],
  ["runtime type contract", 'import "../jev/types.ts";', "type-contract-only"],
] as const) {
  test(`refuses ${name}`, async () => {
    const result = await check({
      "core/a.ts": text,
      "adapters/a.ts": "export interface A {}",
      "tools/a.ts": "export const value = 1;",
      "jev/types.ts": "export interface State {}",
    });
    assert.equal(result.code, 1);
    assert.ok(
      result.output.includes(`src/core/a.ts:1 [${rule}]`),
      result.output,
    );
  });
}

for (const layer of [
  "presets",
  "adapters",
  "jev",
  "texts",
  "constants.ts",
  "result.ts",
]) {
  test(`refuses ascending dependency from ${layer}`, async () => {
    const path = layer.endsWith(".ts") ? layer : `${layer}/a.ts`;
    const specifier = layer.endsWith(".ts") ? "./tools/a.ts" : "../tools/a.ts";
    const result = await check({
      [path]: `export type { A } from "${specifier}";`,
      "tools/a.ts": "export interface A {}",
    });
    assert.equal(result.code, 1);
    assert.ok(
      result.output.includes(`src/${path}:1 [layer-dependency]`),
      result.output,
    );
  });
}

for (const typeOnly of [false, true]) {
  test(`refuses ${typeOnly ? "type-only" : "runtime"} cycles with file chain`, async () => {
    const result = await check({
      "core/a.ts": `export ${typeOnly ? "type " : ""}{ B } from "./b.ts";`,
      "core/b.ts": `import ${typeOnly ? "type " : ""}{ B } from "./a.ts"; export interface B {}`,
    });
    assert.equal(result.code, 1);
    assert.match(
      result.output,
      /src\/core\/b.ts:1 \[import-cycle\] core\/a.ts -> core\/b.ts -> core\/a.ts/,
    );
  });
}

test("accepts pure paths, erased native contracts and descending imports", async () => {
  const result = await check({
    "core/a.ts":
      'import { posix } from "node:path"; import type { SgNode } from "@ast-grep/napi"; import type { State } from "../jev/types.ts";',
    "jev/types.ts": "export interface State {}",
    "adapters/a.ts": 'import "node:fs"; import "../core/a.ts";',
    "presets/a.ts": 'export * from "../core/a.ts";',
    "tools/a.ts": "await import(`../adapters/a.ts`);",
    "core/comment.ts":
      '// import "node:fs";\nconst example = "import(\\"node:fs\\")";',
  });
  assert.equal(result.code, 0, result.output);
});
