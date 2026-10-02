import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { captureCommand } from "../src/adapters/command.ts";
import type { GitExec } from "../src/core/git.ts";
import { Guide } from "../src/guide.ts";
import { detectHost } from "../src/host.ts";
import type { Answer, JevClient, State } from "../src/jev/types.ts";
import { Session } from "../src/session.ts";
import { createAskTool } from "../src/tools/ask.ts";
import { createAskFilesTool } from "../src/tools/ask-files.ts";
import { createCheckDiffTool } from "../src/tools/check-diff.ts";
import { createFindFilesTool } from "../src/tools/find.ts";
import { createLocateTool } from "../src/tools/locate.ts";
import { createSelectTestsTool } from "../src/tools/select-tests.ts";

const run = promisify(execFile);
const exec: GitExec = async (binary, args, options) => {
  try {
    const result = await run(binary, args, options);
    return { ...result, code: 0, killed: false };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: failure.code ?? 1,
      killed: failure.killed ?? false,
    };
  }
};
const asks = {
  intent: "free" as const,
  question: {
    type: "bool" as const,
    instructions: "Does the admitted source calculate an invoice total?",
  },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jev-confinement-"));
  const cwd = join(root, "repo");
  const id = randomUUID();
  const forbidden = [`OUTSIDE_${id}`, `IGNORED_${id}`, `GIT_CONFIG_${id}`];
  const admitted = `ADMITTED_${id}`;
  const dependency = `DEPENDENCY_${id}`;
  const before = `BEFORE_${id}`;
  const spec = `SPEC_${id}`;
  const deleted = `DELETED_${id}`;
  const historical = `HISTORICAL_${id}`;
  const newlyIgnored = `HISTORICAL_RECLASSIFIED_${id}`;
  const testEvidence = `TEST_EVIDENCE_${id}`;
  await mkdir(cwd);
  await mkdir(join(root, "outside"));
  await mkdir(join(cwd, "test"));
  await mkdir(join(cwd, "docs"));
  await mkdir(join(cwd, "replaced-directory"));
  await mkdir(join(root, "outside", "replaced-directory"));
  await writeFile(
    join(cwd, "deleted.ts"),
    `export function removedInvoice() { return '${deleted}'; }\n`,
  );
  await writeFile(
    join(cwd, "replaced-directory", "invoice.ts"),
    `export function historicalInvoice() { return '${historical}'; }\n`,
  );
  await writeFile(
    join(cwd, "newly-ignored.ts"),
    `export function historicalIgnoredInvoice() { return '${newlyIgnored}'; }\n`,
  );
  await writeFile(
    join(root, "outside", "replaced-directory", "invoice.ts"),
    `export function historicalInvoice() { return '${forbidden[0]}'; }\n`,
  );
  await writeFile(
    join(root, "outside", "second-secret.ts"),
    `export const secret = '${forbidden[0]}';\n`,
  );
  await writeFile(
    join(root, "outside", "secret.ts"),
    `export const secret = '${forbidden[0]}';\n`,
  );
  await writeFile(
    join(root, "outside", "secret.test.js"),
    `import {test} from 'node:test'; test('${forbidden[0]}',()=>{});\n`,
  );
  await writeFile(
    join(cwd, ".gitignore"),
    "secret.ts\nsecret.md\nsecret.test.js\n",
  );
  await writeFile(
    join(cwd, "secret.ts"),
    `export const secret = '${forbidden[1]}';\n`,
  );
  await writeFile(join(cwd, "secret.md"), `# Private\n${forbidden[1]}\n`);
  await writeFile(
    join(cwd, "secret.test.js"),
    `import {test} from 'node:test'; test('${forbidden[1]}',()=>{});\n`,
  );
  await writeFile(
    join(cwd, "dependency.ts"),
    `export const dependency = '${dependency}';\n`,
  );
  const imports = [
    "./dependency",
    "../outside/secret",
    join(root, "outside", "secret"),
    "./secret",
    "./file-link",
    "./dir-link/secret",
    "./.git/config",
  ];
  const source = (marker: string) =>
    `${imports.map((path, index) => `import { ${index === 0 ? "dependency" : "secret"} as value${index} } from ${JSON.stringify(path)};`).join("\n")}\nexport function invoice() { return '${marker}' + ${imports.map((_, index) => `value${index}`).join(" + ")}; }\n`;
  await writeFile(join(cwd, "invoice.ts"), source(before));
  await writeFile(
    join(cwd, "test", "invoice.test.js"),
    `import {test} from 'node:test'; import {invoice} from '../invoice.ts'; test('invoice total ${testEvidence}',()=>invoice());\n`,
  );
  await writeFile(
    join(cwd, "docs", "invoice.md"),
    `# Invoice\nThe invoice() function in invoice.ts calculates the invoice total. ${admitted}\n`,
  );
  await writeFile(
    join(cwd, "SPEC.md"),
    `# Invoice requirements\n### REQ-001 Invoice total\nThe invoice() function must calculate the invoice total. ${spec}\n`,
  );
  await writeFile(
    join(cwd, "large.md"),
    Array.from(
      { length: 6 },
      (_, i) =>
        `# Invoice section ${i}\n${(`${admitted} invoice total evidence ${i} ${"x".repeat(320)}\n`).repeat(10)}`,
    ).join("\n"),
  );
  await symlink(join(root, "outside", "secret.ts"), join(cwd, "file-link.ts"));
  await symlink(join(root, "outside"), join(cwd, "dir-link"));
  await symlink(join(cwd, "secret.ts"), join(cwd, "ignored-link.ts"));
  await symlink(join(cwd, "dependency.ts"), join(cwd, "admitted-link.ts"));
  await exec("git", ["init", "-q"], { cwd, timeout: 10000 });
  await symlink(join(cwd, ".git"), join(cwd, "git-link"));
  await exec("git", ["add", "."], { cwd, timeout: 10000 });
  const commit = await exec(
    "git",
    [
      "-c",
      "user.name=Confinement",
      "-c",
      "user.email=confinement@example.invalid",
      "commit",
      "-qm",
      "base",
    ],
    { cwd, timeout: 10000 },
  );
  assert.equal(commit.code, 0, commit.stderr);
  await appendFile(join(cwd, ".git", "config"), `\n# ${forbidden[2]}\n`);
  await writeFile(join(cwd, "invoice.ts"), source(admitted));
  await rm(join(cwd, "deleted.ts"));
  await rm(join(cwd, "file-link.ts"));
  await symlink(
    join(root, "outside", "second-secret.ts"),
    join(cwd, "file-link.ts"),
  );
  await rm(join(cwd, "replaced-directory"), { recursive: true });
  await symlink(
    join(root, "outside", "replaced-directory"),
    join(cwd, "replaced-directory"),
  );
  await appendFile(join(cwd, ".gitignore"), "newly-ignored.ts\n");
  const untrack = await exec("git", ["rm", "--cached", "newly-ignored.ts"], {
    cwd,
    timeout: 10000,
  });
  assert.equal(untrack.code, 0, untrack.stderr);
  await writeFile(
    join(cwd, "newly-ignored.ts"),
    `export function historicalIgnoredInvoice() { return '${forbidden[1]}'; }\n`,
  );
  const blocked = [
    "..",
    "../outside/secret.ts",
    join(root, "outside", "secret.ts"),
    join(root, "outside"),
    "../*",
    "file-link.ts",
    "dir-link/secret.ts",
    "dir-link/*",
    "replaced-directory/invoice.ts",
    "replaced-directory/*",
    "newly-ignored.ts",
    "ignored-link.ts",
    "secret.ts",
    ".git/config",
    "git-link/config",
    "git-link/*",
  ];
  return {
    root,
    cwd,
    forbidden,
    admitted,
    dependency,
    before,
    spec,
    deleted,
    historical,
    newlyIgnored,
    testEvidence,
    blocked,
  };
}

