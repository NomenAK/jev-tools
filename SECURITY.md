# Security policy

## Supported versions

Security fixes target the latest patch release in the 0.1.x series. Older 0.1.x patches should be upgraded; 0.0.x and unreleased snapshots are not supported releases.

## Report privately

Use GitHub's [Report a vulnerability](https://github.com/NomenAK/jev-tools/security/advisories/new) form. Do not disclose vulnerabilities in public issues or pull requests. If the form is unavailable, open an issue asking to restore private reporting, without vulnerability details. There is no email reporting channel.

Include the affected version, impact, and a minimal reproduction using synthetic data. Never include live credentials, private repository contents, or personal configuration. If a credential may have been exposed, revoke or rotate it independently of this report.

This is a solo-maintained project. Reports are reviewed on a best-effort basis; there is no guaranteed acknowledgement or fix deadline. Follow-up and disclosure coordination take place in the private report. Please coordinate public disclosure there.

## Scope and trust boundaries

Report repository-confinement escapes in file evidence collection, including reads outside the selected repository; unintended secret exposure caused by jev-tools; and unintended command execution or bypasses of disabled command execution.

File evidence collection is confined to the repository, but optional commands are not sandboxed: they run with the host's permissions and may read or modify files or access the network. `JEV_TOOLS_ALLOW_COMMAND=0` disables this command path. Selected repository evidence and requested command output are sent to the configured API endpoint. Review the data and endpoint before use.

### Secret-named files are refused

Every evidence admission path (`jev_ask` paths and import closure, `jev_ask_files`, `jev_find_files`, `jev_locate_in_file`, `jev_check_diff` diff units and local callers, `jev_select_tests` inventory and the automatic pi/omp documentation check) refuses a file whose base name matches `.env`, `.env.*`, `*.pem`, `id_rsa*`, `*.p12`, `credentials*` or `secrets*`, at any depth and case-insensitively, whatever its Git status (tracked, untracked or added). `.env.example`, `.env.sample` and `.env.template` remain admitted. The refusal happens before the content is read: the result names the path with cause `secret_pattern`, and a question that explicitly requires that file stays unjudged. There is no per-call or environment override. Files with other names are not inspected for secrets.

### Commands never receive the API key

`jev_ask` commands and the Windows PowerShell ACL helper run with the host environment minus `JEV_TOOLS_API_KEY`. Before command output enters a state, every occurrence of the configured key value, whether it came from the environment or the saved configuration, is replaced with `[redacted]` in stdout, stderr and the echoed command line; the result reports how many replacements were made. Detection of other secrets in command output is not promised.

### The key travels only over HTTPS or loopback

`JEV_TOOLS_URL` must use `https:`. Plain `http:` is accepted only for `127.0.0.1`, `::1` or `localhost`; any other `http:` URL is a configuration error, reported without the URL or key and before any request, so the Bearer key is never sent in clear text over a network.

### Automatic documentation check

On pi and omp, the run-end documentation check (disable with `JEV_TOOLS_AUTO_DOCS=0`) sends changed units from a dirty tree to the endpoint without an explicit tool call, including admitted untracked files that are not gitignored. Secret-named files are refused as above; anything else untracked and not ignored can be sent. Keep sensitive scratch files gitignored or outside the repository.

Saved interactive configuration stores the API key in plaintext in a private user-level file (`~/.config/jev-agent-tools/config.json` by default). Privacy uses each operating system's own model: owner-only mode bits on POSIX; on Windows, an access list whose allow entries are only the current user, SYSTEM and Administrators, read by SID through the system Windows PowerShell. Protect the account and back-ups accordingly, or use environment variables from a secret manager instead.

The MCP server (`jev-agent-tools-mcp`) has the same boundaries. It talks to its client only over stdio and opens no network listener. MCP client configuration files that contain a literal API key are as sensitive as the saved configuration; prefer the client's environment-variable interpolation and do not commit such files. Tool approval is the MCP client's responsibility; the server marks `jev_ask` as not read-only while commands are enabled.

Command cancellation and timeout, and MCP connection shutdown, complete bounded termination of the managed process group on POSIX or await the system process-tree termination operation on Windows. This is cleanup, not containment: deliberately detached descendants or processes that escape that tree are not tracked, and previously completed side effects are not undone.

Expected execution of an explicitly supplied command, intentional submission of evidence, inaccurate judgments, and ordinary bugs or feature requests are not by themselves security vulnerabilities. Report ordinary product problems through issues; report host or API-service vulnerabilities to their respective maintainers. If unsure about a jev-tools security impact, use the private form.
