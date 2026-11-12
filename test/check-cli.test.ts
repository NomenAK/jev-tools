import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runCheck } from "../src/cli/check.ts";

const apiKey = "sk-test-key-123";
const env = {
  JEV_TOOLS_URL: "https://jev.example.test/v1",
  JEV_TOOLS_API_KEY: apiKey,
};
const dir = mkdtempSync(join(tmpdir(), "jev-check-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const rulesFile = (content: unknown, name = "rules.json") => {
  const file = join(dir, name);
  writeFileSync(
    file,
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return file;
};
const rules = rulesFile({
  rules: {
    "no-em-dash": "The text contains no em dash.",
    "short-sentences": "Every sentence has at most 20 words.",
    "plain-words": "The text uses plain words.",
  },
  reference: "Glossary: plain means everyday.",
});

type Body = {
  state: Record<string, unknown>;
  questions: Record<
    string,
    { type: string; instructions: string; criteria: unknown }
  >;
};
type Seen = { url: string; headers: Record<string, string>; body: Body };
// Wire type of a bool answer is "noul"; unlisted rules get 0.95.
function fakeJev(
  probabilities: Record<string, number> = {},
  extra: Record<string, unknown> = {
    usage: { input_tokens: 1234, output_tokens: 3 },
  },
) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    seen.push({ url, headers: init.headers as Record<string, string>, body });
    return Response.json({
      model: "served",
      answers: Object.fromEntries(
        Object.keys(body.questions).map((id) => [
          id,
          { type: "noul", noul: probabilities[id] ?? 0.95 },
        ]),
      ),
      ...extra,
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}
const status = (code: number, message: string) =>
  (async () =>
    Response.json(
      { error: message },
      { status: code },
    )) as unknown as typeof globalThis.fetch;

function run(
  argv: string[],
  stdin: string,
  fetch: typeof globalThis.fetch,
  more: { env?: NodeJS.ProcessEnv; sleep?: () => Promise<void> } = {},
) {
  return runCheck({
    argv,
    readStdin: async () => stdin,
    env: more.env ?? env,
    fetch,
    ...(more.sleep ? { sleep: more.sleep } : {}),
  });
}
const lines = (text: string) => text.split("\n").filter(Boolean);

test("compliant text exits 0 with one stdout line and a measurement on stderr", async () => {
  const { fetch } = fakeJev();
  const out = await run(["--rules", rules], "Hello there.", fetch);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, "compliant: 3/3 rules\n");
  assert.equal(lines(out.stderr).length, 1);
  assert.match(
    out.stderr,
    /^1 call · 3 questions · 1234 input tokens · \d+ ms\n$/,
  );
});

test("a broken rule exits 1 and names it, lowest probability first", async () => {
  const { fetch } = fakeJev({ "short-sentences": 0.11, "no-em-dash": 0.04 });
  const out = await run(["--rules", rules], "text", fetch);
  assert.equal(out.code, 1);
  assert.equal(
    out.stdout,
    "refused: no-em-dash (p=0.04), short-sentences (p=0.11)\n",
  );
});

test("the gray band is not judged and exits 2", async () => {
  const { fetch } = fakeJev({ "plain-words": 0.55 });
  const out = await run(["--rules", rules], "text", fetch);
  assert.equal(out.code, 2);
  assert.equal(out.stdout, "not judged: unsure plain-words (p=0.55)\n");
});

test("a broken rule wins over an unsure one, and thresholds are adjustable", async () => {
  const mixed = fakeJev({ "no-em-dash": 0.1, "plain-words": 0.5 });
  assert.equal((await run(["--rules", rules], "t", mixed.fetch)).code, 1);
  const loose = fakeJev({ "plain-words": 0.55 });
  const out = await run(
    ["--rules", rules, "--pass-min", "0.5"],
    "t",
    loose.fetch,
  );
  assert.equal(out.code, 0);
  const bad = await run(
    ["--rules", rules, "--pass-min", "0.1", "--fail-max", "0.2"],
    "t",
    loose.fetch,
  );
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /fail-max < pass-min/);
});

test("HTTP errors exit 2 and never print the key", async () => {
  const noWait = async () => {};
  for (const [code, message] of [
    [500, `boom ${apiKey}`],
    [401, `bad key ${apiKey}`],
  ] as const) {
    const out = await run(["--rules", rules], "text", status(code, message), {
      sleep: noWait,
    });
    assert.equal(out.code, 2);
    assert.match(out.stdout, new RegExp(`^not judged: .*Jev HTTP ${code}`));
    assert.equal(lines(out.stdout).length, 1);
    assert.ok(!(out.stdout + out.stderr).includes(apiKey));
  }
});

test("a request that outlives --timeout-ms exits 2", async () => {
  const hang = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    })) as unknown as typeof globalThis.fetch;
  const out = await run(["--rules", rules, "--timeout-ms", "30"], "text", hang);
  assert.equal(out.code, 2);
  assert.match(out.stdout, /^not judged: /);
});

