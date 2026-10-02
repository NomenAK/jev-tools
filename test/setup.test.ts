import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfigController } from "../src/configuration.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import { Session } from "../src/session.ts";
import { Setup } from "../src/setup.ts";
import { createAskTool } from "../src/tools/ask.ts";

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "jev-setup-"));
  const config = new ConfigController({
    env,
    directory: join(directory, "settings"),
  });
  const handlers = new Map<
    string,
    (event: unknown, ctx: unknown) => Promise<void>
  >();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const flags = new Map<string, string | boolean>();
  new Setup(config, async (ctx) =>
    ctx.ui.custom(() => {
      throw new Error("The setup test replaces the terminal secret input");
    }),
  ).attach({
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      handlers.set(name, handler);
    },
    registerFlag() {},
    getFlag(name: string) {
      return flags.get(name);
    },
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI);
  let mode = "tui";
  let kind = "main";
  let hasUI = true;
  const selections: (string | undefined)[] = [];
  const inputs: (string | undefined)[] = [];
  const secrets: (string | undefined)[] = [];
  const notices: string[] = [];
  let dialogs = 0;
  const context = {
    get mode() {
      return mode;
    },
    get hasUI() {
      return hasUI;
    },
    get agent() {
      return { kind };
    },
    ui: {
      async select() {
        dialogs++;
        return selections.shift();
      },
      async input() {
        dialogs++;
        return inputs.shift();
      },
      async custom() {
        dialogs++;
        return secrets.shift();
      },
      notify(message: string) {
        notices.push(message);
      },
    },
  };
  return {
    directory,
    config,
    flags,
    selections,
    inputs,
    secrets,
    notices,
    dialogs: () => dialogs,
    mode: (next: string, ui = true) => {
      mode = next;
      hasUI = ui;
    },
    kind: (next: string) => {
      kind = next;
    },
    start: () => handlers.get("session_start")?.({}, context),
    setup: () => commands.get("jev-setup")?.handler("", context),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("missing configuration offers once, and headless, skipped and child sessions never prompt", async () => {
  const f = await fixture();
  try {
    for (const mode of ["rpc", "print", "json"]) {
      f.mode(mode);
      await f.start();
      await f.setup();
    }
    f.mode("tui", false);
    await f.start();
    f.mode("tui");
    f.kind("sub");
    await f.start();
    f.kind("main");
    f.flags.set("jev-skip-setup", true);
    await f.start();
    assert.equal(f.dialogs(), 0);
    f.flags.delete("jev-skip-setup");
    f.selections.push("Later");
    await f.start();
    await f.start();
    assert.equal(f.dialogs(), 1);
    assert.equal(f.config.client, undefined);
  } finally {
    await f.close();
  }
});

test("cancelling setup at each stage preserves the active configuration and never saves", async () => {
  const f = await fixture();
  try {
    await f.config.initialize({});
    await f.config.apply(
      {
        url: "https://existing.example/v1",
        model: "existing",
        apiKey: "existing-key",
      },
      false,
    );
    const client = f.config.client;
    const values = f.config.values();
    for (const stage of ["url", "model", "key", "save"]) {
      f.inputs.push(stage === "url" ? undefined : "https://new.example/v1");
      if (stage !== "url")
        f.inputs.push(stage === "model" ? undefined : "new-model");
      if (stage === "key" || stage === "save")
        f.secrets.push(stage === "key" ? undefined : "new-key");
      if (stage === "save") f.selections.push(undefined);
      await f.setup();
      assert.deepEqual(f.config.values(), values, stage);
      assert.equal(f.config.client, client, stage);
      await assert.rejects(
        readFile(join(f.directory, "settings", "config.json")),
        { code: "ENOENT" },
      );
    }
    assert(
      f.notices.every(
        (message) =>
          !message.includes("existing-key") && !message.includes("new-key"),
      ),
    );
  } finally {
    await f.close();
  }
});

test("setup immediately enables an already registered tool and replacement uses new credentials", async () => {
  const requests: { authorization?: string; model: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as {
      model: string;
      questions: Record<string, unknown>;
    };
    requests.push({
      authorization: request.headers.authorization,
      model: payload.model,
    });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        answers: Object.fromEntries(
          Object.keys(payload.questions).map((id) => [id, { noul: 0.99 }]),
        ),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const f = await fixture();
  const host = detectHost({});
  const tool = createAskTool({
    get client() {
      return f.config.client;
    },
    host,
    runtime: { session: new Session({}), guide: new Guide(host) },
    exec: async () => {
      throw new Error("Unexpected command");
    },
  });
  const invoke = () =>
    tool.execute(
      "setup",
      {
        state: "The invoice is paid.",
        asks: [
          {
            intent: "free",
            question: { type: "bool", instructions: "The invoice is paid." },
          },
        ],
      },
      undefined,
      undefined,
      { cwd: f.directory },
    );
  try {
    assert.match((await invoke()).content[0]?.text ?? "", /JEV_TOOLS_URL/);
    for (const [model, key] of [
      ["first-model", "first-key"],
      ["second-model", "second-key"],
    ] as const) {
      f.inputs.push(url, model);
      f.secrets.push(key);
      f.selections.push("This session only");
      await f.setup();
      const result = await invoke();
      assert.match(result.content[0]?.text ?? "", /yes/);
      assert.equal(requests.at(-1)?.model, model);
      assert.equal(requests.at(-1)?.authorization, `Bearer ${key}`);
      assert(!JSON.stringify(result).includes(key));
    }
    assert.equal(requests.length, 2);
    assert(
      f.notices.every(
        (message) =>
          !message.includes("first-key") && !message.includes("second-key"),
      ),
    );
  } finally {
    await f.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("environment values skip secret entry and launch flags apply in headless mode", async () => {
  const f = await fixture({ JEV_TOOLS_API_KEY: "env-key" });
  try {
    f.flags.set("jev-url", "https://configured.example/v1");
    f.flags.set("jev-model", "flag-model");
    f.mode("print", false);
    await f.start();
    assert.equal(f.dialogs(), 0);
    assert(f.config.client);
    f.mode("tui");
    f.selections.push("This session only");
    await f.setup();
    assert.equal(f.dialogs(), 1);
    assert.equal(f.config.values().model, "flag-model");
    assert(f.notices.every((message) => !message.includes("env-key")));
  } finally {
    await f.close();
  }
});
