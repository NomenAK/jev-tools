#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateConfiguration } from "../configuration.ts";
import {
  BAND_BOOL_GRAY_A,
  BAND_BOOL_YES_MIN,
  HOOK_BUDGET_MS,
} from "../constants.ts";
import {
  type ClientDependencies,
  createJevClient,
  readConfig,
} from "../jev/client.ts";
import type { Question, State } from "../jev/types.ts";
import { isRecord } from "../result.ts";

const usage = `jev-check - judge a text on stdin against a rules file with one Jev request

Usage: jev-check --rules <file> [--stop-hook] [--json] [--timeout-ms <n>]
                 [--pass-min <p>] [--fail-max <p>] [--usd-per-mtok <x>]

Exit codes: 0 every rule passes, 1 a rule is broken, 2 not judged.
With --stop-hook, stdin is a Claude Code Stop hook payload, a refusal exits 2
(blocking) and every other outcome exits 0 or 1 (never blocking).
Configuration: JEV_TOOLS_URL, JEV_TOOLS_API_KEY, optional JEV_TOOLS_MODEL.`;

export interface CheckOptions {
  argv: readonly string[];
  readStdin: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: ClientDependencies["sleep"];
}
export interface CheckResult {
  code: number;
  stdout: string;
  stderr: string;
}
interface Args {
  rules: string;
  stopHook: boolean;
  json: boolean;
  timeoutMs: number;
  passMin: number;
  failMax: number;
  usdPerMtok?: number;
}
interface Rules {
  statements: Record<string, string>;
  reference?: string;
}
type Band = "pass" | "unsure" | "broken" | "unjudged";

const MAX_RULES = 64;

function packageVersion(): string {
  try {
    // src/cli/check.ts and dist/cli/check.js both sit two levels below the root.
    const text = readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseArgs(argv: readonly string[]): Args | { exit: string } {
  const args: Partial<Args> & { stopHook: boolean; json: boolean } = {
    stopHook: false,
    json: false,
  };
  const number = (flag: string, text: string | undefined): number => {
    const value = text?.trim() ? Number(text) : Number.NaN;
    if (!Number.isFinite(value)) throw new Error(`${flag} requires a number`);
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === "--help" || arg === "-h") return { exit: usage };
    if (arg === "--version") return { exit: packageVersion() };
    if (arg === "--stop-hook") args.stopHook = true;
    else if (arg === "--json") args.json = true;
    else {
      const [flag = "", inline] = arg.startsWith("--")
        ? (arg.split(/=(.*)/s, 2) as [string, string?])
        : [arg];
      const value = () => inline ?? argv[++index];
      if (flag === "--rules") {
        const file = value();
        if (!file) throw new Error("--rules requires a file");
        args.rules = file;
      } else if (flag === "--timeout-ms") {
        args.timeoutMs = number(flag, value());
        if (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0)
          throw new Error("--timeout-ms requires a positive integer");
      } else if (flag === "--pass-min") args.passMin = number(flag, value());
      else if (flag === "--fail-max") args.failMax = number(flag, value());
      else if (flag === "--usd-per-mtok") {
        args.usdPerMtok = number(flag, value());
        if (args.usdPerMtok < 0)
          throw new Error("--usd-per-mtok must not be negative");
      } else throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.rules) throw new Error("--rules <file> is required");
  const passMin = args.passMin ?? BAND_BOOL_YES_MIN;
  const failMax = args.failMax ?? BAND_BOOL_GRAY_A;
  if (!(failMax >= 0 && failMax < passMin && passMin <= 1))
    throw new Error("thresholds must satisfy 0 <= fail-max < pass-min <= 1");
  if (args.stopHook && args.json)
    throw new Error("--json cannot be combined with --stop-hook");
  return {
    rules: args.rules,
    stopHook: args.stopHook,
    json: args.json,
    timeoutMs: args.timeoutMs ?? HOOK_BUDGET_MS,
    passMin,
    failMax,
    ...(args.usdPerMtok === undefined ? {} : { usdPerMtok: args.usdPerMtok }),
  };
}

function loadRules(file: string): Rules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code
        ? `cannot read rules file (${code})`
        : "rules file is not valid JSON",
    );
  }
  const rules = isRecord(parsed) ? parsed.rules : undefined;
  if (!isRecord(rules)) throw new Error('rules file needs a "rules" object');
  const names = Object.keys(rules);
  if (names.length < 1 || names.length > MAX_RULES)
    throw new Error(`rules file needs 1 to ${MAX_RULES} rules`);
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name))
      throw new Error(`rule name "${name}" must match [a-z0-9][a-z0-9_-]*`);
    const statement = rules[name];
    if (typeof statement !== "string" || !statement.trim())
      throw new Error(`rule "${name}" needs a nonempty statement`);
  }
  const reference = (parsed as Record<string, unknown>).reference;
  if (reference !== undefined && typeof reference !== "string")
    throw new Error('"reference" must be a string');
  return {
    statements: rules as Record<string, string>,
    ...(reference === undefined ? {} : { reference }),
  };
}

