import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { replaceInstructionBlock } from "../scripts/generate-instructions.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";

function fakeHost() {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const api = {
    on(name: string, handler: (event: unknown) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as Pick<ExtensionAPI, "on">;
  return {
    api,
    emit(name: string, event: unknown = {}) {
      handlers.get(name)?.(event);
    },
  };
}
test("omp delivers once, then redelivers after compaction", () => {
  const host = fakeHost();
  const guide = new Guide(detectHost({ pi: {} }));
  guide.attach(host.api);
  const delivered: string[] = [];
  const event = {
    systemPromptOptions: { selectedTools: ["jev_ask"], sections: {} },
  };
  host.emit("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.sections, {});
  const ctx = {
    addAdditionalContext(text: string) {
      delivered.push(text);
    },
  };
  guide.deliver(ctx);
  guide.deliver(ctx);
  assert.deepEqual(delivered, [guide.text]);
  host.emit("session_compact");
  guide.deliver(ctx);
  assert.deepEqual(delivered, [guide.text, guide.text]);
});
test("pi refreshes the guide as active tools change", () => {
  const host = fakeHost();
  const guide = new Guide(detectHost({}));
  guide.attach(host.api);
  const event = {
    systemPromptOptions: {
      selectedTools: ["jev_ask"],
      sections: { other: "kept" } as Record<string, string>,
    },
  };
  host.emit("before_agent_start", event);
  host.emit("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.sections, {
    other: "kept",
    jev_guide: guide.text,
  });
  event.systemPromptOptions.selectedTools = ["jev_find_files"];
  host.emit("session_compact");
  host.emit("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.sections, {
    other: "kept",
    jev_guide: guide.text,
  });
  event.systemPromptOptions.selectedTools = ["read"];
  host.emit("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.sections, { other: "kept" });
});

test("generation refuses ambiguous markers and preserves surrounding host documentation", () => {
  const start = "<!-- BEGIN GENERATED JEV INSTRUCTIONS -->";
  const end = "<!-- END GENERATED JEV INSTRUCTIONS -->";
  const document = `before\n${start}\nold\n${end}\nafter`;
  const generated = replaceInstructionBlock(document, "policy\n");
  assert.ok(generated.startsWith("before\n"));
  assert.ok(generated.endsWith(`${end}\nafter`));
  assert.equal(replaceInstructionBlock(generated, "policy\n"), generated);
  for (const malformed of [
    "no markers",
    `${end}\n${start}`,
    `${document}\n${start}`,
    `${document}\n${end}`,
  ]) {
    assert.throws(() => replaceInstructionBlock(malformed, "policy\n"));
  }
});
