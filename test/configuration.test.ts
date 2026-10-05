import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { canonicalPath } from "../src/adapters/canonical-path.ts";
import { windowsStorage } from "../src/adapters/private-storage.ts";
import { ConfigController } from "../src/configuration.ts";
import type { JevClient } from "../src/jev/types.ts";

const windows = process.platform === "win32";
// mkdir's mode is ignored on Windows; restrict the ACL like a real save does.
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  if (windows) await windowsStorage.restrictDirectory(path);
}
// Expose to other users with each platform's own permission model.
async function makePublic(path: string, mode: number): Promise<void> {
  if (windows) execFileSync("icacls", [path, "/grant", "*S-1-1-0:(R)"]);
  else await chmod(path, mode);
}
async function isPrivate(path: string, mode: number): Promise<boolean> {
  if (windows)
    return windowsStorage.isPrivate([{ path, stat: await lstat(path) }]);
  return ((await lstat(path)).mode & 0o777) === mode;
}

async function fixture(t: TestContext) {
  // Canonicalize tmpdir first: on macOS it holds a /var alias whose ancestor
  // symlink the storage check must otherwise reject.
  const root = await mkdtemp(
    join(await canonicalPath(tmpdir()), "jev-configuration-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "config");
  const requests: { authorization: string | undefined; model: unknown }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push({
      authorization: request.headers.authorization,
      model: payload.model,
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ answers: { q: { noul: 0.93 } } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    root,
    directory,
    requests,
    url: `http://127.0.0.1:${address.port}/judge`,
  };
}

async function judge(
  client: JevClient | undefined,
  source: "fresh" | "cache" = "fresh",
) {
  assert.ok(client);
  const result = await client.judge(
    { greeting: "hello" },
    { q: { type: "bool", instructions: "Is this a greeting?" } },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.answers.q, {
    type: "bool",
    p: 0.93,
    source,
  });
  return result;
}

test("initialization and cancelled setup do not create storage or call the service", async (t) => {
  const f = await fixture(t);
  const controller = new ConfigController({ env: {}, directory: f.directory });
  await controller.initialize({});
  await controller.initialize({ url: f.url, model: "ignored" });
  assert.equal(controller.client, undefined);
  assert.deepEqual(controller.values(), {
    url: "",
    apiKey: "",
    model: "openjev",
  });
  assert.deepEqual(await readdir(f.root), []);
  assert.deepEqual(f.requests, []);
  await controller.apply(
    { url: f.url, apiKey: "session-key", model: "openjev" },
    false,
  );
  await judge(controller.client);
  assert.deepEqual(f.requests, [
    { authorization: "Bearer session-key", model: "openjev" },
  ]);
  assert.deepEqual(await readdir(f.root), []);
});

test("complete environment credentials work before session initialization and are never saved", async (t) => {
  const f = await fixture(t);
  const controller = new ConfigController({
    env: {
      JEV_TOOLS_URL: f.url,
      JEV_TOOLS_API_KEY: "environment-key",
      JEV_TOOLS_MODEL: "environment-model",
    },
    directory: f.directory,
  });
  await judge(controller.client);
  assert.deepEqual(f.requests, [
    { authorization: "Bearer environment-key", model: "environment-model" },
  ]);
  await controller.initialize({});
  await controller.apply(controller.values(), true);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.directory, "config.json"), "utf8")),
    {},
  );
  const reloaded = new ConfigController({ env: {}, directory: f.directory });
  await reloaded.initialize({});
  assert.equal(reloaded.client, undefined);
});

test("environment snapshot wins per field over flags and edits without persisting environment secrets", async (t) => {
  const f = await fixture(t);
  await privateDirectory(f.directory);
  await writeFile(
    join(f.directory, "config.json"),
    JSON.stringify({
      url: "http://saved.invalid",
      apiKey: "saved-key",
      model: "saved-model",
    }),
    { mode: 0o600 },
  );
  const env = {
    JEV_TOOLS_URL: f.url,
    JEV_TOOLS_API_KEY: "environment-key",
    JEV_TOOLS_MODEL: " ",
  };
  const controller = new ConfigController({ env, directory: f.directory });
  env.JEV_TOOLS_API_KEY = "mutated-key";
  await controller.initialize({
    url: "http://flag.invalid",
    model: "flag-model",
  });
  assert.equal(controller.locked("url"), true);
  assert.equal(controller.locked("apiKey"), true);
  assert.equal(controller.locked("model"), true);
  await controller.apply(
    { url: "not a URL", apiKey: "ignored-key", model: "ignored-model" },
    true,
  );
  await judge(controller.client);
  assert.deepEqual(f.requests, [
    { authorization: "Bearer environment-key", model: "flag-model" },
  ]);
  const saved = JSON.parse(
    await readFile(join(f.directory, "config.json"), "utf8"),
  );
  assert.deepEqual(saved, {
    url: "http://saved.invalid",
    apiKey: "saved-key",
    model: "saved-model",
  });
});