test("an invalid rules file exits 2 with a one-line reason", async () => {
  const { fetch, seen } = fakeJev();
  const cases: [string, unknown][] = [
    ["not json", "{nope"],
    ["no rules", {}],
    ["empty rules", { rules: {} }],
    ["bad name", { rules: { "Bad Name": "x" } }],
    ["empty statement", { rules: { ok: " " } }],
    ["bad reference", { rules: { ok: "x" }, reference: 3 }],
    [
      "too many",
      {
        rules: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [`r${i}`, "x"]),
        ),
      },
    ],
  ];
  for (const [label, content] of cases) {
    const out = await run(
      ["--rules", rulesFile(content, "bad.json")],
      "text",
      fetch,
    );
    assert.equal(out.code, 2, label);
    assert.equal(lines(out.stderr).length, 1, label);
  }
  const missing = await run(
    ["--rules", join(dir, "absent.json")],
    "text",
    fetch,
  );
  assert.equal(missing.code, 2);
  assert.equal((await run([], "text", fetch)).code, 2);
  assert.equal(
    (await run(["--rules", rules, "--nope"], "text", fetch)).code,
    2,
  );
  assert.equal(seen.length, 0);
});

test("missing configuration exits 2 and names both variables", async () => {
  const { fetch, seen } = fakeJev();
  const out = await run(["--rules", rules], "text", fetch, {
    env: { JEV_TOOLS_URL: "https://x.test" },
  });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /JEV_TOOLS_URL.*JEV_TOOLS_API_KEY/);
  assert.equal(seen.length, 0);
});

test("plain http to a non-loopback host is refused, loopback is accepted", async () => {
  const { fetch, seen } = fakeJev();
  const refused = await run(["--rules", rules], "text", fetch, {
    env: {
      JEV_TOOLS_URL: "http://jev.example.test/v1",
      JEV_TOOLS_API_KEY: apiKey,
    },
  });
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /plain http/);
  assert.ok(!refused.stderr.includes(apiKey));
  assert.equal(seen.length, 0);
  const local = await run(["--rules", rules], "text", fetch, {
    env: { JEV_TOOLS_URL: "http://127.0.0.1:9/v1", JEV_TOOLS_API_KEY: apiKey },
  });
  assert.equal(local.code, 0);
});

test("empty text exits 0 without any request", async () => {
  const { fetch, seen } = fakeJev();
  const out = await run(["--rules", rules], " \n\t ", fetch);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, "compliant: empty text, not sent\n");
  assert.equal(seen.length, 0);
});

test("one request carries every rule, the text, the reference and the bearer key", async () => {
  const { fetch, seen } = fakeJev();
  await run(["--rules", rules], "The quick fox.", fetch);
  assert.equal(seen.length, 1);
  const [request] = seen as [Seen];
  assert.equal(request.url, env.JEV_TOOLS_URL);
  assert.equal(request.headers.Authorization, `Bearer ${apiKey}`);
  assert.deepEqual(request.body.state, {
    text: "The quick fox.",
    reference: "Glossary: plain means everyday.",
  });
  assert.deepEqual(Object.keys(request.body.questions).sort(), [
    "no-em-dash",
    "plain-words",
    "short-sentences",
  ]);
  const question = request.body.questions[
    "no-em-dash"
  ] as Body["questions"][string];
  assert.equal(question.type, "noul");
  assert.equal(
    question.instructions,
    "Does the text in state.text comply with this rule? Rule: The text contains no em dash.",
  );
  assert.deepEqual(question.criteria, {
    true: "The text complies with the rule.",
    false: "The text breaks the rule.",
  });
});