interface Fixture {
  root: string;
  cwd: string;
  forbidden: string[];
  admitted: string;
  dependency: string;
  before: string;
  spec: string;
  deleted: string;
  historical: string;
  newlyIgnored: string;
  testEvidence: string;
  blocked: string[];
}
function recorder(f: Fixture) {
  const states: string[] = [];
  const client: JevClient = {
    clearCache() {},
    async judge(state: State, questions, options) {
      const serialized = JSON.stringify(state);
      states.push(serialized);
      for (const marker of f.forbidden)
        assert.ok(
          !serialized.includes(marker),
          `Forbidden repository content reached Jev: ${marker}`,
        );
      const admission = options?.beforeRequest?.(Object.keys(questions).length);
      if (admission && !admission.ok)
        return { ok: false, error: admission.error, calls: 0 };
      const answers: Record<string, Answer> = {};
      for (const [id, question] of Object.entries(questions)) {
        if (question.type === "bool") answers[id] = { type: "bool", p: 0.95 };
        else if (question.type === "score")
          answers[id] = {
            type: "score",
            score: 1,
            confidence: 0.99,
            legend: question.criteria,
            probabilities: { "1": 1 },
          };
        else {
          const choice =
            Object.keys(question.criteria).find(
              (key) => !["none", "cannot_tell"].includes(key),
            ) ?? "none";
          answers[id] = {
            type: "choice",
            choice,
            confidence: 0.99,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((key) => [
                key,
                key === choice ? 0.99 : 0.001,
              ]),
            ),
          };
        }
      }
      return {
        ok: true,
        answers,
        calls: 1,
        questions: Object.keys(questions).length,
      };
    },
  };
  const host = detectHost({});
  return {
    states,
    deps: {
      client,
      host,
      exec,
      runtime: { session: new Session({}), guide: new Guide(host) },
    },
  };
}
function contains(states: string[], marker: string) {
  assert.ok(
    states.some((state) => state.includes(marker)),
    `Admitted evidence did not reach Jev: ${marker}`,
  );
}

