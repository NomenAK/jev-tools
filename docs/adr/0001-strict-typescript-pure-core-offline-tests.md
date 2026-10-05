# 0001 — Strict TypeScript, a pure core and offline conformance tests

Status: Accepted

## Context

The same extension runs inside pi and omp. Host-specific implementations would duplicate judgment policy and make deterministic checks harder to maintain. Optional native capabilities must not become mandatory runtime dependencies.

## Decision

Use one strict TypeScript package with erasable syntax, Node APIs and fetch rather than Bun-only APIs. Pure core transformations and question compilation consume and return values; thin adapters own host, filesystem, Git, network and clock effects. Tools compose collection, evidence construction, requests and result rendering. Discriminated unions represent expected refusals, unjudged work and abstention as values rather than exceptional control flow.

Keep limits and thresholds in src/constants.ts. Batch questions for the same evidence state, run independent work concurrently under the shared limiter, and bound reads before loading content into memory.

Enforce downward import layers, including erased type dependencies:

- core/ imports core/, constants.ts, result.ts, result-types.ts and type-only contracts from jev/types.ts.
- presets/ and adapters/ each import their own layer, core/ and those neutral modules; adapters/ does not import presets/ or tools/.
- jev/ imports its own layer, core/, constants.ts, result.ts and result-types.ts.
- texts/ imports its own layer, constants.ts and presets/; it has no external dependencies.
- constants.ts and result-types.ts import nothing. result.ts may import the dependency-free result-types.ts contract. Root integration modules and tools/ compose the layers.

Reject all cycles, including type-only cycles, and nonliteral module loading. Shared contracts belong below their consumers. Pure layers do not import external modules, with explicit core exceptions for pure node:path functions and erased import type contracts from @ast-grep/napi. Inline type specifiers that retain runtime loading do not qualify. Filesystem, process and network modules, direct fetch calls and Node builtin-module loaders are forbidden in the core; import checks are not an exhaustive proof against indirect global effects.

Keep @ast-grep/napi, @ast-grep/lang-python and @ff-labs/fff-node optional. Load native parsing and search at the edges, use the available fallback and report missing capabilities rather than claiming equivalent syntax precision.

Run deterministic offline conformance checks with tsc --noEmit, the import checker, Biome and node --test. Use constructed behavior and boundary cases and local HTTP fixtures for transport failures, retries and timeouts; no Jev credentials are required.

## Consequences

This separates effects from policy and makes host-independent behavior reproducible. Missing optional acceleration can reduce parsing or search capability, so limits stay visible. Native optimization is not a reason to introduce a separate judgment path or an extension-specific daemon.
