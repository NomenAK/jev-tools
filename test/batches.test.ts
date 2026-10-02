import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareBatches } from "../src/core/batches.ts";
import { truncate } from "../src/core/truncate.ts";
import type { Question } from "../src/jev/types.ts";

test("Unicode truncation never cuts a valid UTF-16 pair at any budget", () => {
  const texts = [
    "",
    "abc",
    "😀",
    "a😀b",
    "😀😎𐐀",
    "a\ud800b",
    "a\udc00b",
    "a\ud800\udc00z",
  ];
  for (let length = 1; length <= 32; length++)
    texts.push("😀a𐐀é".repeat(length));
  for (const text of texts)
    for (let budget = 0; budget <= text.length + 1; budget++) {
      const result = truncate(text, budget);
      assert.ok(result.length <= budget);
      assert.equal(result, text.slice(0, result.length));
      const prefix = [...text]
        .filter(
          (_char, index, all) =>
            all.slice(0, index + 1).join("").length <= budget,
        )
        .join("");
      assert.equal(result, prefix);
      if (result.length < text.length && result.length > 0) {
        const left = text.charCodeAt(result.length - 1),
          right = text.charCodeAt(result.length);
        assert.ok(
          !(
            left >= 0xd800 &&
            left <= 0xdbff &&
            right >= 0xdc00 &&
            right <= 0xdfff
          ),
        );
      }
    }
});

test("constructed group partitions preserve every ordinary question exactly once", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const questions: Record<string, Question> = {
      w: { type: "bool", instructions: "Witness" },
    };
    const groups: string[][] = [];
    for (let g = 0; g < seed; g++) {
      const group = [];
      for (let q = 0; q < 1 + ((g + seed) % 4); q++) {
        const id = `g${g}q${q}`;
        group.push(id);
        questions[id] = {
          type: "bool",
          instructions: "x".repeat(
            1 + ((seed * 997 + g * 37 + q * 31) % 15_000),
          ),
        };
      }
      groups.push(group);
    }
    const result = prepareBatches({ text: "x".repeat(seed * 500) }, questions, {
      groups,
      witnesses: ["w"],
    });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.deepEqual(
      result.batches.flat(2).sort(),
      Object.keys(questions)
        .filter((id) => id !== "w")
        .sort(),
    );
    for (const group of groups)
      assert.equal(
        result.batches.filter((batch) =>
          group.every((id) => batch.flat().includes(id)),
        ).length,
        1,
      );
  }
});