// The client keeps `usage` only when the response has both input_tokens and
// cost; a provider may report only the token counts, so read them here.
function measuring(inner: typeof fetch) {
  const usage: { inputTokens?: number; costUsd?: number } = {};
  const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  const wrapped = (async (...call: Parameters<typeof fetch>) => {
    const response = await inner(...call);
    try {
      const body: unknown = await response.clone().json();
      const reported = isRecord(body) ? body.usage : undefined;
      if (isRecord(reported)) {
        if (count(reported.input_tokens))
          usage.inputTokens = (usage.inputTokens ?? 0) + reported.input_tokens;
        if (count(reported.cost))
          usage.costUsd = (usage.costUsd ?? 0) + reported.cost;
      }
    } catch {
      // Not JSON or already consumed: the client reports the failure itself.
    }
    return response;
  }) as typeof fetch;
  return { fetch: wrapped, usage };
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const probability = (p: number) => `p=${p.toFixed(2)}`;

export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const hook = options.argv.includes("--stop-hook");
  const result = (code: number, stdout = "", stderr = ""): CheckResult => ({
    code,
    stdout: stdout && `${stdout}\n`,
    stderr: stderr && `${stderr}\n`,
  });
  // A hook failure must not block the agent: exit 2 would, so setup errors
  // exit 1 (visible, non-blocking) and judge outages exit 0.
  const usageError = (message: string) =>
    result(hook ? 1 : 2, "", `jev-check: ${message}`);
  let args: Args;
  let rules: Rules;
  try {
    const parsed = parseArgs(options.argv);
    if ("exit" in parsed) return result(0, parsed.exit);
    args = parsed;
    rules = loadRules(args.rules);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  let text = await options.readStdin();
  if (args.stopHook) {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    if (
      !isRecord(payload) ||
      typeof payload.last_assistant_message !== "string"
    )
      return result(
        0,
        "",
        "jev-check: no last_assistant_message in hook input; nothing judged",
      );
    if (payload.stop_hook_active === true)
      return result(
        0,
        "",
        "jev-check: stop hook already active; nothing judged",
      );
    text = payload.last_assistant_message;
  }
  if (!text.trim()) {
    const line = "compliant: empty text, not sent";
    return args.json
      ? result(
          0,
          JSON.stringify({
            verdict: "compliant",
            reason: line,
            rules: {},
            calls: 0,
            questions: 0,
            ms: 0,
          }),
        )
      : result(0, args.stopHook ? "" : line);
  }
  const config = readConfig(options.env);
  const configError = config
    ? (() => {
        try {
          validateConfiguration(config);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })()
    : "JEV_TOOLS_URL and JEV_TOOLS_API_KEY must both be set";
  if (!config || configError)
    return result(args.stopHook ? 0 : 2, "", `jev-check: ${configError}`);

  const now = options.now ?? (() => performance.now());
  const measure = measuring(options.fetch ?? fetch);
  const client = createJevClient(config, {
    fetch: measure.fetch,
    now,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  const questions: Record<string, Question> = {};
  for (const [name, statement] of Object.entries(rules.statements))
    questions[name] = {
      type: "bool",
      instructions: `Does the text in state.text comply with this rule? Rule: ${statement}`,
      criteria: {
        true: "The text complies with the rule.",
        false: "The text breaks the rule.",
      },
    };
  const state: State = {
    text,
    ...(rules.reference === undefined ? {} : { reference: rules.reference }),
  };
  const started = now();
  const judgment = await client.judge(state, questions, {
    signal: AbortSignal.timeout(args.timeoutMs),
    cache: false,
  });
  const ms = Math.round(now() - started);

  const readings: Record<string, { p?: number; band: Band }> = {};
  let failure = judgment.ok ? undefined : oneLine(judgment.error);
  for (const name of Object.keys(questions)) {
    const answer = judgment.ok ? judgment.answers[name] : undefined;
    if (answer?.type === "bool")
      readings[name] = {
        p: answer.p,
        band:
          answer.p >= args.passMin
            ? "pass"
            : answer.p <= args.failMax
              ? "broken"
              : "unsure",
      };
    else {
      readings[name] = { band: "unjudged" };
      if (answer?.type === "unjudged") failure ??= oneLine(answer.reason);
    }
  }
  const named = (band: Band) =>
    Object.entries(readings)
      .filter(([, reading]) => reading.band === band)
      .sort(([, a], [, b]) => (a.p ?? 0) - (b.p ?? 0))
      .map(([name]) => name);
  const withP = (names: string[]) =>
    names.map((name) => `${name} (${probability(readings[name]?.p ?? 0)})`);
  const broken = named("broken");
  const unsure = named("unsure");
  const unjudged = named("unjudged");
  const total = Object.keys(questions).length;
  let verdict: "compliant" | "refused" | "not_judged";
  let line: string;
  if (broken.length) {
    verdict = "refused";
    line = `refused: ${withP(broken).join(", ")}`;
  } else if (unsure.length || unjudged.length) {
    verdict = "not_judged";
    line = `not judged: ${[
      ...(unsure.length ? [`unsure ${withP(unsure).join(", ")}`] : []),
      ...(unjudged.length
        ? [`unjudged ${unjudged.join(", ")}${failure ? ` (${failure})` : ""}`]
        : []),
    ].join("; ")}`;
  } else {
    verdict = "compliant";
    line = `compliant: ${total}/${total} rules`;
  }

  const { inputTokens } = measure.usage;
  const costUsd =
    measure.usage.costUsd ??
    (inputTokens !== undefined && args.usdPerMtok !== undefined
      ? (inputTokens / 1e6) * args.usdPerMtok
      : undefined);
  const calls = (judgment.calls ?? 0) as number;
  const asked = (judgment.questions ?? 0) as number;
  const measurement = [
    plural(calls, "call"),
    plural(asked, "question"),
    ...(inputTokens === undefined ? [] : [plural(inputTokens, "input token")]),
    ...(costUsd === undefined ? [] : [`$${costUsd.toFixed(6)}`]),
    `${ms} ms`,
  ].join(" · ");

  if (args.stopHook) {
    if (verdict === "refused")
      return result(
        2,
        "",
        `jev-check refused this message. Broken rules: ${broken
          .map((name) => `${name}: ${rules.statements[name]}`)
          .join(
            "; ",
          )}. Rewrite the message so that every rule holds.\n${measurement}`,
      );
    return result(
      0,
      "",
      `${verdict === "not_judged" ? `jev-check: ${line}\n` : ""}${measurement}`,
    );
  }
  const code = verdict === "compliant" ? 0 : verdict === "refused" ? 1 : 2;
  const stdout = args.json
    ? JSON.stringify({
        verdict,
        reason: line,
        rules: readings,
        calls,
        questions: asked,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(costUsd === undefined ? {} : { costUsd }),
        ms,
        ...(judgment.model ? { model: judgment.model } : {}),
      })
    : line;
  return result(code, stdout, measurement);
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(): Promise<void> {
  const outcome = await runCheck({
    argv: process.argv.slice(2),
    readStdin,
    env: process.env,
  });
  process.stdout.write(outcome.stdout);
  process.stderr.write(outcome.stderr);
  process.exitCode = outcome.code;
}

// Run only as the entry point, so tests can import runCheck.
const entry = process.argv[1];
if (
  entry &&
  realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
)
  main().catch((error: unknown) => {
    process.stderr.write(
      `jev-check: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
