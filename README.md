# jev-agent-tools

Six evidence-oriented tools for pi and omp, compatible with the Jev API format. Use them to navigate unfamiliar code, ask typed questions about repository evidence, review completed changes and select existing tests. They complement reading, searching and execution; they do not replace them.

## Install

Install through your host's package manager. The npm package is `jev-agent-tools`. It ships TypeScript sources; no separate compilation is required.

### pi

```sh
pi install npm:jev-agent-tools@0.1.3
# Project-local installation:
pi install -l npm:jev-agent-tools@0.1.3
```

### omp

```sh
omp plugin install jev-agent-tools@0.1.3
```

### Requirements and compatibility

Requires Node.js 24 or later. Supported host baselines are pi 0.87.1 and omp 18.4.10. These are support baselines, not claims that every later version has been individually validated. omp uses its Bun runtime; Node.js is also required for Node-based project checks. Git and, for optional command evidence, Bash must be available. Optional native parsers and file-search acceleration may be unavailable on some platforms; affected tools report their limitations.

## Configure

Set these before starting the host, using your own endpoint and credentials:

```sh
export JEV_TOOLS_URL="${YOUR_JEV_ENDPOINT}"
export JEV_TOOLS_API_KEY="${YOUR_JEV_API_KEY}"
# Optional; already the default:
export JEV_TOOLS_MODEL="openjev"
```

`YOUR_*` placeholders are inputs you supply, not additional product settings. Configuration is read when the extension loads; restart the host after changing it.

| Variable | Meaning |
|---|---|
| `JEV_TOOLS_URL` | Required complete endpoint URL compatible with the Jev API format. |
| `JEV_TOOLS_API_KEY` | Required Bearer credential; configuration values are not printed in tool output. |
| `JEV_TOOLS_MODEL` | Requested model string, default `openjev`; a moving alias, not a guarantee of served-model identity. |
| `JEV_TOOLS_MAX_CALLS` | Session-wide non-negative safe-integer call limit; absent or empty means unlimited. Invalid values refuse requests. |
| `JEV_TOOLS_MAX_USD` | Session-wide finite non-negative cost limit, including fractions; absent or empty means unlimited. Invalid values refuse requests. |
| `JEV_TOOLS_ALLOW_COMMAND` | `0` disables `command` in `jev_ask`; otherwise commands run with ordinary shell permissions, without an additional sandbox. |
| `JEV_TOOLS_AUTO_DOCS` | `0` disables the automatic run-end documentation check. |

Without the endpoint or key, tools remain registered and explain the missing configuration; the automatic documentation check is disabled. There is no fallback to a chat model. Per-tool `max_calls` is separate from session limits. A model name echoed by the response does not establish which model was actually served.

## Choose a tool

| Tool | Choose it when |
|---|---|
| [jev_ask](docs/tools/jev_ask.md) | One judgment combines a note, files, earlier versions or command output. |
| [jev_ask_files](docs/tools/jev_ask_files.md) | The same questions apply independently to each candidate file. |
| [jev_find_files](docs/tools/jev_find_files.md) | You need an entry point for a behavioral goal and do not know its filename. In omp, use native `find` when active. |
| [jev_locate_in_file](docs/tools/jev_locate_in_file.md) | You need the relevant range in one file of at least 19 KB. |
| [jev_check_diff](docs/tools/jev_check_diff.md) | Completed changes need risk, existing-documentation or specification review. |
| [jev_select_tests](docs/tools/jev_select_tests.md) | You need commands for affected existing tests, without running or collecting them. |

Use native read/search tools or code for exact source text, known symbols, filenames, line numbers, counts and arithmetic. Run commands yourself when you need their full output. Tool reference examples use fictional repository paths and are illustrative calls, not recorded executions.

## Read the results

A line without a mark is a **verdict**: a lead to check before editing, deleting or reporting completion, not a proof. Probabilities concern the evidence shown, not everything in your repository.

| Mark | Meaning and next action |
|---|---|
| `unsure` | The answer is ambiguous or a control failed. Read the indicated passage or add the specific evidence that would settle it. Do not merely reword the question. |
| `abstain` | A necessary piece is missing. Add the named file or command evidence and ask once. |
| `no (not shown)` / `not addressed` | The supplied evidence does not show the statement; that does not make it false. |
| `uncalibrated` | No established error-rate calibration applies to this ask; treat it as a hint even if its probability is high. |
| Bracketed lines | Collection, parsing, budget or display limitations, with the next manual action. |

Ordinary boolean verdict bands are at or below 0.20 and at or above 0.80; category/level verdicts require a leading-option probability of at least 0.85 after applicable controls. Fixed checks and navigation tools have their own thresholds, described in their references and [design](docs/design.md).

The footer reports **calls · questions · cost · cache · time**: request count, questions judged, reported USD cost, cache hits/requests and elapsed time. A tool invocation may require several requests for batching or controls. Missing cost reporting is not evidence of a free request.

In a final report, explicitly identify conclusions marked `unsure` or `abstain` as unconfirmed by Jev. If subsequent reading settles them, distinguish that verification from the tool's result and cite the decisive evidence. Otherwise retain the uncertainty in your summary and recommendation.

## Usage guidance for pi and omp

The extension supplies the shared reading guide in both hosts. omp discovers enabled npm plugin rules during normal startup; pi does not automatically discover the package's `rules/` directory. In pi, the same decision policy is part of the `jev_ask` tool guidelines, so it is present whenever `jev_ask` is active. A forced opaque prompt override may bypass this integration; disabled tools or disabled omp rules are not covered. This README block is recommended usage guidance, not itself an installed instruction:

> Before concluding that a failure is a code bug, an incorrect test or an environment problem, or that a plan matches documentation, pass the relevant files to [jev_ask](docs/tools/jev_ask.md) and weigh its answer against your own reading. Include both the failing test and the code it exercises; identify any conclusion that remains unconfirmed.

## Data and command safety

Repository evidence, notes and optional command output are sent to your configured endpoint. Review its data-handling policy before using confidential repositories. See [security guidance](SECURITY.md).

File collection is confined to the repository: absolute paths, parent traversal, escaping symlinks, Git metadata and internal URLs are not file inputs. Build output, binaries, lockfiles and oversized files are skipped or refused with visible limits; evidence is not silently truncated into a verdict. This confinement does **not** sandbox a command. `jev_ask` commands can read, write or access the network with the host's shell permissions. omp uses execution approval for commands; pi does not supply an additional per-tool command approval. Set `JEV_TOOLS_ALLOW_COMMAND=0` to disable them.

## Automatic documentation check

On a dirty tree, the extension can check existing Markdown documentation once at run end against changes from `HEAD`, including untracked files. A flagged existing sentence can request one additional turn to update it or explain why it remains correct. Merely unsure sections do not trigger another turn. Missing configuration, disabled automation, invalid/exhausted session budgets or a clean tree skip the check. Errors and timeout do not block the host. This is not a check for every missing documentation obligation.

## Known limits

Static evidence and probability do not prove execution, safety or completeness. Import closure cannot discover every relationship; dynamic code, unsupported syntax and optional parser failures leave explicit gaps. No findings is not proof that unseen callers or documentation are correct. Test selection considers existing discovered scenarios, not whether a new scenario must be added. Session caching cannot establish the identity or stability of a moving model alias.

## Development and contributions

See [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), [design](docs/design.md) and [architecture decisions](docs/adr/). Development checks run locally without contacting a judgment endpoint:

```sh
npm ci --include=optional
npm run typecheck
npm run check:imports
npm run lint
npm test
```

Internal source modules are implementation details, not a stable library interface.

## License

[MIT](LICENSE).