function englishText(text: string, surface: string) {
  assert.doesNotMatch(
    text,
    /[àâçéèêëîïôùûüœÀÂÇÉÈÊËÎÏÔÙÛÜŒ]/u,
    `${surface} must be English for this English-source fixture`,
  );
  assert.doesNotMatch(
    text,
    /\b(?:le|la|les|des|une|est|pas|dans|pour|avec|aucun|fichier|interrompu)\b/iu,
    `${surface} must not contain unaccented French prose`,
  );
}

test("public tool descriptions, snippets and guidelines are English on both hosts", () => {
  for (const omp of [false, true]) {
    const host = detectHost(omp ? { pi: {} } : {});
    const deps = {
      client: {} as JevClient,
      host,
      exec,
      runtime: { session: new Session({}), guide: new Guide(host) },
    };
    for (const createTool of [
      createAskTool,
      createAskFilesTool,
      createCheckDiffTool,
      createFindFilesTool,
      createLocateTool,
      createSelectTestsTool,
    ]) {
      const tool = createTool(deps);
      englishText(tool.description, `${tool.name} description`);
      if ("promptSnippet" in tool && tool.promptSnippet)
        englishText(tool.promptSnippet, `${tool.name} snippet`);
      if ("promptGuidelines" in tool && tool.promptGuidelines)
        for (const guideline of tool.promptGuidelines)
          englishText(guideline, `${tool.name} guideline`);
    }
  }
});

test("the packaged omp guideline is English", async () => {
  const rule = await readFile(
    new URL("../rules/jev-ask.md", import.meta.url),
    "utf8",
  );
  englishText(rule, "Packaged omp guideline");
});

function englishOutput(result: {
  content: readonly { type: string; text?: string }[];
}) {
  for (const item of result.content) {
    if (item.type === "text")
      englishText(item.text ?? "", "Static tool output");
  }
}

