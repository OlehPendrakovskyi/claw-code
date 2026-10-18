# Security policy

## Reporting a vulnerability

Please do not report a vulnerability in a public issue, pull request or discussion.

Report it privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to [the private reporting form](https://github.com/OlehPendrakovskyi/claw-code/security/advisories/new). Only the maintainer can see the report.

A useful report includes:

- what an attacker can do, and what they need first (a workspace the user opens, a Gateway they control, a position on the network, …);
- the steps to reproduce it, with the VSClaw version or commit, your VS Code version, and your operating system;
- which transport is involved: the Gateway WebSocket or the local acpx CLI;
- any logs, with your own tokens and secrets removed.

## What happens next

VSClaw has a single maintainer, so replies are best effort. You will get an answer in the private report, and the fix is developed in a private fork where it can be. Once a fixed version is available, the report is published as a GitHub security advisory, crediting you unless you ask not to be named.

## Supported versions

VSClaw has not had its first release yet. Until it does, fixes go to the `main` branch only. Once releases exist, only the latest one receives security fixes.

## Scope

In scope is the code in this repository: the VS Code extension. For example:

- the Gateway token or device identity leaking, or being sent somewhere other than the configured Gateway;
- credentials or prompt text reaching a log or another place they should not;
- a workspace getting a command run, a setting changed or an approval given without the user's consent;
- an attachment read from outside the file the user chose;
- script injection into the chat webview.

Out of scope are the OpenClaw Gateway, the `openclaw` and `acpx` CLIs, and the agents and model providers they use. Please report those to the [OpenClaw project](https://docs.openclaw.ai).