test("tokens are summed without usage.cost; cost comes from the response or --usd-per-mtok", async () => {
  const tokensOnly = fakeJev();
  const a = await run(["--rules", rules, "--json"], "t", tokensOnly.fetch);
  const tokens = JSON.parse(a.stdout);
  assert.equal(tokens.inputTokens, 1234);
  assert.equal("costUsd" in tokens, false);
  assert.doesNotMatch(a.stderr, /\$/);

  const priced = fakeJev(
    {},
    { usage: { input_tokens: 1000, output_tokens: 1, cost: 0.000052 } },
  );
  const b = JSON.parse(
    (
      await run(
        ["--rules", rules, "--json", "--usd-per-mtok", "9"],
        "t",
        priced.fetch,
      )
    ).stdout,
  );
  assert.equal(b.costUsd, 0.000052);

  const computed = fakeJev({}, { usage: { input_tokens: 2_000_000 } });
  const c = await run(
    ["--rules", rules, "--usd-per-mtok", "0.5"],
    "t",
    computed.fetch,
  );
  assert.match(c.stderr, /2000000 input tokens · \$1\.000000 · /);
});

test("--json prints one JSON line with verdict, per-rule bands and the measurement", async () => {
  const { fetch } = fakeJev({ "no-em-dash": 0.04, "plain-words": 0.5 });
  const out = await run(["--rules", rules, "--json"], "t", fetch);
  assert.equal(out.code, 1);
  assert.equal(lines(out.stdout).length, 1);
  const json = JSON.parse(out.stdout);
  assert.equal(json.verdict, "refused");
  assert.equal(json.reason, "refused: no-em-dash (p=0.04)");
  assert.deepEqual(json.rules, {
    "no-em-dash": { kind: "rule", p: 0.04, band: "broken" },
    "short-sentences": { kind: "rule", p: 0.95, band: "pass" },
    "plain-words": { kind: "rule", p: 0.5, band: "unsure" },
  });
  assert.equal(json.calls, 1);
  assert.equal(json.questions, 3);
  assert.equal(json.model, "served");
  assert.equal(typeof json.ms, "number");
});

const hookInput = (message: unknown, extra: object = {}) =>
  JSON.stringify({
    hook_event_name: "Stop",
    last_assistant_message: message,
    ...extra,
  });

test("--stop-hook: a refusal exits 2 with the broken rule statement on stderr", async () => {
  const { fetch, seen } = fakeJev({ "no-em-dash": 0.02 });
  const out = await run(
    ["--rules", rules, "--stop-hook"],
    hookInput("Bad — text"),
    fetch,
  );
  assert.equal(out.code, 2);
  assert.equal(out.stdout, "");
  assert.match(
    out.stderr,
    /^jev-check refused this message\. Broken rules: no-em-dash: The text contains no em dash\. Rewrite the message so that every rule holds\.\n/,
  );
  assert.equal(seen[0]?.body.state.text, "Bad — text");
});

test("--stop-hook: compliant exits 0; stop_hook_active and bad input send nothing", async () => {
  const ok = fakeJev();
  assert.equal(
    (await run(["--rules", rules, "--stop-hook"], hookInput("fine"), ok.fetch))
      .code,
    0,
  );
  assert.equal(ok.seen.length, 1);
  const active = fakeJev({ "no-em-dash": 0.02 });
  const loop = await run(
    ["--rules", rules, "--stop-hook"],
    hookInput("x", { stop_hook_active: true }),
    active.fetch,
  );
  assert.equal(loop.code, 0);
  for (const input of ["not json", "[]", hookInput(7), JSON.stringify({})]) {
    const out = await run(
      ["--rules", rules, "--stop-hook"],
      input,
      active.fetch,
    );
    assert.equal(out.code, 0);
    assert.equal(lines(out.stderr).length, 1);
  }
  assert.equal(active.seen.length, 0);
});

test("--stop-hook: an outage, gray band or missing configuration never blocks", async () => {
  const outage = await run(
    ["--rules", rules, "--stop-hook"],
    hookInput("x"),
    status(500, "down"),
    {
      sleep: async () => {},
    },
  );
  assert.equal(outage.code, 0);
  assert.match(outage.stderr, /not judged/);
  assert.ok(!outage.stderr.includes(apiKey));
  const gray = await run(
    ["--rules", rules, "--stop-hook"],
    hookInput("x"),
    fakeJev({ "plain-words": 0.5 }).fetch,
  );
  assert.equal(gray.code, 0);
  const unconfigured = await run(
    ["--rules", rules, "--stop-hook"],
    hookInput("x"),
    fakeJev().fetch,
    { env: {} },
  );
  assert.equal(unconfigured.code, 0);
  assert.match(unconfigured.stderr, /JEV_TOOLS_URL/);
});