test("CLI URL takes priority and editable session model replaces saved model", async (t) => {
  const f = await fixture(t);
  await privateDirectory(f.directory);
  await writeFile(
    join(f.directory, "config.json"),
    JSON.stringify({
      url: "http://saved.invalid",
      apiKey: "saved-key",
      model: "saved-model",
    }),
    { mode: 0o600 },
  );
  const controller = new ConfigController({
    env: { JEV_TOOLS_URL: "" },
    directory: f.directory,
  });
  await controller.initialize({ url: f.url, model: "" });
  assert.equal(controller.locked("url"), true);
  assert.equal(controller.locked("apiKey"), false);
  assert.equal(controller.locked("model"), false);
  await controller.apply(
    {
      url: "http://ignored.invalid",
      apiKey: "edited-key",
      model: "edited-model",
    },
    false,
  );
  await judge(controller.client);
  assert.deepEqual(f.requests, [
    { authorization: "Bearer edited-key", model: "edited-model" },
  ]);
  const reloaded = new ConfigController({ env: {}, directory: f.directory });
  await reloaded.initialize({ url: f.url });
  await judge(reloaded.client);
  assert.deepEqual(f.requests[1], {
    authorization: "Bearer saved-key",
    model: "saved-model",
  });
});

test("explicit save reloads usable credentials with private directory and file permissions", async (t) => {
  const f = await fixture(t);
  const controller = new ConfigController({ env: {}, directory: f.directory });
  await controller.initialize({});
  await controller.apply(
    { url: f.url, apiKey: "saved-key", model: "saved-model" },
    true,
  );
  assert.equal(await isPrivate(f.directory, 0o700), true);
  assert.equal(await isPrivate(join(f.directory, "config.json"), 0o600), true);
  assert.deepEqual(await readdir(f.directory), ["config.json"]);
  const reloaded = new ConfigController({ env: {}, directory: f.directory });
  await reloaded.initialize({});
  await judge(reloaded.client);
  assert.deepEqual(f.requests, [
    { authorization: "Bearer saved-key", model: "saved-model" },
  ]);
});

test("changing configuration immediately swaps clients and clears the old client's cache", async (t) => {
  const f = await fixture(t);
  const controller = new ConfigController({ env: {}, directory: f.directory });
  await controller.initialize({});
  await controller.apply(
    { url: f.url, apiKey: "first-key", model: "first-model" },
    false,
  );
  const oldClient = controller.client;
  await judge(oldClient);
  assert.equal((await judge(oldClient, "cache")).cacheHits, 1);
  assert.equal(f.requests.length, 1);
  await controller.apply(
    { url: f.url, apiKey: "second-key", model: "second-model" },
    false,
  );
  await judge(controller.client);
  await judge(oldClient);
  assert.deepEqual(f.requests, [
    { authorization: "Bearer first-key", model: "first-model" },
    { authorization: "Bearer second-key", model: "second-model" },
    { authorization: "Bearer first-key", model: "first-model" },
  ]);
});

test("partial saved configuration can be completed without overwriting it on initialization", async (t) => {
  const f = await fixture(t);
  await privateDirectory(f.directory);
  const saved = JSON.stringify({ url: f.url });
  await writeFile(join(f.directory, "config.json"), saved, { mode: 0o600 });
  const controller = new ConfigController({ env: {}, directory: f.directory });
  await controller.initialize({});
  assert.equal(controller.client, undefined);
  await controller.apply(
    { ...controller.values(), apiKey: "completed-key" },
    false,
  );
  await judge(controller.client);
  assert.deepEqual(f.requests, [
    { authorization: "Bearer completed-key", model: "openjev" },
  ]);
  assert.equal(await readFile(join(f.directory, "config.json"), "utf8"), saved);
});

