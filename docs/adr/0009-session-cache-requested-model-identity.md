# 0009 — Session-local caching and requested-model identity

Status: Accepted

## Context

Repeated identical judgments can reuse a result within a session, but optional commands can observe or mutate changing state. A model name in a response need not identify the implementation that actually served the request.

## Decision

Cache only successful non-command judgments in session memory. Include the requested model string in the cache identity along with the judgment inputs; do not persist the cache across sessions or cache command-bearing requests.

Treat JEV_TOOLS_MODEL as the requested model identity. The default openjev is a moving alias. A version-shaped request string or an echoed model field does not prove that the served model is pinned. Do not claim runtime model-drift detection from that string.

## Consequences

Session caching avoids repeated identical work without presenting command output as immutable. Changing the requested model separates cached judgments, but cannot establish the identity or behavior of the model actually served. Cache accounting remains visible in result output.
