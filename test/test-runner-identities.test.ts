import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { installedRunnerVersion } from "../src/adapters/runner-version.ts";
import { buildRunnerCommands } from "../src/core/test-commands.ts";
import { discoverTests } from "../src/core/test-discovery.ts";

const sources = {
  vitest: `import { test, describe } from 'vitest';
    describe('outer', () => {
      test('chosen (a+b)[x]', () => { console.log('IDENTITY_CHOSEN'); });
      test('poison', () => { throw new Error('IDENTITY_POISON'); });
    });`,
  jest: `describe('outer', () => {
      test('chosen (a+b)[x]', () => { console.log('IDENTITY_CHOSEN'); });
      test('poison', () => { throw new Error('IDENTITY_POISON'); });
    });`,
  node: `import test from 'node:test';
    test({name: 'chosen (a+b)[x]'}, () => { console.log('IDENTITY_CHOSEN'); });
    test(function poison() { throw new Error('IDENTITY_POISON'); });`,
  pytest: `class TestCases:
    def test_chosen(self):
        print('IDENTITY_CHOSEN')
    def test_poison(self):
        raise AssertionError('IDENTITY_POISON')
`,
  bun: `import { test, describe } from 'bun:test';
    describe('outer', () => {
      test('chosen (a+b)[x]', () => { console.log('IDENTITY_CHOSEN'); });
      test('poison', () => { throw new Error('IDENTITY_POISON'); });
    });`,
};

