import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { collectRiskCallers } from "../src/adapters/risk-callers.ts";
import type { GitExec } from "../src/core/git.ts";
import type { EvidenceUnit } from "../src/core/units.ts";

const execute = promisify(execFile);
const exec: GitExec = async (command, args, options) => {
  try {
    return {
      ...(await execute(command, args, options)),
      code: 0,
      killed: false,
    };
  } catch (error) {
    const result = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
    };
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.message,
      code: typeof result.code === "number" ? result.code : 2,
      killed: result.killed ?? false,
    };
  }
};
const before = "export function deliver(client) { return client.get(); }";
const after = "export function deliver(client) { return client.fetch(); }";
const unit: EvidenceUnit = {
  id: "u001",
  kind: "function",
  file: "src/dispatch.ts",
  name: "deliver",
  exported: true,
  before,
  after,
  beforeRange: { start: 1, end: 1 },
  afterRange: { start: 1, end: 1 },
};
async function fixture(t: test.TestContext, files: Record<string, string>) {
  const cwd = await mkdtemp(join(tmpdir(), "risk-callers-adapter-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await execute("git", ["init", "-q"], { cwd });
  for (const [path, text] of Object.entries({
    "src/dispatch.ts": before,
    ...files,
  })) {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), text);
  }
  await execute("git", ["add", "."], { cwd });
  await execute(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd },
  );
  await writeFile(join(cwd, "src/dispatch.ts"), after);
  return cwd;
}
const caller =
  "import { deliver as send } from './dispatch.js';\nconst provider = { get() { return 1; } };\nexport function run() { return send(provider); }";

test("nested cwd finds unchanged callers outside that subtree", async (t) => {
  const cwd = await fixture(t, {
    "src/caller.ts": caller,
    "nested/keep.ts": "export const keep = true;",
  });
  const result = await collectRiskCallers(exec, { cwd: join(cwd, "nested") }, [
    unit,
  ]);
  assert.equal(result.proofs.length, 1);
  assert.ok(
    result.proofs[0]?.paths.some((span) => span.path === "src/caller.ts"),
  );
});

test("ESM runtime extensions resolve aliased imported TypeScript providers", async (t) => {
  for (const [runtime, source] of [
    ["js", "ts"],
    ["jsx", "tsx"],
    ["mjs", "mts"],
    ["cjs", "cts"],
  ]) {
    const cwd = await fixture(t, {
      "src/caller.ts": `import { deliver as send } from './dispatch.js';\nimport { Client as Service } from './provider.${runtime}';\nexport function run() { return send(new Service()); }`,
      [`src/provider.${source}`]: "export class Client { get() { return 1; } }",
    });
    const result = await collectRiskCallers(exec, { cwd }, [unit]);
    assert.equal(result.proofs.length, 1, runtime);
    assert.match(JSON.stringify(result.proofs[0]?.state), /class Client.*get/);
    assert.ok(
      result.proofs[0]?.paths.some(
        (span) => span.path === `src/provider.${source}`,
      ),
    );
  }
});

test("unavailable rg falls back to git and ignores untracked callers", async (t) => {
  const cwd = await fixture(t, { "src/caller.ts": caller });
  await writeFile(join(cwd, "src/untracked.ts"), caller);
  const unavailable: GitExec = async (command, args, options) => {
    if (command === "rg") throw new Error("spawn rg ENOENT");
    return exec(command, args, options);
  };
  const result = await collectRiskCallers(unavailable, { cwd }, [unit]);
  assert.equal(result.proofs.length, 1);
  assert.ok(
    result.proofs[0]?.paths.some((span) => span.path === "src/caller.ts"),
  );
  assert.ok(
    !result.proofs[0]?.paths.some((span) => span.path === "src/untracked.ts"),
  );
});

test("before-only caller is found even when the worktree removed its target name", async (t) => {
  const cwd = await fixture(t, { "src/caller.ts": caller });
  await writeFile(
    join(cwd, "src/caller.ts"),
    "export function run() { return 1; }",
  );
  const result = await collectRiskCallers(exec, { cwd }, [unit]);
  assert.equal(result.proofs.length, 0);
  assert.ok(
    result.limits.some(
      (limit) =>
        limit.kind === "binding_unknown" &&
        limit.paths.includes("src/caller.ts") &&
        limit.missing === "unique coordinated after call",
    ),
  );
});

