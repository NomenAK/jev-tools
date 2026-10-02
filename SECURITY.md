# Security policy

## Supported versions

Security fixes target the latest patch release in the 0.1.x series. Older 0.1.x patches should be upgraded; 0.0.x and unreleased snapshots are not supported releases.

## Report privately

Use GitHub's [Report a vulnerability](https://github.com/NomenAK/jev-tools/security/advisories/new) form. Do not disclose vulnerabilities in public issues or pull requests. If the form is unavailable, open an issue asking to restore private reporting, without vulnerability details. There is no email reporting channel.

Include the affected version, impact, and a minimal reproduction using synthetic data. Never include live credentials, private repository contents, or personal configuration. If a credential may have been exposed, revoke or rotate it independently of this report.

This is a solo-maintained project. Reports are reviewed on a best-effort basis; there is no guaranteed acknowledgement or fix deadline. Follow-up and disclosure coordination take place in the private report. Please coordinate public disclosure there.

## Scope and trust boundaries

Report repository-confinement escapes in file evidence collection, including reads outside the selected repository; unintended secret exposure caused by jev-tools; and unintended command execution or bypasses of disabled command execution.

File evidence collection is confined to the repository, but optional commands are not sandboxed: they run with the host's permissions and may read or modify files or access the network. `JEV_TOOLS_ALLOW_COMMAND=0` disables this command path. Selected repository evidence and requested command output are sent to the configured API endpoint; automatic secret redaction is not promised. Review the data and endpoint before use.

Expected execution of an explicitly supplied command, intentional submission of evidence, inaccurate judgments, and ordinary bugs or feature requests are not by themselves security vulnerabilities. Report ordinary product problems through issues; report host or API-service vulnerabilities to their respective maintainers. If unsure about a jev-tools security impact, use the private form.
