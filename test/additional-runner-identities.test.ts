import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { buildRunnerCommands } from "../src/core/test-commands.ts";
import { discoverTests } from "../src/core/test-discovery.ts";

for (const framework of ["mocha", "deno", "ava"] as const) {
  test(`${framework}: review regressions preserve actual selected identities`, async (t) => {
    const executable =
      process.env[`${framework.toUpperCase()}_EXECUTABLE`] ??
      (framework === "deno"
        ? "deno"
        : resolve(`node_modules/.bin/${framework}`));
    const available = spawnSync(executable, ["--version"], {
      encoding: "utf8",
    });
    if (available.error || available.status !== 0) {
      t.skip(
        `${framework} unavailable: ${available.error?.message ?? available.stderr}`,
      );
      return;
    }
    const dir = await mkdtemp(resolve(".runner-identities-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const files: { path: string; text: string }[] = [];
    if (framework === "mocha") {
      files.push(
        {
          path: "package.json",
          text: '{"scripts":{"test":"mocha tests/*.test.cjs"}}',
        },
        {
          path: ".mocharc.json",
          text: '{"ignore":["tests/excluded.test.cjs"]}',
        },
        {
          path: "tests/chosen.test.cjs",
          text: "describe('outer', () => {context('ctx', () => {it('chosen', () => console.log('IDENTITY_CHOSEN')); specify('other', () => {throw Error('POISON');}); xspecify('pending', () => {});});});",
        },
        {
          path: "tests/excluded.test.cjs",
          text: "it('excluded', () => {throw Error('EXCLUDED_POISON');});",
        },
      );
    } else if (framework === "deno") {
      files.push(
        {
          path: "deno.json",
          text: '{"exclude":["tests/excluded.test.js"],"test":{"include":["tests/*.test.js"]},"tasks":{"test":"deno test -A tests/"}}',
        },
        {
          path: "tests/chosen.test.js",
          text: "Deno.test('chosen', () => {Deno.readTextFileSync('deno.json'); console.log('IDENTITY_CHOSEN');});",
        },
        {
          path: "tests/excluded.test.js",
          text: "Deno.test('excluded', () => {throw Error('EXCLUDED_POISON');});",
        },
      );
    } else {
      const imported = JSON.stringify(
        resolve(executable, "../../ava/entrypoints/main.mjs"),
      );
      const source = `import test from ${imported}; test('chosen', t => {console.log('IDENTITY_CHOSEN'); t.pass();});`;
      files.push(
        { path: "package.json", text: '{"scripts":{"test":"ava"}}' },
        { path: "test/chosen.mjs", text: source },
        ...[
          "test/_hidden.mjs",
          "test/helpers/a.mjs",
          "test/fixtures/a.mjs",
        ].map((path) => ({ path, text: source })),
      );
    }
    for (const file of files) {
      await mkdir(dirname(join(dir, file.path)), { recursive: true });
      await writeFile(join(dir, file.path), file.text);
    }
    const discoveryFiles =
      framework === "ava"
        ? files.map((file) => ({
            ...file,
            text: file.text.replace(
              JSON.stringify(
                resolve(executable, "../../ava/entrypoints/main.mjs"),
              ),
              "'ava'",
            ),
          }))
        : files;
    const discovered = discoverTests(discoveryFiles);
    const entries = discovered.entries;
    assert.deepEqual(
      entries.map((entry) => entry.path),
      [
        framework === "ava"
          ? "test/chosen.mjs"
          : `tests/chosen.test.${framework === "mocha" ? "cjs" : "js"}`,
      ],
    );
    for (const entry of entries)
      if (framework === "mocha") entry.runnerVersion = available.stdout.trim();
    const commands = buildRunnerCommands(
      entries.map((entry) => ({
        entry,
        scenarioIds: framework === "mocha" ? ["s1"] : null,
      })),
    ).commands;
    assert.equal(commands.length, 1);
    const command = commands[0];
    assert.ok(command);
    const run = spawnSync(executable, [...command.args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.ok(`${run.stdout}\n${run.stderr}`.includes("IDENTITY_CHOSEN"));
    if (framework === "mocha") {
      for (const option of [
        "--spec=tests/excluded.test.cjs",
        "--file tests/excluded.test.cjs",
      ]) {
        const altered = files.map((file) =>
          file.path === "package.json"
            ? {
                path: file.path,
                text: JSON.stringify({
                  scripts: { test: `mocha ${option} tests/*.test.cjs` },
                }),
              }
            : file,
        );
        const result = buildRunnerCommands(
          discoverTests(altered).entries.map((entry) => ({
            entry,
            scenarioIds: null,
          })),
        );
        assert.deepEqual(result.commands, []);
        assert.ok(
          result.limits.some((limit) => limit.reason.includes("additive")),
        );
      }
      const exclusive =
        "describe('outer', () => {it('chosen', () => {throw Error('UNSELECTED');}); it.only('exclusive', () => console.log('EXCLUSIVE_IDENTITY'));});";
      await writeFile(join(dir, "tests/chosen.test.cjs"), exclusive);
      const entry = discoverTests(
        files.map((file) =>
          file.path === "tests/chosen.test.cjs"
            ? { ...file, text: exclusive }
            : file,
        ),
      ).entries[0];
      assert.ok(entry);
      entry.runnerVersion = available.stdout.trim();
      const result = buildRunnerCommands([{ entry, scenarioIds: ["s1"] }]);
      assert.ok(result.limits.some((limit) => limit.reason.includes(".only")));
      const whole = result.commands[0];
      assert.ok(whole);
      assert.equal(whole.args.includes("--grep"), false);
      const execution = spawnSync(executable, [...whole.args], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(
        execution.status,
        0,
        `${execution.stdout}\n${execution.stderr}`,
      );
      assert.ok(
        `${execution.stdout}\n${execution.stderr}`.includes(
          "EXCLUSIVE_IDENTITY",
        ),
      );
    }
    if (framework === "ava") {
      const altered = files.map((file) =>
        file.path === "package.json"
          ? {
              path: file.path,
              text: '{"scripts":{"test":"cd test && NODE_OPTIONS=--import=tsx/esm ava"}}',
            }
          : file,
      );
      assert.deepEqual(
        buildRunnerCommands(
          discoverTests(
            altered.map((file) => ({
              ...file,
              text: file.text.replace(
                JSON.stringify(
                  resolve(executable, "../../ava/entrypoints/main.mjs"),
                ),
                "'ava'",
              ),
            })),
          ).entries.map((entry) => ({ entry, scenarioIds: null })),
        ).commands,
        [],
      );
    }
  });
}
