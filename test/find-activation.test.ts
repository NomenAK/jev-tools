import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

for (const scenario of [
  { omp: true, native: false },
  { omp: true, native: true },
  { omp: false, native: false },
]) {
  test(`session_start activates discovery only in omp without native find (${JSON.stringify(scenario)})`, async () => {
    const handlers: Record<string, () => Promise<void> | void> = {};
    const active = scenario.native ? ["read", "find"] : ["read"];
    let resolveActivation: (() => void) | undefined;
    let updated: string[] | undefined;
    const barrier = new Promise<void>((resolve) => {
      resolveActivation = resolve;
    });
    const api = {
      ...(scenario.omp ? { pi: {} } : {}),
      on(name: string, handler: () => Promise<void> | void) {
        handlers[name] = handler;
      },
      registerTool() {},
      getActiveTools() {
        return active;
      },
      async setActiveTools(names: string[]) {
        updated = names;
        await barrier;
      },
      async exec() {
        throw new Error("Activation must not execute commands");
      },
    };
    extension(api as unknown as ExtensionAPI & { pi?: unknown });
    const handler = handlers.session_start;
    assert.ok(handler);
    let completed = false;
    const started = Promise.resolve(handler()).then(() => {
      completed = true;
    });
    await Promise.resolve();
    if (scenario.omp && !scenario.native) {
      assert.deepEqual(updated, ["read", "jev_find_files"]);
      assert.equal(completed, false);
      resolveActivation?.();
    } else assert.equal(updated, undefined);
    await started;
    assert.equal(completed, true);
  });
}
