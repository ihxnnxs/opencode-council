# Security Policy

## Supported Versions

Security fixes are provided for the latest published minor version.

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories when available, or by opening a minimal issue that does not include exploit details.

## Safety Model

`opencode-council` is designed to keep council members read-only by default.

- Advisor sessions use the `council-advisor` agent registered by this plugin.
- The agent denies edits and shell commands by default.
- Advisor prompts explicitly instruct members not to modify files.
- The tool disables known write-capable tools for child prompts.

Do not run untrusted external CLI advisors with write permissions. If external CLI adapters are added later, they must use real read-only sandboxes and pre/post diff checks.
