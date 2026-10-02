# 0002 — One HTTP protocol across hosts

Status: Accepted

## Context

pi and omp provide different integration APIs. Delegating judgment to a host's chat model would change the protocol and behavior according to the host.

## Decision

Use one HTTP client compatible with the Jev API format in both hosts. Read the user-supplied endpoint and Bearer credential from JEV_TOOLS_URL and JEV_TOOLS_API_KEY and the requested model from JEV_TOOLS_MODEL, defaulting to openjev.

Without the endpoint or key, keep tools registered and explain the missing configuration; disable the automatic documentation check. Never fall back to a chat model or a host-internal judgment service.

## Consequences

Users choose the service and must review which evidence it receives. Host adapters manage registration and lifecycle, not a second judgment implementation. Configuration failures remain explicit rather than producing superficially equivalent answers.
