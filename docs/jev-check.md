# jev-check

`jev-check` judges a text against a rules file with one Jev request and reports through its exit code. It is a command-line companion to the six tools: it does not use the MCP server or the pi and omp extension, and it never reads the saved `/jev-setup` configuration.

```text
jev-check --rules <file> [--stop-hook] [--json] [--timeout-ms <n>]
          [--pass-min <p>] [--fail-max <p>] [--usd-per-mtok <x>]
```

The text is read from standard input (UTF-8). From a clone, run `npm run build` and use `node dist/cli/check.js`; an installed package provides the `jev-check` binary (`npx -y -p jev-agent-tools jev-check ...`).

## Configuration

Environment variables only, as for the MCP server: `JEV_TOOLS_URL` and `JEV_TOOLS_API_KEY` (required), `JEV_TOOLS_MODEL` (optional). The URL policy is the same as everywhere else: `https:`, or `http:` to a loopback host, without embedded credentials. The key is never accepted on the command line and never printed.

## Rules file

```json
{
  "rules": {
    "no-em-dash": "The text contains no em dash.",
    "defined-terms": "Every technical term used also appears in the reference."
  },
  "reference": "Optional text the rules may cite, such as a glossary."
}
```

Write each statement so that it is true of a compliant text. Names match `^[a-z0-9][a-z0-9_-]*$`; there are 1 to 64 rules. All rules go to Jev in a single `judge` request, each as a `bool` question over `state.text` (and `state.reference` when given). Results are not cached.

## Reading the result

Each rule gets the probability `p` that the text complies. `p >= --pass-min` (default 0.8) passes, `p <= --fail-max` (default 0.2) is broken, anything between is unsure. The thresholds must satisfy `0 <= fail-max < pass-min <= 1`.

| Exit code | Meaning |
|---|---|
| 0 | Every rule passes, or the text is empty (nothing is sent). |
| 1 | At least one rule is broken. |
| 2 | Not judged: nothing is broken but a rule is unsure or unjudged, or there is a usage, rules file, configuration, transport or timeout error. |

Standard output carries exactly one line, for example `refused: no-em-dash (p=0.04)`, `compliant: 8/8 rules` or `not judged: unsure plain-words (p=0.55)`; rule names are sorted by ascending `p`. Standard error carries one measurement line such as `1 call · 8 questions · 1234 input tokens · $0.000052 · 812 ms`. Tokens come from `usage.input_tokens` and cost from `usage.cost` when the response has them; otherwise cost is `input tokens / 1e6 * --usd-per-mtok` when that option is given, and omitted when not. No price is built in.

With `--json`, standard output is one JSON line: `verdict` (`compliant`, `refused` or `not_judged`), `reason`, `rules` (`{name: {p, band}}`, bands `pass`, `unsure`, `broken`, `unjudged`), `calls`, `questions`, `ms`, and `inputTokens`, `costUsd` and `model` when known.

`--timeout-ms` (default 15000) bounds the whole run; a request still pending then is not judged.

## Claude Code Stop hook

With `--stop-hook`, standard input is the hook's JSON payload and the text is its `last_assistant_message`. A refusal exits 2 and writes the broken rules and their statements to standard error, which Claude Code feeds back to the model; a judge outage must never block the agent, so every other judging outcome (compliant, unsure, error, timeout, missing configuration) exits 0 with the reason on standard error. A payload with `stop_hook_active: true` exits 0 without a request, which prevents a block loop. Setup errors (bad arguments or rules file) exit 1, a non-blocking error shown to the user. `--json` cannot be combined with `--stop-hook`.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y -p jev-agent-tools jev-check --rules .claude/jev-rules.json --stop-hook"
          }
        ]
      }
    ]
  }
}
```

## Limits

- The check is a probabilistic judgment of a text against statements, not a proof; an unsure rule is reported as not judged rather than guessed.
- One request is made per run (more only if the text exceeds the per-evaluation token bound and the client splits it, or after a retried failure); `calls` reports the actual number. The text and reference are sent to the configured endpoint.
- Each run builds its own client with its own request pool, which is fine for a one-shot process but means concurrent `jev-check` processes do not share concurrency limits.
- It does not honor `JEV_TOOLS_MAX_CALLS` or `JEV_TOOLS_MAX_USD`.
