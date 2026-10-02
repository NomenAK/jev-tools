import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  attachRunnerVersions,
  installedRunnerVersion,
} from "../src/adapters/runner-version.ts";
import { lockedRunnerVersion } from "../src/core/runner-version.ts";
import { buildRunnerCommands } from "../src/core/test-commands.ts";
import { discoverTests } from "../src/core/test-discovery.ts";

test("installed runner metadata stays inside repository including pnpm links", async (t) => {
  const root = await mkdtemp(resolve(".runner-version-"));
  const external = await mkdtemp(resolve(".runner-external-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  });
  await mkdir(join(root, "node_modules/.pnpm/vitest/node_modules/vitest"), {
    recursive: true,
  });
  await writeFile(
    join(root, "node_modules/.pnpm/vitest/node_modules/vitest/package.json"),
    '{"version":"3.2.7"}',
  );
  await symlink(
    ".pnpm/vitest/node_modules/vitest",
    join(root, "node_modules/vitest"),
  );
  assert.equal(await installedRunnerVersion(root, ".", "vitest"), "3.2.7");
  await writeFile(join(external, "package.json"), '{"version":"30.4.2"}');
  await symlink(external, join(root, "node_modules/jest"));
  assert.equal(await installedRunnerVersion(root, ".", "jest"), undefined);
  assert.equal(await installedRunnerVersion(root, "../", "vitest"), undefined);
});

test("runner metadata FIFOs are rejected without waiting for a writer", async (t) => {
  const root = await mkdtemp(resolve(".runner-fifo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "node_modules/vitest"), { recursive: true });
  const created = spawnSync("mkfifo", [
    join(root, "node_modules/vitest/package.json"),
  ]);
  if (created.error) {
    t.skip(`mkfifo unavailable: ${created.error.message}`);
    return;
  }
  assert.equal(created.status, 0);
  assert.equal(await installedRunnerVersion(root, ".", "vitest"), undefined);
});

test("resolved locks identify versions without accepting dependency ranges", () => {
  for (const [path, text] of [
    [
      "package-lock.json",
      '{"packages":{"node_modules/vitest":{"version":"3.2.7"}}}',
    ],
    [
      "pnpm-lock.yaml",
      "importers:\n  .:\n    devDependencies:\n      vitest:\n        specifier: ^3.2.0\n        version: 3.2.7(@types/node@24.0.0)\n",
    ],
    [
      "yarn.lock",
      'vitest@^3.2.0:\n  version "3.2.7"\n  resolved "https://example.invalid"\n',
    ],
    ["bun.lock", '{"packages":{"vitest":["vitest@3.2.7", "", {}]}}'],
  ] as const)
    assert.equal(lockedRunnerVersion("vitest", path, text), "3.2.7");
  assert.equal(
    lockedRunnerVersion(
      "vitest",
      "package-lock.json",
      '{"dependencies":{"vitest":{"version":"^3.2.7"}}}',
    ),
    undefined,
  );
});

test("unknown and unverified versions run whole files with an explicit limit", async () => {
  const fixture = discoverTests([
    {
      path: "a.test.ts",
      text: "import {test} from 'vitest'; test('chosen',()=>{}); test('other',()=>{});",
    },
  ]).entries[0];
  assert.ok(fixture);
  for (const version of [undefined, "4.0.0", "2.1.9"]) {
    const entry = {
      ...fixture,
      ...(version ? { runnerVersion: version } : {}),
    };
    const commands = buildRunnerCommands([{ entry, scenarioIds: ["s1"] }]);
    assert.equal(commands.commands[0]?.args.includes("-t"), false);
    assert.ok(
      commands.limits.some(
        (limit) =>
          limit.reason ===
          `name filter skipped: vitest ${version ?? "unknown"} not verified`,
      ),
    );
  }
  const root = await mkdtemp(resolve(".runner-lock-"));
  try {
    const entries = await attachRunnerVersions(
      root,
      [fixture],
      async (path) =>
        path === "package-lock.json"
          ? { text: '{"packages":{"node_modules/vitest":{"version":"3.2.7"}}}' }
          : undefined,
      new Set(["package-lock.json"]),
    );
    assert.equal(entries[0]?.runnerVersion, "3.2.7");
    const resolved = entries[0];
    assert.ok(resolved);
    assert.equal(
      buildRunnerCommands([
        { entry: resolved, scenarioIds: ["s1"] },
      ]).commands[0]?.args.includes("-t"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
