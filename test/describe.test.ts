import assert from "node:assert/strict";
import { test } from "node:test";
import { interpolate } from "../src/describe.ts";
import { detectHost } from "../src/host.ts";
import { ASK_DESCRIPTION } from "../src/texts/ask.ts";
import { NOT_CONFIGURED } from "../src/texts/configuration.ts";

for (const api of [{}, { pi: {} }]) {
  const host = detectHost(api);
  for (const [name, text] of Object.entries({
    ASK_DESCRIPTION,
    NOT_CONFIGURED,
  })) {
    test(`${name}: resolved interpolation in ${host.isOmp ? "omp" : "pi"}`, () => {
      assert.doesNotMatch(interpolate(text, host.names), /\{\{/);
    });
  }
  test(`unknown and malformed placeholders fail in ${host.isOmp ? "omp" : "pi"}`, () => {
    assert.throws(
      () => interpolate("{{UNKNOWN}}", host.names),
      /Unknown description interpolation/,
    );
    assert.throws(
      () => interpolate("{{names.grep", host.names),
      /Unresolved description interpolation/,
    );
  });
}