test("--stop-hook: setup errors exit 1 (visible, not blocking) and --json is refused with it", async () => {
  const { fetch } = fakeJev();
  const missing = await run(
    ["--rules", join(dir, "absent.json"), "--stop-hook"],
    hookInput("x"),
    fetch,
  );
  assert.equal(missing.code, 1);
  const both = await run(
    ["--rules", rules, "--stop-hook", "--json"],
    hookInput("x"),
    fetch,
  );
  assert.equal(both.code, 1);
});

const statement = "The text is a command that creates a billed cloud resource.";
const flagsOnly = rulesFile(
  { flags: { "paid-resource": statement } },
  "flags.json",
);
const mixed = rulesFile(
  {
    rules: { "plain-words": "The text uses plain words." },
    flags: {
      "paid-resource": statement,
      "data-loss": "The text deletes data.",
    },
  },
  "mixed.json",
);

test("flags: a flags-only file is accepted and a raised flag reports p as acceptability", async () => {
  const { fetch } = fakeJev({ "paid-resource": 0.95 });
  const out = await run(["--rules", flagsOnly], "make it", fetch);
  assert.equal(out.code, 1);
  assert.equal(out.stdout, "refused: paid-resource (p=0.05)\n");
});

test("flags: a low answer means the text is acceptable", async () => {
  const { fetch } = fakeJev({ "paid-resource": 0.03 });
  const out = await run(["--rules", flagsOnly], "ls", fetch);
  assert.equal(out.code, 0);
  assert.equal(out.stdout, "compliant: 1/1 rules\n");
});

test("flags: a name in both maps, or a bad flag, exits 2 without a request", async () => {
  const { fetch, seen } = fakeJev();
  for (const content of [
    { rules: { same: "x" }, flags: { same: "y" } },
    { flags: { "Bad Name": "y" } },
    { flags: { ok: " " } },
    { flags: [] },
    { rules: {}, flags: {} },
  ]) {
    const out = await run(
      ["--rules", rulesFile(content, "bad.json")],
      "text",
      fetch,
    );
    assert.equal(out.code, 2);
    assert.equal(lines(out.stderr).length, 1);
  }
  assert.equal(seen.length, 0);
});

test("flags: the wire request carries the positive question", async () => {
  const { fetch, seen } = fakeJev();
  await run(["--rules", mixed], "make it", fetch);
  const questions = (seen[0] as Seen).body.questions;
  assert.deepEqual(questions["paid-resource"], {
    type: "noul",
    instructions: `Is this statement true of the text in state.text? Statement: ${statement}`,
    criteria: {
      true: "The statement is true of the text.",
      false: "The statement is false of the text.",
    },
  });
  assert.match(
    questions["plain-words"]?.instructions ?? "",
    /^Does the text in state\.text comply/,
  );
});

test("flags: --json carries kind and p is acceptability for both kinds", async () => {
  const { fetch } = fakeJev({ "paid-resource": 0.9, "data-loss": 0.1 });
  const out = await run(["--rules", mixed, "--json"], "t", fetch);
  assert.equal(out.code, 1);
  const json = JSON.parse(out.stdout);
  assert.deepEqual(json.rules, {
    "plain-words": { kind: "rule", p: 0.95, band: "pass" },
    "paid-resource": { kind: "flag", p: 0.1, band: "broken" },
    "data-loss": { kind: "flag", p: 0.9, band: "pass" },
  });
});

const preInput = (toolInput: unknown, tool = "Bash") =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: toolInput,
  });

test("--pre-tool-hook: a raised flag exits 2 with tool name and statement on stderr", async () => {
  const { fetch, seen } = fakeJev({ "paid-resource": 0.95 });
  const out = await run(
    ["--rules", flagsOnly, "--pre-tool-hook"],
    preInput({ command: "aws ec2 run-instances", description: "x" }),
    fetch,
  );
  assert.equal(out.code, 2);
  assert.equal(out.stdout, "");
  const [reason, measurement, ...rest] = lines(out.stderr);
  assert.equal(
    reason,
    `jev-check stopped this Bash call. Raised flags: paid-resource: ${statement}`,
  );
  assert.match(measurement ?? "", /^1 call · /);
  assert.equal(rest.length, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.body.state.text, "aws ec2 run-instances");
});

