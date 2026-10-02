import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

type RegisteredTool = {
  name: string;
  description: string;
  loadMode?: string;
  approval?: string | ((args: { command?: string }) => string);
  defaultInactive?: boolean;
  promptSnippet?: string;
  promptGuidelines?: string[];
};
const names = [
  "jev_ask",
  "jev_ask_files",
  "jev_check_diff",
  "jev_find_files",
  "jev_locate_in_file",
  "jev_select_tests",
].sort();

const snippets: Record<string, string> = {
  jev_ask:
    "Typed answers about one situation built from a note, files and a command's output",
  jev_ask_files:
    "Typed answers about many files from intents you declare, without reading them",
  jev_check_diff:
    "Check the uncommitted diff for risky changes, stale docs or spec drift",
  jev_find_files:
    "Find the files for a goal described in plain words, ranked, with an entry point",
  jev_locate_in_file: "Find which line range of one large file serves a goal",
  jev_select_tests:
    "Pick the tests the diff can affect and the runner command for only those",
};
const guidelines: Record<string, string[]> = {
  jev_ask: [
    "jev_ask: before you conclude that a failure is a bug in the code, a wrong test or the environment, or that a plan matches the docs, pass the files to jev_ask and weigh its answer against your own reading",
  ],
  jev_ask_files: [
    "jev_ask_files: put every ask in one call; declare intents (verify, classify, rate, decide), never raw questions",
    "jev_ask_files: use it to decide what to read, then read only the files that matter",
  ],
  jev_check_diff: [
    "jev_check_diff: run it once before you report done, not on a half-written diff",
  ],
  jev_find_files: [
    "jev_find_files: describe the behavior in one sentence of five words or more, not a guessed identifier",
  ],
};

for (const omp of [false, true]) {
  test(`extension exposes all six tools with the ${omp ? "omp" : "pi"} host contract`, () => {
    const tools: RegisteredTool[] = [];
    const api = {
      ...(omp ? { pi: {} } : {}),
      on() {},
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
      async exec() {
        throw new Error("Registration must not execute commands");
      },
    };
    extension(api as unknown as ExtensionAPI & { pi?: unknown });
    assert.deepEqual(tools.map((tool) => tool.name).sort(), names);
    for (const tool of tools) {
      if (omp) {
        assert.equal(tool.loadMode, "essential", tool.name);
        if (tool.name === "jev_ask") {
          assert.equal(typeof tool.approval, "function");
          if (typeof tool.approval === "function") {
            assert.equal(tool.approval({}), "read");
            assert.equal(tool.approval({ command: "npm test" }), "exec");
          }
        } else assert.equal(tool.approval, "read", tool.name);
      } else {
        assert.equal(tool.promptSnippet, snippets[tool.name], tool.name);
        assert.deepEqual(
          tool.promptGuidelines,
          guidelines[tool.name],
          tool.name,
        );
      }
      assert.doesNotMatch(tool.description, /{{/);
    }
    if (!omp) {
      assert.equal(
        tools.filter((tool) => tool.promptSnippet !== undefined).length,
        6,
      );
      assert.equal(
        tools.filter((tool) => tool.promptGuidelines !== undefined).length,
        4,
      );
      assert.equal(
        tools.flatMap((tool) => tool.promptGuidelines ?? []).length,
        5,
      );
    }
    const find = tools.find((tool) => tool.name === "jev_find_files");
    assert.ok(find);
    assert.equal(find.defaultInactive, omp ? true : undefined);
    assert.ok(
      find.description.includes(`known names → ${omp ? "glob" : "find"}`),
    );
    const semantic = tools.find((tool) => tool.name === "jev_ask_files");
    assert.ok(semantic);
    assert.ok(
      semantic.description.includes(
        omp
          ? "find or jev_find_files, whichever is available"
          : "jev_find_files",
      ),
    );
  });
}

test("pi guideline and omp rule carry the same jev_ask policy", async () => {
  const rule = await readFile(
    new URL("../rules/jev-ask.md", import.meta.url),
    "utf8",
  );
  assert.ok(guidelines.jev_ask);
  assert.equal(rule, `---\nalwaysApply: true\n---\n${guidelines.jev_ask[0]}\n`);
});
