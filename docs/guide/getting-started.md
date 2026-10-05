# Getting started

Steps from a clean host to a verified `jev-agent-tools` install, and the switches that limit what it may do. The authoritative contract for each tool lives in [docs/tools/](../tools/); this page does not repeat those parameter tables. Installation commands, flags and variable semantics are those of the [Configure](../../README.md#configure) and [Install](../../README.md#install) sections of the README; the version below is the one printed there.

Guide index: [getting started](getting-started.md) · [workflows](workflows.md) · [troubleshooting](troubleshooting.md)

## 1. Prerequisites

- Node.js 24 or later. omp uses its Bun runtime; Node.js is also required for Node-based project checks.
- A supported host baseline: pi 0.87.1 or omp 18.4.10. These are support baselines, not claims that every later version has been individually validated.
- Git. Bash as well, if you intend to use optional `command` evidence in [jev_ask](../tools/jev_ask.md).
- A Jev-API-compatible endpoint URL and Bearer credential of your own. There is no built-in endpoint and no chat-model fallback.
- Optional native parsers and file-search acceleration may be unavailable on some platforms; affected tools report their limitations rather than silently narrowing their evidence.

## 2. Install

Install through your host's package manager. The package ships TypeScript sources; no separate compilation is required.

### pi

```sh
pi install npm:jev-agent-tools@0.1.4
# Project-local installation:
pi install -l npm:jev-agent-tools@0.1.4
```

### omp

```sh
omp plugin install jev-agent-tools@0.1.4
```

Two packaging details worth knowing before you install: the `pi 1.0.0` check recorded in the README found a non-blocking `@sinclair/typebox` warning about duplicate runtime modules, and the release smoke used a simulated conversation provider and endpoint, so it verifies host integration rather than live model accuracy.

## 3. Configure

Three mechanisms exist, in this order of precedence **per field**: environment variable, then launch flag, then this session's setup, then saved configuration, then the default model `openjev`. A field set by the environment or a flag is shown as controlled and is never saved. Environment variables are read when the extension loads; a setup change applies immediately, without restarting the host.

### 3.1 Interactive setup

In the main interactive terminal of pi or omp, a first launch without configuration offers **Configure now / Later**. Run `/jev-setup` at any time to change the endpoint, model or key. The key is typed in a masked field and is never passed as a command-line argument. Choose **This session only** (nothing is written) or **Save for future sessions**. Cancelling at any step changes nothing.

The flow asks for, in order:

1. `Complete Jev endpoint URL`, pre-filled with `https://your-service.example/v1/systemone`.
2. `Jev model (not the conversation model)`, pre-filled with `openjev`.
3. `Jev API key`, a masked secret prompt.
4. `Apply Jev configuration` with the options `This session only` and `Save for future sessions (editable values and plaintext key in a private global file)`.

A field controlled by the environment or a flag is skipped with a notice instead of a prompt. Setup waits for submission or cancellation without a credential-entry timeout, and the first-launch offer does not hold the host's startup event handler open while you look up the endpoint or key.

No dialog appears in print, JSON or RPC modes, or in sub-agents; `/jev-setup` there reports:

> Jev setup requires the main interactive terminal. Use JEV_TOOLS_URL, JEV_TOOLS_MODEL and JEV_TOOLS_API_KEY for headless runs.

### 3.2 Launch flags

| Flag | Effect |
|---|---|
| `--jev-skip-setup` | Suppress the first-launch offer for this run; `/jev-setup` still works. |
| `--jev-url <url>` | Endpoint for this run. |
| `--jev-model <name>` | Jev model for this run, not the conversation model. |

### 3.3 Environment variables

Set these before starting the host, using your own endpoint and credentials:

```sh
export JEV_TOOLS_URL="${YOUR_JEV_ENDPOINT}"
export JEV_TOOLS_API_KEY="${YOUR_JEV_API_KEY}"
# Optional; already the default:
export JEV_TOOLS_MODEL="openjev"
```

| Variable | Meaning |
|---|---|
| `JEV_TOOLS_URL` | Required complete endpoint URL compatible with the Jev API format. |
| `JEV_TOOLS_API_KEY` | Required Bearer credential; configuration values are not printed in tool output. |
| `JEV_TOOLS_MODEL` | Requested model string, default `openjev`; a moving alias, not a guarantee of served-model identity. |
| `JEV_TOOLS_MAX_CALLS` | Session-wide non-negative safe-integer call limit; absent or empty means unlimited. Invalid values refuse requests. |
| `JEV_TOOLS_MAX_USD` | Session-wide finite non-negative cost limit, including fractions; absent or empty means unlimited. Invalid values refuse requests. |
| `JEV_TOOLS_ALLOW_COMMAND` | `0` disables `command` in `jev_ask`; otherwise commands run with ordinary shell permissions, without an additional sandbox. |
| `JEV_TOOLS_AUTO_DOCS` | `0` disables the automatic run-end documentation check. |

The URL must be a full HTTP(S) URL without embedded credentials, and the key must be a nonempty HTTP-header-compatible string. A configuration that violates either is rejected with:

> Jev configuration requires a full HTTP(S) URL without embedded credentials, a nonempty HTTP-header-compatible API key, and a nonempty model.

### 3.4 Where the configuration is saved

Only **Save for future sessions** writes anything. Saved configuration lives outside the repository at `$XDG_CONFIG_HOME/jev-agent-tools/config.json` (default `~/.config/jev-agent-tools/config.json`), in a private directory (`0700`) with a private file (`0600`). **The key is stored in plaintext, not encrypted.** Storage that is a symlink, group/world-accessible, not owned by you or malformed is refused rather than overwritten; every read or write failure surfaces as:

> Cannot read or save Jev configuration. Check that the configuration directory and config.json are owned by you, private, regular storage without symlinks, and contain valid configuration JSON.

Confirming a save prints:

> Jev configuration applied and saved outside the repository. The stored key is plaintext, not encrypted.

Choosing **This session only** prints:

> Jev configuration applied for this session; no file was written.

## 4. Verify the install

With an endpoint and key in place, make one small call. The result below is **illustrative**, not a recorded execution; paths, probabilities and timings vary.

```json
{
  "goal": "Find where invoice amounts are rounded before storage",
  "keywords": ["invoice", "round"],
  "effort": "quick",
  "max_calls": 6
}
```

A first successful call looks like this shape, all on plain text:

```text
entry: src/billing/rounding.ts (0.81)
relevant:
  src/billing/rounding.ts 0.81
  src/billing/invoice.ts 0.44
  src/billing/format.ts 0.21
read src/billing/rounding.ts
1 calls · 1 questions · $0.00213 · cache 0/1 · 3.1 s
```

What that shape means, per `src/render.ts`: a **verdict** entry prints `entry: <path> (<p>)` with no mark and no candidate lines; `relevant:` lists the retained files with their two-decimal probabilities; and `read <paths>` names what to open next. When the band is `unsure`, the first line becomes `unsure  entry — read both` and the paths repeat underneath at two decimals instead.

What confirms the install:

- No refusal line. A refusal prints its own message, and the yield line still follows.
- An `entry:` line naming a repository-relative path, or a ranked list of answers when you use [jev_ask](../tools/jev_ask.md) or [jev_ask_files](../tools/jev_ask_files.md).
- A closing **yield** line: `calls · questions · cost · cache · time`. One tool invocation may require several requests for batching or controls, so the call count can exceed one.

If the tools stay registered but every call refuses judgment, the endpoint or key is missing; see [troubleshooting](troubleshooting.md#the-tools-refuse-every-call). Host integration can be checked without a judgment endpoint at all: the development checks in [CONTRIBUTING.md](../../CONTRIBUTING.md) make no Jev API calls and need no key.

## 5. Disable or limit what runs

### Commands

`JEV_TOOLS_ALLOW_COMMAND=0` removes `command` and `timeout_s` from the [jev_ask](../tools/jev_ask.md) parameters and disables command evidence. A call that still requests a command after the value is set answers:

> command disabled by JEV_TOOLS_ALLOW_COMMAND=0

Repository file confinement is a separate property and remains in force: absolute paths, parent traversal, escaping symlinks, Git metadata and internal URLs are not file inputs. Confining files does **not** sandbox a command. With commands enabled, they run with the host's shell permissions; omp applies execution approval, pi does not add per-tool command approval.

### The automatic documentation check

`JEV_TOOLS_AUTO_DOCS=0` disables the single run-end documentation check described in the [README](../../README.md#automatic-documentation-check). It never runs `risk` or `spec` automatically.

### Session budgets

`JEV_TOOLS_MAX_CALLS` and `JEV_TOOLS_MAX_USD` bound the whole session across every tool. Absent or empty means unlimited. Invalid values refuse every request before any call is made (verbatim, from `src/session.ts`):

> Invalid JEV_TOOLS_MAX_CALLS: expected a non-negative safe integer. No Jev call was made; correct the environment variable.

> Invalid JEV_TOOLS_MAX_USD: expected a finite non-negative number (fractional USD allowed). No Jev call was made; correct the environment variable.

Reaching a limit refuses the next request with the session total. These two are **illustrative instantiations** of the template in `src/session.ts`, with substituted values:

> JEV_TOOLS_MAX_CALLS=20 reached; session total: 20 Jev calls. No Jev call was made; the human sets this limit

> JEV_TOOLS_MAX_USD=0.50000 reached; session total: $0.51230. No Jev call was made; the human sets this limit

Limits are per session, not per invocation. Counters reset when a new session starts.

### Per-invocation request caps

`max_calls` on a single call is separate from the session limits. Reaching it stops further requests for that invocation and reports the stop with the next action. Both strings are verbatim; the first is a template in each budget path that accepts the parameter, the second is a literal in `src/core/output.ts`:

> max_calls=8 reached

> raise max_calls

[jev_locate_in_file](../tools/jev_locate_in_file.md) is the exception: it has no `max_calls` parameter and is bounded by the session limits alone.

Work stopped by a cap is preserved, not dropped: unjudged tests stay selected in [jev_select_tests](../tools/jev_select_tests.md), and unjudged units, callers, sections, requirements and severity are named in [jev_check_diff](../tools/jev_check_diff.md). Fractional cost budgets bound admission, not the exact final cost of a request.

### Data boundaries

Repository evidence, notes and optional command output go to your configured endpoint. The configured API key value is redacted from every payload string before sending, but automatic secret redaction beyond the key value is not promised. Commands run by [jev_ask](../tools/jev_ask.md) inherit the host environment, including `JEV_TOOLS_API_KEY`, and the host exec API offers no environment override, so a command can still read the key itself; `JEV_TOOLS_ALLOW_COMMAND=0` disables this command path. Review the endpoint's data-handling policy before using a confidential repository, and read [SECURITY.md](../../SECURITY.md) for the trust boundaries and private reporting route.