test("--pre-tool-hook --ask: exit 0 with one permissionDecision JSON line", async () => {
  const { fetch } = fakeJev({ "paid-resource": 0.95 });
  const out = await run(
    ["--rules", flagsOnly, "--pre-tool-hook", "--ask"],
    preInput({ command: "aws ec2 run-instances" }),
    fetch,
  );
  assert.equal(out.code, 0);
  assert.equal(
    out.stdout,
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `jev-check stopped this Bash call. Raised flags: paid-resource: ${statement}`,
      },
    })}\n`,
  );
  assert.match(out.stderr, /^1 call · /);
});

test("--pre-tool-hook: groups broken rules and raised flags", async () => {
  const { fetch } = fakeJev({
    "plain-words": 0.02,
    "paid-resource": 0.02,
    "data-loss": 0.9,
  });
  const out = await run(
    ["--rules", mixed, "--pre-tool-hook"],
    preInput({ command: "x" }),
    fetch,
  );
  assert.equal(out.code, 2);
  assert.match(
    out.stderr,
    /^jev-check stopped this Bash call\. Broken rules: plain-words: The text uses plain words\.; Raised flags: data-loss: The text deletes data\./,
  );
});

test("--pre-tool-hook: judges content, new_string, then the whole input", async () => {
  const write = fakeJev();
  await run(
    ["--rules", flagsOnly, "--pre-tool-hook"],
    preInput({ file_path: "a.txt", content: "file body" }, "Write"),
    write.fetch,
  );
  assert.equal(write.seen[0]?.body.state.text, "file body");
  const edit = fakeJev();
  await run(
    ["--rules", flagsOnly, "--pre-tool-hook"],
    preInput({ file_path: "a", old_string: "o", new_string: "new" }, "Edit"),
    edit.fetch,
  );
  assert.equal(edit.seen[0]?.body.state.text, "new");
  const other = fakeJev();
  await run(
    ["--rules", flagsOnly, "--pre-tool-hook"],
    preInput({ pattern: "x" }, "Grep"),
    other.fetch,
  );
  assert.equal(other.seen[0]?.body.state.text, '{"pattern":"x"}');
});

test("--pre-tool-hook: compliant, outage and unconfigured never block", async () => {
  const ok = await run(
    ["--rules", flagsOnly, "--pre-tool-hook", "--ask"],
    preInput({ command: "ls" }),
    fakeJev({ "paid-resource": 0.03 }).fetch,
  );
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, "");
  const outage = await run(
    ["--rules", flagsOnly, "--pre-tool-hook"],
    preInput({ command: "ls" }),
    status(500, "down"),
    { sleep: async () => {} },
  );
  assert.equal(outage.code, 0);
  assert.equal(outage.stdout, "");
  assert.match(outage.stderr, /not judged/);
  const unconfigured = await run(
    ["--rules", flagsOnly, "--pre-tool-hook"],
    preInput({ command: "ls" }),
    fakeJev().fetch,
    { env: {} },
  );
  assert.equal(unconfigured.code, 0);
  assert.match(unconfigured.stderr, /JEV_TOOLS_URL/);
});

test("--pre-tool-hook: no tool_input, bad JSON or empty text send nothing and exit 0", async () => {
  const { fetch, seen } = fakeJev({ "paid-resource": 0.95 });
  for (const input of [
    JSON.stringify({ tool_name: "Bash" }),
    JSON.stringify({ tool_name: "Bash", tool_input: "ls" }),
    "[]",
    "not json",
  ]) {
    const out = await run(
      ["--rules", flagsOnly, "--pre-tool-hook"],
      input,
      fetch,
    );
    assert.equal(out.code, 0);
    assert.equal(lines(out.stderr).length, 1);
  }
  const empty = await run(
    ["--rules", flagsOnly, "--pre-tool-hook"],
    preInput({ command: "  " }),
    fetch,
  );
  assert.equal(empty.code, 0);
  assert.equal(empty.stderr, "");
  assert.equal(seen.length, 0);
});

test("--ask needs --pre-tool-hook, which excludes --stop-hook and --json", async () => {
  const { fetch, seen } = fakeJev();
  const ask = await run(["--rules", rules, "--ask"], "t", fetch);
  assert.equal(ask.code, 2);
  assert.match(ask.stderr, /--ask requires --pre-tool-hook/);
  for (const extra of ["--stop-hook", "--json"]) {
    const out = await run(
      ["--rules", rules, "--pre-tool-hook", extra],
      preInput({ command: "x" }),
      fetch,
    );
    assert.equal(out.code, 1, extra);
    assert.match(out.stderr, /cannot be combined/);
  }
  assert.equal(seen.length, 0);
});

test("--help and --version print to stdout and exit 0", async () => {
  const { fetch } = fakeJev();
  const help = await run(["--help"], "", fetch);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^jev-check - /);
  const version = await run(["--version"], "", fetch);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
});
