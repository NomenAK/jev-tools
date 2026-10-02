import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";

const rule = readFileSync(
  new URL("../rules/jev-ask.md", import.meta.url),
  "utf8",
);
const body = rule.split("---")[2];
assert.ok(body);
const policy = body.trim();

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
test("pi refreshes guide and policy independently as active tools change", () => {
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
    jev_policy: policy,
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
