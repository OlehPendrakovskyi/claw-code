# Claw Code

**Claw Code** is a VS Code extension for [OpenClaw](https://docs.openclaw.ai). It lets you chat with the agents on your OpenClaw Gateway from the editor, with your code as context. It also sets up, runs and hardens OpenClaw from the activity bar.

It has no telemetry. On the Gateway transport the extension talks only to the Gateway you configure. If the Gateway cannot be reached, it can fall back to the local [`acpx`](https://www.npmjs.com/package/acpx) CLI.

> **Pre-release.** Claw Code is not on the VS Code Marketplace or Open VSX yet. To use it, build and install it from source (see [Install](#install)). For what comes next, see [Status and roadmap](#status-and-roadmap).

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Connect to your Gateway](#connect-to-your-gateway)
- [Where your code lives](#where-your-code-lives)
- [Commands](#commands) · [Settings](#settings)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Status and roadmap](#status-and-roadmap)
- [Contributing](#contributing)

## Features

### Chat with Gateway agents

- **Direct Gateway connection.** The extension connects to the OpenClaw Gateway over WebSocket using Gateway protocol v4. If the connection drops, it reconnects with backoff. After a reconnect or a window restart, it fetches the messages you missed.
- **Agent and session picker.** Pick an agent's session and every message goes to it. An indicator shows when a run is already active.
- **History and resume.** Reopen an earlier session and continue where you left off.
- **Streaming replies.** Replies stream as they are written. Tool calls are grouped into collapsible steps, and a setting can hide the finished ones.
- **Approvals and questions in the chat.** When the Gateway needs approval for a command or a plugin action, or asks you a question, you answer it in the chat.
- **Stop** a running reply at any time.
- **Several threads at once.** Show threads in a grid from `1x1` up to `4x4`. Each thread has its own composer and status. You can also pop the chat out into an editor tab.
- **Usage gauge.** Shows the tokens used against the model's context window.
- **Export** a conversation to Markdown or JSON.

### Your code as context

- **`@`-mentions** attach workspace files. You can attach a range of lines, such as `@src/app.ts#L5-10`.
- **Insert selection** adds the selected code as a mention. The shortcut is `Alt+K` (`Cmd+Alt+K` on macOS).
- **Attach the open file** to every normal message with `openclaw.chat.attachOpenFile`. Slash commands do not use this setting; they add their own context (see the table below).
- **Attachments**, including images, through the `+` button or drag and drop.
- **Slash commands** add the context that fits the task:

| Command | Purpose | Context added |
| --- | --- | --- |
| `/explain` | Explain code or a concept | Selection or file |
| `/fix` | Find and fix problems | Diagnostics and code |
| `/review` | Review changes | Git diff |
| `/test` | Write tests | Selection or file |
| `/refactor` | Suggest improvements | Selection or file |
| `/doc` | Write documentation | Selection or file |
| `/commit` | Draft a commit message | Staged changes |
| `/harden` | Security review | File contents |
| `/plan` | Plan the work before changing anything | None (only your task) |
| `/compact` | Summarise the conversation so far | The transcript |
| `/search` | Search the codebase | Your query |

### OpenClaw tools

- **Overview view** in the activity bar, with these sections:
  - getting started;
  - operations: status, doctor, update, dashboard and config;
  - hardening;
  - installed tools, which you can enable, disable or uninstall;
  - help.
- **Security hardening.** Runs `openclaw security audit`, optionally with its fix and deep scans. It also writes a plain-language **access summary** of the MCP servers, tools, key sources, endpoints and local files OpenClaw can reach.
- **Guided setup** and a **model setup wizard**, for when the OpenClaw CLI is missing or not configured yet.
- **Status bar indicator** that shows the connection and connects in one click.

## Requirements

| Area | Supported |
| --- | --- |
| VS Code | 1.105 or newer |
| OpenClaw Gateway | Protocol v4 (OpenClaw 2026.9.x) |
| Operating systems | Linux, macOS and Windows (CI tests all three) |
| Remote development | SSH, WSL and Tunnel |
| VS Code forks (VSCodium, Cursor, …) | Planned through Open VSX; not tested yet |

You also need a chat backend. You can use either one, or both:

- **An OpenClaw Gateway you can reach, and its token.** This is the main path. The Gateway can run on this machine, on a server or NAS, or in Docker. To install one, see the [OpenClaw docs](https://docs.openclaw.ai) or run `openclaw onboard --install-daemon`.
- **[`acpx`](https://www.npmjs.com/package/acpx) on your `PATH`**, for the local CLI transport. With `openclaw.gateway.transport` set to `acpx`, no Gateway is needed. With `auto` (the default), acpx is used only when the Gateway cannot be reached.

## Install

Until the first release on the Marketplace and Open VSX, build and install from source. You need:

- **git**;
- **Node.js 24**, the version CI builds with;
- **pnpm** (run `corepack enable` to get it);
- the `code` or `cursor` command on your `PATH`.

On Linux, on macOS, or on Windows with Git Bash or WSL:

```sh
git clone https://github.com/OlehPendrakovskyi/claw-code.git
cd claw-code
pnpm install
scripts/install-local.sh
```

The script compiles the extension, packages it as a `.vsix` and installs it into `cursor` or `code`, whichever is on your `PATH`. Reload the window afterwards.

In PowerShell, or any shell without Bash, run the same steps by hand:

```sh
git clone https://github.com/OlehPendrakovskyi/claw-code.git
cd claw-code
pnpm install
pnpm run compile
pnpm dlx @vscode/vsce@4.0.0 package --no-dependencies -o claw-code.vsix
code --install-extension claw-code.vsix --force   # or: cursor --install-extension claw-code.vsix --force
```

> **The extension ID will change before the first release.** Today's build installs as `openknot.claw-code`, a publisher name inherited from the upstream project. The public release will use a publisher that this project owns. VS Code treats the new ID as a different extension, which has two effects:
>
> - Uninstall the old build first: `code --uninstall-extension openknot.claw-code`.
> - VS Code keeps stored secrets per extension ID. After the switch, you enter the Gateway token again and pair the device again.

## Connect to your Gateway

1. Set the Gateway address in **Settings → OpenClaw → Gateway: Url** (`openclaw.gateway.url`). The default is `ws://127.0.0.1:18789`.
2. Run **OpenClaw: Connect to Gateway** from the Command Palette and paste the Gateway token. The token is stored in VS Code's SecretStorage, never in `settings.json`.
3. Open the **OpenClaw** view in the activity bar. Pick an agent with **OpenClaw: Pick Agent Session**, and start chatting.

The first time you connect, the Gateway may ask you to approve this device. This step is called pairing. Approve the device on the Gateway, for example in the OpenClaw Control UI. To start again with a new device identity, run **OpenClaw: Reset Gateway Device Identity**.

> **Use `wss://` for a Gateway on another machine.** The token is sent as soon as the connection opens. Over plain `ws://`, a Gateway on a NAS or a server receives it unencrypted across the network. Claw Code warns you when this happens, but it still connects. Use `wss://` or a secure tunnel instead, such as SSH port forwarding, Tailscale or WireGuard.

### Local CLI fallback

`openclaw.gateway.transport` decides which backend the chat uses:

- `gateway`: always the Gateway.
- `acpx`: always the local CLI.
- `auto` (the default): the Gateway when it can be reached, otherwise acpx.

With acpx, `openclaw.chat.agent` chooses the agent and `openclaw.chat.permissions` decides what it may do. A workspace can redefine the agent command in an `.acpxrc.json` file. Claw Code uses that file only after you approve it, and asks again whenever the file changes.

## Where your code lives

Often the Gateway and the agent's workspace run on one host, such as a server, a NAS or a Docker container, while VS Code runs on another. What the extension can do with your files depends on where the repository is:

| Setup | What to do |
| --- | --- |
| **The repository is on the Gateway host** (server, NAS or Docker) | Open the repository with VS Code **Remote** (SSH, WSL or Tunnel), so the editor and the agent see the same files. This setup gets the best support. |
| **The repository is on the Gateway host, but your VS Code window is local** | Chat works, and the agent edits files on the Gateway host. The editor shows those changes only as text in the chat. |
| **The agent cannot reach your code** | Attach files and selections to the prompt. The agent replies with a patch, which you apply yourself. |

## Commands

| Command | Description |
| --- | --- |
| OpenClaw: Open Chat | Focus the chat view |
| OpenClaw: Pop Out Chat | Move the chat into an editor tab |
| OpenClaw: New Chat Session | Open a new, empty thread in the panel. On the Gateway it uses the default session, so it keeps that session's context. For a separate context, pick another session with **Pick Agent Session** |
| OpenClaw: Pick Agent Session | Choose the Gateway agent session to talk to |
| OpenClaw: Connect to Gateway | Save the Gateway token and connect |
| OpenClaw: Reset Gateway Device Identity | Forget this device's pairing and create a new identity |
| OpenClaw: Insert Selection Mention | Add the selection to the prompt (`Alt+K`, or `Cmd+Alt+K` on macOS) |
| OpenClaw: Connect | Run the configured OpenClaw CLI command in a terminal |
| OpenClaw: Setup | Guided install of OpenClaw and its prerequisites |
| OpenClaw: Model Setup Wizard | Onboarding and choice of model provider |
| OpenClaw: Harden | Run the security hardening workflow |
| OpenClaw: Hardening Access Summary | Show what OpenClaw can access |
| OpenClaw: Debug Chat Panel | Inspect the chat panel's events |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `openclaw.gateway.url` | `ws://127.0.0.1:18789` | Gateway WebSocket URL |
| `openclaw.gateway.transport` | `auto` | `gateway`, `acpx` or `auto` |
| `openclaw.gateway.protocolVersion` | `auto` | Gateway protocol version to offer. Keep `auto` unless the Gateway reports a protocol mismatch |
| `openclaw.chat.attachOpenFile` | `false` | Attach the active file to every normal message (not to slash commands) |
| `openclaw.chat.systemPrompt` | empty | Text added before every message |
| `openclaw.chat.dimension` | `1x1` | Thread grid: `1x1`, `2x2`, `2x3`, `3x3` or `4x4` |
| `openclaw.chat.collapseCompleted` | `true` | Collapse finished threads in the `1x1` view |
| `openclaw.chat.hideToolActivity` | `false` | Hide finished tool-call groups |
| `openclaw.chat.dynamicSubject` | `true` | Name each thread from its content |
| `openclaw.chat.contextMax` | `0` | Context window size for the usage gauge (`0` takes it from the model name) |
| `openclaw.chat.source` | empty | Source label on each chat pane |
| `openclaw.chat.agent` | `codex` | Agent for the acpx transport |
| `openclaw.chat.models` | `codex`, `claude`, `opencode` | Models offered in the composer's picker |
| `openclaw.chat.permissions` | `approve-reads` | What the acpx agent may do: `approve-reads`, `approve-all` or `deny-all` |
| `openclaw.command` | `openclaw status` | Command that **OpenClaw: Connect** runs |
| `openclaw.autoConnect` | `false` | Run that command on startup |
| `openclaw.hardening.mode` | `full` | `full`, `audit` or `auditFix` |
| `openclaw.hardening.command` | `openclaw` | Command prefix for hardening |
| `openclaw.dashboardUrl` | `http://127.0.0.1:18789/` | Dashboard opened from the Overview |

Some settings run commands, carry the token, or change what the agent may do. You can set those only in your user settings; a workspace cannot set them.

**Windows with WSL:** set `openclaw.command` to `wsl openclaw status` and `openclaw.hardening.command` to `wsl openclaw`.

## Security and privacy

- **No telemetry.** On the Gateway transport, the only connection is the WebSocket to your Gateway.
- **The acpx transport is configured outside the extension.** Your prompts and the context you attach go to the agent and model provider that your local `acpx` uses.
- **Secrets stay in SecretStorage.** This covers the Gateway token and the device identity. A token found in the old plaintext setting `openclaw.gateway.token` in your user settings is moved into SecretStorage and deleted from `settings.json`. If a token is already saved, a different one in the setting is deleted, not adopted. If SecretStorage cannot store the token, or the setting cannot be deleted, the token stays in `settings.json` and a warning tells you what to do. A token in workspace settings is never used; it is deleted once you trust the workspace.
- **A workspace you open cannot redirect you.** Only your user settings can change where the token goes, which commands run, or what the agent may approve.
- **Attachments come from your workspace or from your own choice.** An `@`-mention resolves only to a file inside the workspace, with symlink escapes rejected. A file from outside the workspace is attached only when you pick it yourself: in the `+` file dialog, as an open editor in the file search, or by dropping it, which asks for confirmation first. Every attachment is read up to a size limit, from the file checked when it was attached. On Windows, part of that check is missing for now ([#40](https://github.com/OlehPendrakovskyi/claw-code/issues/40)).
- **Logs are cleaned of secrets.** Before a log line or an error message is written, credentials in it are removed. This covers URL user names and passwords, tokens in query strings, and `key=value` secrets. The extension does not log prompt text either. One gap remains: if an agent's error message quotes your prompt, that text can reach the log ([#42](https://github.com/OlehPendrakovskyi/claw-code/issues/42)).

Please report a vulnerability privately to the maintainer through GitHub, not in a public issue. A `SECURITY.md` with a formal reporting path will be added before the public release.

## Troubleshooting

| Problem | Try |
| --- | --- |
| Cannot connect to the Gateway | Run `openclaw gateway status`, check `openclaw.gateway.url`, and run **OpenClaw: Connect to Gateway** again |
| Connected, but runs wait for approval | Approve the device or the request in the OpenClaw Control UI |
| Protocol mismatch on connect | Update OpenClaw, or set `openclaw.gateway.protocolVersion` explicitly |
| `openclaw: command not found` | Run `npm install -g openclaw@latest` and restart VS Code, or run **OpenClaw: Setup** |
| `acpx not found` (acpx transport only) | Run `npm install -g acpx` |

To read the logs, open the **Output** panel and choose the **OpenClaw**, **OpenClaw Chat**, **OpenClaw Agent** or **OpenClaw Debug** channel.

## Status and roadmap

The first goal, a working chat with the Gateway, is shipped. The next milestone is **R0, the public release**. It covers:

- a publisher this project owns, with listings on the VS Code Marketplace and Open VSX;
- a release workflow;
- `SECURITY.md`;
- refusing, or asking you to confirm, a remote `ws://` connection;
- CodeQL scanning.

After that come these milestones:

- **v1, editor integration:**
  - the Terminal Bridge, so the agent can run commands you approve in a VS Code terminal;
  - plan mode, with the plan as an editable document;
  - inline diffs with Accept;
  - checkpoints;
  - parallel sessions in editor tabs.
- **v1.x:** Reject and Rewind, which undo the agent's changes.
- **v2:** reviewing changes one at a time, generated session titles, deep links and accessibility work.

The full plan, with the status of each feature, is in [docs/roadmap.md](docs/roadmap.md). Designs for features not built yet are in [docs/design/](docs/design/).

## Contributing

Prerequisites: git, Node.js 24 and pnpm, as for [Install](#install).

```sh
pnpm install
pnpm run watch       # rebuild on change; press F5 to launch the Extension Development Host
```

Before you push, run the same gates as CI, in the same order:

```sh
pnpm run typecheck
pnpm run lint
pnpm run check:rules
pnpm run compile
pnpm run test:coverage
pnpm run license:check
```

`test:coverage` applies the coverage thresholds in `vitest.config.ts`, as CI does. CI runs on Linux, Windows and macOS.

Read these before you change code:

- [docs/development-rules.md](docs/development-rules.md): the binding rules, cited by ID.
- [docs/engineering.md](docs/engineering.md): the stack, code structure, logging, PR policy and CI.
- [AGENTS.md](AGENTS.md): instructions for coding agents.

Use Conventional Commits and the branch prefixes `feat/`, `fix/`, `chore/`, `refactor/` or `docs/`. Every fix comes with a regression test that fails without it. New dependencies need the maintainer's approval and must have an allowed licence.

## Licence and acknowledgements

[MIT](LICENSE).

Claw Code started as a fork of [openknots/openclaw-extension](https://github.com/openknots/openclaw-extension), © OpenKnot AI / Val Alexander, at version 0.2.1. It is now an independent project, and it does not sync with upstream. Thank you for the original work.
