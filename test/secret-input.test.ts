import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { inspect } from "node:util";
import type { SecretKeyHelpers } from "../src/secret-input.ts";
import { MaskedSecretInput } from "../src/secret-input.ts";

// Resolve the development host's bundled dependency, just as its loader does.
// No extra TUI dependency is needed by the extension package.
const hostRequire = createRequire(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
// Development host keys are loaded dynamically because its TUI package is nested.
const hostKeys = await import(hostRequire.resolve("@earendil-works/pi-tui"));
const keys: SecretKeyHelpers = {
  matchesKey: hostKeys.matchesKey,
  isKeyRelease: hostKeys.isKeyRelease,
  decodePrintableKey: hostKeys.decodeKittyPrintable,
};

function dialog(existing = false) {
  const results: (string | undefined)[] = [];
  const input = new MaskedSecretInput(
    "Jev API key",
    existing,
    keys,
    (result) => results.push(result),
    () => {},
  );
  return { input, results };
}

function assertMasked(input: MaskedSecretInput, secret: string) {
  for (const width of [0, 1, 5, 20, 80]) {
    const lines = input.render(width);
    assert.ok(lines.every((line) => line.length <= width));
    assert.ok(lines.every((line) => /^[\x20-\x7e]*$/.test(line)));
    assert.ok(!lines.join("\n").includes(secret));
  }
  assert.ok(!inspect(input, { showHidden: true }).includes(secret));
  assert.ok(!JSON.stringify(input).includes(secret));
}

test("typing, editing and paste never render or inspect the key", () => {
  const { input, results } = dialog();
  input.handleInput("sensitive-token-123");
  assertMasked(input, "sensitive-token-123");
  input.handleInput("\x7f");
  input.handleInput("\x1b[200~pasted-part\x1b[201~");
  assertMasked(input, "pasted-part");
  input.invalidate();
  input.handleInput("\r");
  assert.deepEqual(results, ["sensitive-token-12pasted-part"]);
  assert.ok(!input.render(80).join("\n").includes("*"));
  input.handleInput("ignored-after-submit");
  input.handleInput("\r");
  assert.equal(results.length, 1);
});

test("chunked bracketed paste preserves complete content without submitting", () => {
  const { input, results } = dialog();
  const pasted = "full key with spaces-🔑-trailing ";
  input.handleInput("\x1b[200~");
  input.handleInput(pasted.slice(0, 12));
  input.handleInput(pasted.slice(12));
  input.handleInput("\x1b[20");
  assertMasked(input, "full key");
  assert.deepEqual(results, []);
  input.handleInput("1~\r");
  assert.deepEqual(results, [pasted]);
});

test("backspace removes one Unicode code point and does not leave history", () => {
  const { input, results } = dialog();
  input.handleInput("abc🔑");
  input.handleInput("\x7f");
  input.handleInput("\x1b[200~replacement\x1b[201~");
  input.handleInput("\x1a"); // No undo command.
  input.handleInput("\x19"); // No yank/kill history.
  input.handleInput("\r");
  assert.deepEqual(results, ["abcreplacement"]);
});

test("multiline or control-containing paste is rejected without changing the key", () => {
  for (const pasted of ["bad\nkey", "bad\rkey", "bad\tkey", "bad\x1b[31mkey"]) {
    const { input, results } = dialog();
    input.handleInput("original");
    input.handleInput(`\x1b[200~${pasted}\x1b[201~`);
    assert.ok(
      input.render(80).some((line) => line.startsWith("Paste rejected:")),
    );
    input.handleInput("\r");
    assert.deepEqual(results, ["original"]);
  }
});

for (const cancel of ["\x1b", "\x03", "\x1b[27u", "\x1b[99;5u"]) {
  test(`cancellation erases retained input (${JSON.stringify(cancel)})`, () => {
    const { input, results } = dialog();
    input.handleInput("cancelled-sensitive-token");
    input.handleInput(cancel);
    assert.deepEqual(results, [undefined]);
    assertMasked(input, "cancelled-sensitive-token");
    assert.ok(!input.render(80).join("\n").includes("*"));
    input.handleInput("\r");
    assert.deepEqual(results, [undefined]);
  });
}

test("disposing an incomplete paste removes retained input without submission", () => {
  const { input, results } = dialog();
  input.handleInput("\x1b[200~partially-pasted-secret\x1b[20");
  input.dispose();
  input.dispose();
  input.handleInput("1~\r");
  assertMasked(input, "partially-pasted-secret");
  assert.ok(!input.render(80).join("\n").includes("*"));
  assert.deepEqual(results, []);
});

test("empty Enter keeps an existing key but requires a new key", () => {
  const existing = dialog(true);
  existing.input.handleInput("\r");
  assert.deepEqual(existing.results, [""]);
  const fresh = dialog();
  fresh.input.handleInput("\r");
  assert.deepEqual(fresh.results, []);
  assert.ok(fresh.input.render(80).includes("A key is required."));
  fresh.input.handleInput("new-key");
  fresh.input.handleInput("\r");
  assert.deepEqual(fresh.results, ["new-key"]);
});

test("host Kitty matching supports printable, shifted, repeat and editing keys", () => {
  hostKeys.setKittyProtocolActive(true);
  const { input, results } = dialog();
  input.handleInput("\x1b[97u");
  input.handleInput("\x1b[98;1:2u");
  input.handleInput("\x1b[49:33;2u");
  input.handleInput("\x1b[127u");
  input.handleInput("\x1b[99;1:3u"); // Key release must not insert text.
  input.handleInput("\x1b[13u");
  assert.deepEqual(results, ["ab"]);
  hostKeys.setKittyProtocolActive(false);
});

test("narrow rendering strips title terminal escapes and wide characters", () => {
  const input = new MaskedSecretInput(
    "API\x1b[31m🔑",
    false,
    keys,
    () => {},
    () => {},
  );
  assert.ok(input.render(100).every((line) => /^[\x20-\x7e]*$/.test(line)));
  assert.ok(input.render(3).every((line) => line.length <= 3));
  input.dispose();
});
