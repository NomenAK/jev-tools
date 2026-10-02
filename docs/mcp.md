# MCP setup guide

`jev-agent-tools-mcp` is a stdio [MCP](https://modelcontextprotocol.io) server that exposes the same six `jev_*` tools as the pi and omp extension to any MCP client. It ships in the `jev-agent-tools` npm package, has no runtime dependencies beyond that package, and runs one session per server process.

Setup takes three steps: provide the endpoint and key, register the server with your client, and add the [agent instructions](agent-instructions.md) to your project.

## 1. Requirements

- Node.js 24 or later, and Git, on the machine that runs the client.
- Bash for optional `jev_ask` command evidence. On Windows this is Git for Windows bash, found automatically next to `git` or under Program Files; set `JEV_TOOLS_BASH` to use another. The WSL `bash.exe` launchers are never used.
- A Jev endpoint URL and API key.

The server is available from the first release after 0.1.4. Until then, use a clone (see [From a clone](#from-a-clone)).

## 2. Provide the endpoint and key

The server reads, per field, the environment first and then the configuration saved by `/jev-setup` in pi or omp. There is no interactive setup inside MCP.

| Variable | Required | Meaning |
|---|---|---|
| `JEV_TOOLS_URL` | yes | Complete endpoint URL compatible with the Jev API format. |
| `JEV_TOOLS_API_KEY` | yes | Bearer credential. Never printed in tool output. |
| `JEV_TOOLS_MODEL` | no | Requested model, default `openjev`. |
| `JEV_TOOLS_ROOT` | no | Repository directory when `--root` is not given. |
| `JEV_TOOLS_MAX_CALLS`, `JEV_TOOLS_MAX_USD` | no | Session call and cost limits for this server process. |
| `JEV_TOOLS_ALLOW_COMMAND` | no | `0` removes `command` from `jev_ask`. |
| `JEV_TOOLS_BASH` | no | Full path of the bash used for commands on Windows. |

Prefer passing secrets through your client's environment-variable interpolation (shown per client below) rather than writing the key into a committed file. Saved configuration from `/jev-setup` lives in `~/.config/jev-agent-tools/config.json` and is refused unless the directory and file are private; on Windows that check cannot pass, so use environment variables there. Unusable saved storage is reported on the server's stderr and never stops the server.

Without an endpoint and key the server still starts, lists the tools and answers each call with what is missing.

## 3. Register the server

Every example registers a server named `jev`. Replace the repository path. The repository the tools work in is `--root`, else `JEV_TOOLS_ROOT`, else the directory the client starts the server in.

**Windows:** most clients start the command without a shell, and `npx` is a `.cmd` script there, so `"command": "npx"` fails to start. Use `"command": "cmd"` with `"args": ["/c", "npx", ...]`, as in the Windows examples. This was checked on Windows 11 with Node.js 24: a shell-less spawn of `npx` failed with `ENOENT`, `cmd /c npx` started the server.

The shared arguments are:

```text
npx -y -p jev-agent-tools jev-agent-tools-mcp --root <repository>
```

`-p jev-agent-tools` is required because the binary name differs from the package name. Pin a version (`jev-agent-tools@X.Y.Z`) for reproducible setups.

### Claude Code

For a private registration, add it from the project directory with the CLI. Your shell expands the variables, so the values are stored in your private `~/.claude.json`, not in the project:

```sh
claude mcp add --scope local --env JEV_TOOLS_URL="$JEV_TOOLS_URL" --env JEV_TOOLS_API_KEY="$JEV_TOOLS_API_KEY" --transport stdio jev -- npx -y -p jev-agent-tools jev-agent-tools-mcp --root .
```

To share the server with the team, write `.mcp.json` at the project root instead. Claude Code expands `${VAR}` and `${VAR:-default}` from each user's environment when it loads the file, so no key is committed:

```json
{
  "mcpServers": {
    "jev": {
      "command": "npx",
      "args": ["-y", "-p", "jev-agent-tools", "jev-agent-tools-mcp", "--root", "${CLAUDE_PROJECT_DIR:-.}"],
      "env": {
        "JEV_TOOLS_URL": "${JEV_TOOLS_URL}",
        "JEV_TOOLS_API_KEY": "${JEV_TOOLS_API_KEY}"
      }
    }
  }
}
```

On Windows use `"command": "cmd"` and prepend `"/c", "npx"` to `args`. Check with `claude mcp list`. Add the instructions to `CLAUDE.md` ([template](agent-instructions.md#claudemd)).

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config): `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Claude Desktop has no project directory, so `--root` is required. Its documentation does not describe variable interpolation, so values here are literal; keep this file private.

```json
{
  "mcpServers": {
    "jev": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "-p", "jev-agent-tools", "jev-agent-tools-mcp", "--root", "C:\\path\\to\\repository"],
      "env": {
        "JEV_TOOLS_URL": "https://your-jev-endpoint.example/judge",
        "JEV_TOOLS_API_KEY": "your-key"
      }
    }
  }
}
```

On macOS use `"command": "npx"` without `"/c", "npx"`. Restart Claude Desktop after saving. One server serves one repository; add a second entry with another name for another repository.

### Kiro (IDE and CLI)

Workspace: `.kiro/settings/mcp.json`. User: `~/.kiro/settings/mcp.json`. The workspace file wins for a server of the same name. Kiro expands `${VAR}`.

```json
{
  "mcpServers": {
    "jev": {
      "command": "npx",
      "args": ["-y", "-p", "jev-agent-tools", "jev-agent-tools-mcp", "--root", "."],
      "env": {
        "JEV_TOOLS_URL": "${JEV_TOOLS_URL}",
        "JEV_TOOLS_API_KEY": "${JEV_TOOLS_API_KEY}"
      },
      "disabled": false,
      "autoApprove": ["jev_ask_files", "jev_find_files", "jev_locate_in_file", "jev_check_diff", "jev_select_tests"]
    }
  }
}
```

`autoApprove` above leaves `jev_ask` on manual approval because it can run shell commands. On Windows use `"command": "cmd"` with `"/c", "npx"` first in `args`. Add the instructions as a steering file ([template](agent-instructions.md#kiro-steering)).

### Cursor

Project: `.cursor/mcp.json`. Global: `~/.cursor/mcp.json`. Cursor expands `${env:NAME}` and `${workspaceFolder}`.

```json
{
  "mcpServers": {
    "jev": {
      "command": "npx",
      "args": ["-y", "-p", "jev-agent-tools", "jev-agent-tools-mcp", "--root", "${workspaceFolder}"],
      "env": {
        "JEV_TOOLS_URL": "${env:JEV_TOOLS_URL}",
        "JEV_TOOLS_API_KEY": "${env:JEV_TOOLS_API_KEY}"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Workspace: `.vscode/mcp.json`. The top-level key is `servers`, not `mcpServers`.

```json
{
  "servers": {
    "jev": {
      "command": "npx",
      "args": ["-y", "-p", "jev-agent-tools", "jev-agent-tools-mcp", "--root", "${workspaceFolder}"],
      "env": {
        "JEV_TOOLS_URL": "https://your-jev-endpoint.example/judge",
        "JEV_TOOLS_API_KEY": "${input:jev-api-key}"
      }
    }
  },
  "inputs": [
    { "type": "promptString", "id": "jev-api-key", "description": "Jev API key", "password": true }
  ]
}
```

The `inputs` prompt follows VS Code's MCP configuration reference; check it for your VS Code version.

### OpenAI Codex CLI

```sh
codex mcp add jev --env JEV_TOOLS_URL=https://your-jev-endpoint.example/judge -- npx -y -p jev-agent-tools jev-agent-tools-mcp --root .
```

Or in `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`). `env_vars` forwards variables from your environment without writing them into the file:

```toml
[mcp_servers.jev]
command = "npx"
args = ["-y", "-p", "jev-agent-tools", "jev-agent-tools-mcp", "--root", "."]
env_vars = ["JEV_TOOLS_URL", "JEV_TOOLS_API_KEY"]
```

Add the instructions to `AGENTS.md` ([template](agent-instructions.md#agentsmd)).

### Windsurf and other clients

Clients that use an `mcpServers` object accept the Claude Code JSON entry above. Windsurf reads `mcp_config.json` (see its MCP documentation for the current path) and expands `${env:NAME}`.

## 4. Verify

Run the server once by hand; it reads protocol messages from stdin and writes diagnostics to stderr:

```sh
npx -y -p jev-agent-tools jev-agent-tools-mcp --version
npx -y -p jev-agent-tools jev-agent-tools-mcp --root . < /dev/null
```

In PowerShell, run the second as `$null | npx -y -p jev-agent-tools jev-agent-tools-mcp --root .`.

The second command prints `jev-agent-tools MCP server ready (root ...; endpoint configured)` on stderr and exits when stdin closes. In the client, the six tools should be listed: `jev_ask`, `jev_ask_files`, `jev_find_files`, `jev_locate_in_file`, `jev_check_diff`, `jev_select_tests`. Ask the agent to run `jev_ask` with a one-line note and a yes/no question; the result ends with the calls, cost and time footer.

## From a clone

```sh
npm ci --include=optional
npm run build
```

Then use `"command": "node"` with `"args": ["/absolute/path/to/jev-tools/dist/mcp/main.js", "--root", "<repository>"]`. This form also avoids the Windows `npx` issue. Node does not strip TypeScript types under `node_modules`, which is why the server ships as compiled `dist/` while pi and omp load `src/`.

## Differences from pi and omp

- **No run-end documentation check.** It is a host hook. Before finishing, ask the agent to call `jev_check_diff` with `check: "docs"`; the [instructions](agent-instructions.md) say so.
- **Approval is the client's.** `jev_ask` is annotated as not read-only and potentially destructive while it accepts `command`; the other five are read-only. All six are open-world because evidence goes to your endpoint. `JEV_TOOLS_ALLOW_COMMAND=0` removes `command` from the schema and makes `jev_ask` read-only.
- **Instructions.** The reading guide and the `jev_ask` policy are sent as the server's `instructions`. Clients may ignore them, so also add the [agent instructions](agent-instructions.md) to the project.
- **Tool names in descriptions** refer to "your text search tool" and "your file-name search tool" instead of pi or omp tool names.
- **Protocol.** Versions 2024-11-05 through 2025-11-25 via `initialize`, 2026-07-28 via `server/discover`. Tools only; no resources, prompts or sampling. Cancelling a call aborts its Jev requests and command.
- **One process, one session.** Limits, cache and counters last as long as the connection; restart the server to reset them.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Client shows the server failed to start on Windows | `npx` cannot start without a shell. Use `cmd /c npx` or `node <path>/dist/mcp/main.js`. |
| `jev-tools is not configured` in every result | The server did not receive `JEV_TOOLS_URL` and `JEV_TOOLS_API_KEY`. Check the client's `env` block and that interpolated variables exist where the client was started. |
| stderr: `Cannot read or save Jev configuration` | Saved `/jev-setup` storage is not private or is malformed. Environment variables still apply; fix permissions or delete the file. |
| `Repository directory not found` | `--root` or `JEV_TOOLS_ROOT` points to a missing directory. |
| Command evidence reports `Command executable unavailable` | No usable bash. Install Git for Windows or set `JEV_TOOLS_BASH`. |
| Results from the wrong repository | The client started the server elsewhere. Pass an absolute `--root`. |

## Data and safety

Repository evidence, notes and command output are sent to your configured endpoint; review its data-handling policy first. File collection is confined to the repository, but `jev_ask` commands run with your shell permissions and no sandbox. See [SECURITY.md](../SECURITY.md).