test("sparse tracked absence preserves prior evidence and does not fail worktree search", async (t) => {
  const cwd = await fixture(t, {
    "src/caller.ts": caller,
    "sparse/absent.ts": "export const absent = true;",
  });
  await execute(
    "git",
    ["update-index", "--skip-worktree", "sparse/absent.ts"],
    { cwd },
  );
  await rm(join(cwd, "sparse/absent.ts"));
  const result = await collectRiskCallers(exec, { cwd }, [unit]);
  assert.equal(result.proofs.length, 1);
  assert.ok(!result.limits.some((limit) => limit.kind === "unreadable"));
});

test("sparse missing caller remains an explicit prior-binding limitation", async (t) => {
  const cwd = await fixture(t, { "src/caller.ts": caller });
  await execute("git", ["update-index", "--skip-worktree", "src/caller.ts"], {
    cwd,
  });
  await rm(join(cwd, "src/caller.ts"));
  const result = await collectRiskCallers(exec, { cwd }, [unit]);
  assert.equal(result.proofs.length, 0);
  assert.ok(
    result.limits.some(
      (limit) =>
        limit.kind === "caller_missing" &&
        limit.paths.includes("src/caller.ts") &&
        limit.missing === "complete after caller",
    ),
  );
  assert.ok(!result.limits.some((limit) => limit.kind === "unreadable"));
});

test("changed imported provider is read on both sides instead of reused", async (t) => {
  const cwd = await fixture(t, {
    "src/caller.ts":
      "import { deliver } from './dispatch.js';\nimport { Client } from './provider.js';\nexport function run() { return deliver(new Client()); }",
    "src/provider.ts": "export class Client { get() { return 1; } }",
  });
  await writeFile(
    join(cwd, "src/provider.ts"),
    "export class Client { fetch() { return 1; } }",
  );
  const result = await collectRiskCallers(exec, { cwd }, [unit]);
  assert.equal(result.proofs.length, 1);
  const state = JSON.stringify(result.proofs[0]?.state);
  assert.match(state, /class Client.*get/);
  assert.match(state, /class Client.*fetch/);
});

test("failed prior search stays visibly unreadable", async (t) => {
  const cwd = await fixture(t, { "src/caller.ts": caller });
  const failure: GitExec = async (command, args, options) => {
    if (command === "git" && args[0] === "grep" && args.includes("HEAD"))
      return {
        stdout: "",
        stderr: "cannot read comparison tree",
        code: 2,
        killed: false,
      };
    return exec(command, args, options);
  };
  const result = await collectRiskCallers(failure, { cwd }, [unit]);
  assert.equal(result.proofs.length, 0);
  assert.ok(result.limits.some((limit) => limit.kind === "unreadable"));
});

for (const side of ["before", "after"]) {
  test(`invalid UTF-8 ${side} caller stays unchecked`, async (t) => {
    const cwd = await fixture(t, { "src/caller.ts": caller });
    await writeFile(
      join(cwd, "src/caller.ts"),
      Buffer.concat([Buffer.from(caller), Buffer.from([0xe9])]),
    );
    if (side === "before") {
      await execute("git", ["add", "src/caller.ts"], { cwd });
      await execute(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-qm",
          "invalid caller",
        ],
        { cwd },
      );
      await writeFile(join(cwd, "src/caller.ts"), caller);
    }
    const result = await collectRiskCallers(exec, { cwd }, [unit]);
    assert.equal(result.proofs.length, 0);
    assert.ok(
      result.limits.some(
        (limit) =>
          JSON.stringify(limit).includes("not UTF-8 text") &&
          JSON.stringify(limit).includes("src/caller.ts"),
      ),
    );
  });
}
test("BOM and multibyte UTF-8 callers remain eligible", async (t) => {
  const cwd = await fixture(t, {
    "src/caller.ts": `\uFEFF${caller}\n// café 😀\r\n`,
  });
  const result = await collectRiskCallers(exec, { cwd }, [unit]);
  assert.equal(result.proofs.length, 1);
  assert.ok(
    result.proofs[0]?.paths.some((span) => span.path === "src/caller.ts"),
  );
});
