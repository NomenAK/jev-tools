import assert from "node:assert/strict";
import test from "node:test";
import { createAnalysisContext } from "../src/adapters/analysis-context.ts";
import { collectProofSyntax } from "../src/adapters/ask-syntax.ts";
import { loadCallerParser } from "../src/adapters/risk-callers.ts";
import { createImportGraphBuilder } from "../src/core/imports.ts";
import { tokenize } from "../src/core/lexical.ts";
import { discoverTests } from "../src/core/test-discovery.ts";

test("source versions share parsing and lexical evidence across tool consumers", async () => {
  const parses: string[] = [];
  const lexical: string[] = [];
  const context = await createAnalysisContext({
    parsed: (path, version) => parses.push(`${path}:${version}`),
    tokenized: (path, version) => lexical.push(`${path}:${version}`),
    resolved() {},
  });
  assert.ok(context.parser);
  const source = {
    path: "sample.test.ts",
    text: 'import { test } from "node:test"; export function sample() { return 1; } test("sample", () => sample());',
  };
  const declarations = context.parser.declarations(source.path, source.text);
  assert.deepEqual(declarations.limits, []);
  assert.equal(declarations.declarations[0]?.name, "sample");
  const proof = await collectProofSyntax([source], undefined, context.parser);
  assert.ok(proof.declarations.some((entry) => entry.name === "sample"));
  const callers = await loadCallerParser(context.parser);
  assert.ok(callers?.parse(source.path, source.text));
  assert.equal(parses.length, 1);
  const discovery = discoverTests([source], undefined, context);
  assert.equal(discovery.entries[0]?.path, source.path);
  const build = createImportGraphBuilder([], new Set([source.path]), context);
  assert.deepEqual([...build([source]).edges.keys()], [source.path]);
  build([source]);
  assert.equal(lexical.length, 1);
  const changed = source.text.replace("return 1", "return 2");
  context.parser.declarations(source.path, changed);
  context.tokenize(source.path, changed);
  assert.equal(parses.length, 2);
  assert.equal(lexical.length, 2);
  assert.notEqual(parses[0], parses[1]);
  const next = await createAnalysisContext({
    parsed: (path, version) => parses.push(`${path}:${version}`),
    tokenized() {},
    resolved() {},
  });
  next.parser?.declarations(source.path, source.text);
  assert.equal(parses.length, 3);
});

test("Python import closure is independent of previously cached JavaScript tokens", async () => {
  const context = await createAnalysisContext();
  const source = {
    path: "test_money.py",
    text: '"""Module documentation with a quote " inside."""\nfrom pkg.money import money\n',
  };
  context.tokenize(source.path, source.text, false);
  const build = createImportGraphBuilder(
    [],
    new Set([source.path, "pkg/money.py"]),
    context,
  );
  assert.deepEqual(build([source]).edges.get(source.path), ["pkg/money.py"]);
});

test("comment markers follow the source language", () => {
  const javascript = tokenize(
    "class Wallet { #money = 1; spend() { return this.#money; } } // ignored",
    false,
  );
  assert.equal(javascript.filter((token) => token.value === "money").length, 2);
  assert.ok(!javascript.some((token) => token.value === "ignored"));
  const python = tokenize("value = 9 // divisor # ignored", true);
  assert.ok(python.some((token) => token.value === "divisor"));
  assert.ok(!python.some((token) => token.value === "ignored"));
});
