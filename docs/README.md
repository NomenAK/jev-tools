# Documentation index

## Users

- [README](../README.md) — install, configuration, tool chooser, result marks, footer, data safety.
- [Getting started](guide/getting-started.md) — first run, setup, first judgment.
- [Workflows](guide/workflows.md) — which tool for which job.
- [Troubleshooting](guide/troubleshooting.md) — configuration errors, refusals, limits.
- Tool references (parameter contracts): [jev_ask](tools/jev_ask.md), [jev_ask_files](tools/jev_ask_files.md), [jev_find_files](tools/jev_find_files.md), [jev_locate_in_file](tools/jev_locate_in_file.md), [jev_check_diff](tools/jev_check_diff.md), [jev_select_tests](tools/jev_select_tests.md).

## How it works

- [Internals overview](internals/README.md) — shared request lifecycle, reading order.
- [Engine](internals/engine.md) — admission, batching, HTTP client, budgets, bands, witnesses, run-end check.
- Per-tool logic: [jev_ask](internals/jev_ask.md), [jev_ask_files](internals/jev_ask_files.md), [jev_find_files](internals/jev_find_files.md), [jev_locate_in_file](internals/jev_locate_in_file.md), [jev_check_diff](internals/jev_check_diff.md), [jev_select_tests](internals/jev_select_tests.md).
- [Design policy](design.md) — thresholds, bounds, glossary.

## Contributors

- [Architecture](architecture.md) — code map, layering, extension registration, adding a tool.
- [CONTRIBUTING](../CONTRIBUTING.md) — issues vs PRs, local checks, expectations.
- [Architecture decisions](adr/) — durable trade-offs (start with [ADR 0001](adr/0001-strict-typescript-pure-core-offline-tests.md)).
