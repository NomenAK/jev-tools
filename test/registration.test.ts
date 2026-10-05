import assert from "node:assert/strict";
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

for (const omp of [false, true]) {
  test(`extension exposes all six tools with the ${omp ? "omp" : "pi"} host contract`, () => {
    const tools: RegisteredTool[] = [];
    const api = {
      ...(omp ? { pi: {} } : {}),
      on() {},
      registerFlag() {},
      registerCommand() {},
      getFlag() {
        return undefined;
      },
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
        assert.equal(typeof tool.promptSnippet, "string", tool.name);
        assert.ok(tool.promptSnippet?.length, tool.name);
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