for (const content of [
  "{secret-content",
  "null",
  "[]",
  '{"apiKey":17}',
  '{"unknown":"secret-content"}',
]) {
  test(`malformed saved configuration is rejected without disclosing or overwriting its content: ${content}`, async (t) => {
    const f = await fixture(t);
    await privateDirectory(f.directory);
    await writeFile(join(f.directory, "config.json"), content, { mode: 0o600 });
    const controller = new ConfigController({
      env: {},
      directory: f.directory,
    });
    await assert.rejects(controller.initialize({}), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /configuration directory/);
      assert.equal(error.message.includes("secret-content"), false);
      return true;
    });
    assert.equal(
      await readFile(join(f.directory, "config.json"), "utf8"),
      content,
    );
    assert.equal(controller.client, undefined);
  });
}

for (const scenario of [
  "directory symlink",
  "ancestor symlink",
  "file symlink",
  "public directory",
  "public file",
] as const) {
  test(`rejects ${scenario} without touching the target`, async (t) => {
    const f = await fixture(t);
    const target = join(f.root, "target");
    await privateDirectory(target);
    const content = JSON.stringify({ url: f.url, apiKey: "private-key" });
    await writeFile(join(target, "config.json"), content, { mode: 0o600 });
    let directory = f.directory;
    if (scenario === "directory symlink") {
      await symlink(target, directory);
    } else if (scenario === "ancestor symlink") {
      await symlink(target, directory);
      directory = join(directory, "nested");
    } else {
      await privateDirectory(directory);
      if (scenario === "file symlink") {
        await symlink(
          join(target, "config.json"),
          join(directory, "config.json"),
        );
      } else {
        await writeFile(join(directory, "config.json"), content, {
          mode: 0o600,
        });
        await makePublic(
          scenario === "public directory"
            ? directory
            : join(directory, "config.json"),
          0o755,
        );
      }
    }
    const controller = new ConfigController({ env: {}, directory });
    await assert.rejects(controller.initialize({}), /private/);
    assert.equal(await readFile(join(target, "config.json"), "utf8"), content);
    assert.deepEqual(await readdir(target), ["config.json"]);
  });
}

test("failed save keeps the old credentials, client and cached results intact", async (t) => {
  const f = await fixture(t);
  const controller = new ConfigController({ env: {}, directory: f.directory });
  await controller.initialize({});
  const original = {
    url: f.url,
    apiKey: "original-key",
    model: "original-model",
  };
  await controller.apply(original, true);
  const oldClient = controller.client;
  await judge(oldClient);
  const content = await readFile(join(f.directory, "config.json"), "utf8");
  await makePublic(join(f.directory, "config.json"), 0o644);
  await assert.rejects(
    controller.apply(
      { url: f.url, apiKey: "replacement-key", model: "replacement-model" },
      true,
    ),
    /private/,
  );
  assert.equal(controller.client, oldClient);
  assert.equal((await judge(controller.client, "cache")).cacheHits, 1);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(controller.values(), original);
  assert.equal(
    await readFile(join(f.directory, "config.json"), "utf8"),
    content,
  );
  assert.deepEqual(await readdir(f.directory), ["config.json"]);
});

test("invalid effective configuration reports no secret and leaves a usable client unchanged", async (t) => {
  const f = await fixture(t);
  const controller = new ConfigController({ env: {}, directory: f.directory });
  await controller.initialize({});
  await controller.apply(
    { url: f.url, apiKey: "valid-key", model: "valid-model" },
    false,
  );
  const oldClient = controller.client;
  for (const invalid of [
    { url: f.url, apiKey: "secret-key\r\nInjected: yes", model: "model" },
    {
      url: "https://user:secret-password@example.com",
      apiKey: "secret-key",
      model: "model",
    },
    { url: "file:///secret-path", apiKey: "secret-key", model: "model" },
    { url: "/secret-path", apiKey: "secret-key", model: "model" },
    { url: f.url, apiKey: " ", model: "model" },
    { url: f.url, apiKey: "secret-key", model: " " },
  ]) {
    await assert.rejects(controller.apply(invalid, true), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /full HTTP\(S\) URL/);
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
  }
  assert.equal(controller.client, oldClient);
  await judge(controller.client);
  assert.deepEqual(f.requests, [
    { authorization: "Bearer valid-key", model: "valid-model" },
  ]);
  assert.deepEqual(await readdir(f.root), []);
});