for (const framework of ["vitest", "jest", "node", "pytest", "bun"] as const) {
  test(`${framework}: generated command executes the selected identity, never the poison`, async (t) => {
    const executable =
      framework === "node"
        ? process.execPath
        : framework === "pytest"
          ? "python"
          : framework === "bun"
            ? "bun"
            : resolve(`node_modules/.bin/${framework}`);
    const available = spawnSync(
      executable,
      framework === "pytest" ? ["-m", "pytest", "--version"] : ["--version"],
      { encoding: "utf8" },
    );
    if (available.error || available.status !== 0) {
      t.skip(
        `${framework} unavailable: ${available.error?.message ?? available.stderr.trim()}`,
      );
      return;
    }
    // Keep fixtures beneath this project's node_modules resolution path for JS runners.
    const dir = await mkdtemp(resolve(".runner-identities-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path =
      framework === "pytest"
        ? "test_identity.py"
        : framework === "jest"
          ? "identity.test.cjs"
          : "identity.test.mjs";
    const text = sources[framework];
    await writeFile(join(dir, path), text);
    const files = [
      { path, text },
      {
        path: "package.json",
        text: JSON.stringify({ devDependencies: { [framework]: "1" } }),
      },
    ];
    if (framework === "jest") {
      await writeFile(
        join(dir, "jest.config.cjs"),
        "module.exports = {testRegex: 'identity.test.cjs'};",
      );
      files.push({
        path: "jest.config.cjs",
        text: "module.exports = {testRegex: 'identity.test.cjs'};",
      });
    }
    const entry = discoverTests(files).entries[0];
    assert.ok(entry, "fixture must be discovered");
    if (framework === "vitest" || framework === "jest") {
      const version = await installedRunnerVersion(
        process.cwd(),
        ".",
        framework,
      );
      assert.ok(version);
      entry.runnerVersion = version;
    }
    const chosen = entry.scenarios.find((scenario) =>
      scenario.name.includes("chosen"),
    );
    assert.ok(chosen, "chosen native identity must be discovered");
    const command = buildRunnerCommands([{ entry, scenarioIds: [chosen.id] }])
      .commands[0];
    assert.ok(command);
    const args = [...command.args];
    if (framework === "jest")
      args.push("--runInBand", "--json", "--outputFile=report.json");
    if (framework === "vitest")
      args.push("--reporter=json", "--outputFile=report.json");
    if (framework === "pytest") args.push("-s", "--junitxml=report.xml");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(executable, args, {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(
      run.status,
      0,
      `${run.error?.message ?? ""}\n${run.stdout}\n${run.stderr}`,
    );
    if (framework === "jest" || framework === "vitest") {
      const report = JSON.parse(
        await readFile(join(dir, "report.json"), "utf8"),
      ) as {
        testResults: {
          assertionResults: { fullName: string; status: string }[];
        }[];
      };
      const passed = report.testResults
        .flatMap((result) => result.assertionResults)
        .filter((result) => result.status === "passed");
      assert.deepEqual(
        passed.map((result) => result.fullName),
        ["outer chosen (a+b)[x]"],
      );
    } else {
      assert.ok(
        run.stdout.includes("IDENTITY_CHOSEN"),
        `${run.stdout}\n${run.stderr}`,
      );
      assert.equal(
        `${run.stdout}\n${run.stderr}`.includes("IDENTITY_POISON"),
        false,
      );
      if (framework === "pytest") {
        const report = await readFile(join(dir, "report.xml"), "utf8");
        assert.ok(report.includes('name="test_chosen"'));
        assert.equal(report.includes('name="test_poison"'), false);
      }
    }
  });
}

for (const major of [4, 5]) {
  test(`Vitest ${major}: verified separator executes the chosen identity`, async (t) => {
    const executable = process.env[`VITEST${major}_EXECUTABLE`];
    if (!executable) {
      t.skip(
        `Vitest ${major} isolated runner unavailable (VITEST${major}_EXECUTABLE)`,
      );
      return;
    }
    const available = spawnSync(executable, ["--version"], {
      encoding: "utf8",
    });
    if (available.status !== 0) {
      t.skip(`Vitest ${major} unavailable: ${available.stderr}`);
      return;
    }
    const dir = await mkdtemp(resolve(".runner-identities-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    // Absolute import uses the isolated installation, avoiding Vitest 3's runtime.
    const source = sources.vitest.replace(
      "'vitest'",
      JSON.stringify(resolve(executable, "../../vitest/dist/index.js")),
    );
    await writeFile(join(dir, "identity.test.mjs"), source);
    const entry = discoverTests([
      { path: "identity.test.mjs", text: sources.vitest },
    ]).entries[0];
    assert.ok(entry);
    entry.runnerVersion = available.stdout.match(
      /vitest\/(\d+\.\d+\.\d+)/,
    )?.[1];
    const chosen = entry.scenarios.find((s) => s.name.includes("chosen"));
    assert.ok(chosen);
    const command = buildRunnerCommands([{ entry, scenarioIds: [chosen.id] }])
      .commands[0];
    assert.ok(command);
    const run = spawnSync(
      executable,
      [...command.args, "--reporter=json", "--outputFile=report.json"],
      { cwd: dir, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const report = JSON.parse(
      await readFile(join(dir, "report.json"), "utf8"),
    ) as {
      testResults: {
        assertionResults: { fullName: string; status: string }[];
      }[];
    };
    assert.deepEqual(
      report.testResults
        .flatMap((r) => r.assertionResults)
        .filter((r) => r.status === "passed")
        .map((r) => r.fullName),
      ["outer chosen (a+b)[x]"],
    );
  });
}

for (const framework of ["ava", "mocha", "deno"] as const) {
  test(`${framework}: generated command proves its selected identities`, async (t) => {
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
    const path = "identity.test.mjs";
    const text =
      framework === "ava"
        ? `import test from ${JSON.stringify(resolve(executable, "../../ava/entrypoints/main.mjs"))}; test('chosen', t => {console.log('IDENTITY_CHOSEN'); t.pass();}); test('other', t => {console.log('IDENTITY_OTHER'); t.pass();});`
        : framework === "mocha"
          ? "describe('outer', () => {it('chosen (a+b)[x]', () => {console.log('IDENTITY_CHOSEN');}); it('other', () => {console.log('IDENTITY_OTHER');});});"
          : "Deno.test('chosen', () => {console.log('IDENTITY_CHOSEN');}); Deno.test('other', () => {console.log('IDENTITY_OTHER');});";
    await writeFile(join(dir, path), text);
    const entry = discoverTests([
      { path, text },
      {
        path: "package.json",
        text: JSON.stringify({
          scripts: {
            test: `${framework}${framework === "deno" ? " test" : ""} ${path}`,
          },
        }),
      },
    ]).entries[0];
    assert.ok(entry);
    if (framework === "mocha") entry.runnerVersion = available.stdout.trim();
    const command = buildRunnerCommands([{ entry, scenarioIds: ["s1"] }])
      .commands[0];
    assert.ok(command);
    const run = spawnSync(executable, [...command.args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const output = `${run.stdout}\n${run.stderr}`;
    assert.ok(output.includes("IDENTITY_CHOSEN"), output);
    assert.equal(
      output.includes("IDENTITY_OTHER"),
      framework !== "mocha" || entry.runnerVersion !== "11.8.0",
    );
  });
}