for (const seam of [
  "ask",
  "ask_files",
  "find",
  "locate",
  "check_diff",
  "select_tests",
] as const) {
  const publicName = {
    ask: "jev_ask",
    ask_files: "jev_ask_files",
    find: "jev_find_files",
    locate: "jev_locate_in_file",
    check_diff: "jev_check_diff",
    select_tests: "jev_select_tests",
  }[seam];
  test(`repository admission holds at public ${publicName} seam`, async () => {
    const f = await fixture();
    const { states, deps } = recorder(f);
    const context = { cwd: f.cwd };
    try {
      if (seam === "ask") {
        const tool = createAskTool(deps);
        englishOutput(
          await tool.execute(
            "positive",
            { paths: ["invoice.ts"], base: "HEAD", asks },
            undefined,
            undefined,
            context,
          ),
        );
        contains(states, f.admitted);
        contains(states, f.before);
        contains(states, f.dependency);
        for (const path of f.blocked) {
          const start = states.length;
          await tool.execute(
            path,
            { paths: [path], base: "HEAD", asks },
            undefined,
            undefined,
            context,
          );
          assert.equal(
            states.length,
            start,
            `Rejected explicit path reached Jev: ${path}`,
          );
        }
      } else if (seam === "ask_files") {
        const tool = createAskFilesTool(deps);
        englishOutput(
          await tool.execute(
            "positive",
            { paths: ["."], asks },
            undefined,
            undefined,
            context,
          ),
        );
        contains(states, f.admitted);
        for (const path of f.blocked) {
          const start = states.length;
          await tool.execute(
            path,
            { paths: [path], asks },
            undefined,
            undefined,
            context,
          );
          assert.equal(
            states.length,
            start,
            `Rejected explicit path reached Jev: ${path}`,
          );
        }
      } else if (seam === "find") {
        const tool = createFindFilesTool(deps);
        const goal = "find source that calculates the invoice total";
        englishOutput(
          await tool.execute(
            "positive",
            { goal },
            undefined,
            undefined,
            context,
          ),
        );
        contains(states, f.admitted);
        for (const scope of [...f.blocked, "..", "dir-link", "git-link"])
          await tool.execute(
            scope,
            { goal, scope },
            undefined,
            undefined,
            context,
          );
      } else if (seam === "locate") {
        const tool = createLocateTool(deps);
        englishOutput(
          await tool.execute(
            "positive",
            { path: "large.md", goal: "locate invoice total evidence" },
            undefined,
            undefined,
            context,
          ),
        );
        contains(states, f.admitted);
        for (const path of f.blocked) {
          const start = states.length;
          await tool.execute(
            path,
            { path, goal: "locate invoice total evidence" },
            undefined,
            undefined,
            context,
          );
          assert.equal(
            states.length,
            start,
            `Rejected explicit path reached Jev: ${path}`,
          );
        }
      } else if (seam === "check_diff") {
        const tool = createCheckDiffTool(deps);
        for (const check of ["risk", "docs", "spec"] as const) {
          const start = states.length;
          const result = await tool.execute(
            check,
            {
              check,
              base: "HEAD",
              witnesses: "off",
              ...(check === "spec" ? { spec_path: "SPEC.md" } : {}),
            },
            undefined,
            undefined,
            context,
          );
          englishOutput(result);
          assert.ok(
            states.slice(start).some((state) => state.includes(f.admitted)),
            `${check}: admitted changed evidence must reach Jev; ${result.content[0]?.text}`,
          );
          if (check === "spec") contains(states.slice(start), f.spec);
          if (check === "risk") {
            contains(states.slice(start), f.deleted);
            assert.ok(
              states
                .slice(start)
                .some((state) => state.includes("second-secret.ts")),
              "Modified leaf symlink target metadata must reach Jev",
            );
            assert.ok(
              states.slice(start).some((state) => state.includes(f.historical)),
              `Tracked historical blob must remain admitted after its directory becomes a symlink; ${result.content[0]?.text}`,
            );
            contains(states.slice(start), f.newlyIgnored);
          }
        }
        for (const spec_path of [...f.blocked, "secret.md"]) {
          const start = states.length;
          await tool.execute(
            spec_path,
            { check: "spec", base: "HEAD", spec_path },
            undefined,
            undefined,
            context,
          );
          assert.equal(
            states.length,
            start,
            `Rejected specification reached Jev: ${spec_path}`,
          );
        }
      } else {
        const tool = createSelectTestsTool(deps);
        englishOutput(
          await tool.execute(
            "positive",
            { base: "HEAD", witnesses: "off" },
            undefined,
            undefined,
            context,
          ),
        );
        contains(states, f.admitted);
        contains(states, f.testEvidence);
        for (const path of [
          ...f.blocked,
          "../outside/*.test.js",
          join(f.root, "outside", "*.test.js"),
          "dir-link/*.test.js",
          "secret.test.js",
        ])
          await tool.execute(
            path,
            { base: "HEAD", paths: [path], witnesses: "off" },
            undefined,
            undefined,
            context,
          );
      }
      for (const state of states) {
        for (const marker of f.forbidden)
          assert.ok(
            !state.includes(marker),
            `Forbidden repository content reached Jev: ${marker}`,
          );
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("actual command adapter reads outside-repository private captures and removes them", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-private-capture-"));
  const cwd = join(root, "repo");
  const marker = `PRIVATE_COMMAND_${randomUUID()}`;
  let captures: string[] = [];
  try {
    await mkdir(cwd);
    const result = await captureCommand(
      async (binary, args, options) => {
        captures = args.slice(-2);
        for (const path of captures) {
          assert.equal(isAbsolute(path), true);
          assert.ok(
            relative(cwd, path).startsWith(".."),
            "Capture must be outside the repository",
          );
        }
        return exec(binary, args, options);
      },
      cwd,
      `printf '%s\\n' '${marker}'; printf 'private diagnostic\\n' >&2; exit 7`,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.output.stdout, `${marker}\n`);
    assert.equal(result.output.stderr, "private diagnostic\n");
    assert.equal(result.output.exit_code, 7);
    assert.equal(captures.length, 2);
    for (const path of captures)
      await assert.rejects(access(path), { code: "ENOENT" });
    const stdoutCapture = captures[0];
    assert.ok(stdoutCapture);
    await assert.rejects(access(join(stdoutCapture, "..")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
