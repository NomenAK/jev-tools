# jev_select_tests

Select affected existing tests from a diff and return runner commands without running or collecting tests.

## Use for

After editing code, decide which existing scenarios to execute while preserving conservative fallbacks and runner context.

## Use another tool when

Use native reading/search to inspect exact test names and shell execution to run them. Use [jev_check_diff](jev_check_diff.md) for risk or documentation review, and [jev_ask](jev_ask.md) for one test-versus-implementation judgment. This tool does not decide whether a new test scenario must be written.

## Evidence model

Static discovery reads tracked tests, literal project configuration and imports without evaluating third-party configuration or invoking collection. Import closure includes unchanged intermediates and applicable pytest `conftest` fixtures. Touched tests are selected without judgment. Remaining scenarios receive changed-unit pointers, using test and import evidence. Runtime and type tests remain separate; commands preserve working directory, config, project, framework and project options.

Residual exported-unit checks concern changed units not exercised by any discovered test, only within the discovered inventory. They are not global coverage reports or obligations to add a scenario. Unsupported or unresolved runners keep that conclusion unsure and name a manual next action.

## Parameters

| Field | Type / default | Meaning |
|---|---|---|
| `root` | Optional nonempty string | Exact initial Git root or registered worktree of the same repository; see [evidence-root admission](../../README.md#evidence-root). |
| `base` | Optional nonempty Git ref, default `HEAD` | Compare the current tree with this revision. |
| `paths` | Optional array of nonempty strings, default discovered inventory | Candidate test files or globs, not changed source paths. |
| `witnesses` | Optional `"off"`, `"auto"` (default), `"on"` | Controls residual coverage checks; test pointers have no witnesses. |
| `max_calls` | Optional non-negative integer | Bound requests; unjudged scenarios remain selected. Separate from session budgets. |

Unknown fields and unresolved refs are rejected with guidance. Repository-relative evidence paths are confined to the repository; internal URLs are not file inputs. Narrowing candidate paths also narrows the inventory to which coverage observations apply.

Each requested criterion reports its matches and any excluded or unmatched inventory. Partial matches keep the matched selection and identify the unmatched criteria; zero matches are not proof of no affected tests. Changed files outside the supported dependency graph retain conservative widening, with the triggering paths named. Runner commands remain static plans and use the admitted root.

## Example

Illustrative call with fictional repository paths, not a recorded execution:

```json
{
  "base": "HEAD",
  "paths": ["test/**/*.test.ts"],
  "witnesses": "auto",
  "max_calls": 8
}
```

## Results and next action

Inspect selected scenarios and the returned runner commands, then execute them yourself. A scenario is selected when `1 - p(none) >= 0.5`; missing answers are selected too. If at least 80% of a file's scenarios are selected, names are uncertain or counts unknown, the command runs the whole file instead of a fragile name filter. Commands remain separate when runner context differs.

Static selection identifies its deterministic reason separately from fresh/cache Jev judgments. Conservative fallback preserves tests when judgments are unavailable; it is not confirmation that every scenario is affected. Residual absence is a derived reservation linked to retained coverage items or the considered inventory, not an extra requested judgment or fabricated probability. It does not establish repository-wide uncovered behavior. Read material limits and follow the named native action. See [shared result reading](../../README.md#read-the-results).

## Limits and failure behavior

No tests are executed or collected. Discovery is static and runner/version support is bounded; calculated config, unresolved runners, dynamic names and missing optional parsers can prevent precise filtering. Unavailable Jev or exhausted budgets preserve tests rather than silently dropping them. Whole-file fallbacks avoid unsafe name filtering but do not prove the discovery inventory complete. Residual coverage witnesses check setup, not execution. This tool cannot infer required new scenarios or replace actual verification.

## Host differences

Both hosts share static discovery and command planning; omp marks this tool read-only. Host-native tools perform execution separately. Optional parser availability changes evidence precision and is reported, not concealed behind a host-specific judgment implementation.

## Related tools

[Diff review](jev_check_diff.md), [combined judgment](jev_ask.md), [design policy](../design.md).
