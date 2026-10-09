# Changelog

All notable changes to Claw Code are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Claw Code is a fork of [openknots/openclaw-extension](https://github.com/openknots/openclaw-extension) at version 0.2.1. This changelog starts at that fork. Changes made before the fork are recorded in the upstream repository. Each entry below is described relative to upstream 0.2.1.

## Unreleased

The version numbering starts again at 0.1.0, which will be the first Claw Code release. The 0.2.1 that local builds carried before was the upstream version.

### Added

- Chat with the agents on an OpenClaw Gateway over WebSocket, using Gateway protocol v4. The connection reconnects with backoff, discovers what the Gateway supports, and fetches the messages missed after a reconnect or a window restart. Protocol versions are handled by separate adapters, so a new version can be added without touching the rest.
- Settings `openclaw.gateway.url`, `openclaw.gateway.transport` (`gateway`, `acpx` or `auto`) and `openclaw.gateway.protocolVersion`. With `auto`, the local acpx CLI is used when the Gateway cannot be reached.
- Commands **OpenClaw: Connect to Gateway**, **OpenClaw: Pick Agent Session** and **OpenClaw: Reset Gateway Device Identity**, and device pairing with the Gateway.
- An agent session picker with an indicator for runs already active, and session history that can be reopened and resumed.
- Stop a running reply on the Gateway.
- Answer the Gateway's command approvals, plugin approvals and questions in the chat. A screen-reader live region announces them and status changes.
- Answers to side questions (`/btw`) appear next to the run they belong to.
- Slash commands `/plan` and `/compact`.
- Line-range mentions such as `@src/app.ts#L5-10`, and **OpenClaw: Insert Selection Mention** (`Alt+K`, or `Cmd+Alt+K` on macOS).
- Settings `openclaw.chat.attachOpenFile`, `openclaw.chat.hideToolActivity` and `openclaw.dashboardUrl`.
- Image attachments on the acpx transport.
- A warning, once per session, when the acpx on PATH is a version Claw Code was not tested with, or its version cannot be read. The chat still runs ([#42](https://github.com/OlehPendrakovskyi/claw-code/issues/42)).

### Changed

- The project is renamed to Claw Code, with its own README, repository and homepage. Commands and settings keep the `openclaw.*` IDs.
- The acpx transport reads the structured output of acpx (`--format json`) and passes the prompt through standard input. Each run ends exactly once, even when the process is killed or fails to start.
- Conversation history sent to acpx is capped, and starts from the latest `/compact` summary.
- Some settings run commands, carry the token, choose the agent, or change what it may approve. These now apply only from user settings; a workspace cannot set them.
- `openclaw.autoConnect` runs the connect command only from user settings.
- A blank `openclaw.hardening.command` now falls back to `openclaw`, as a blank `openclaw.command` already falls back to `openclaw status`, instead of stopping with an error ([#41](https://github.com/OlehPendrakovskyi/claw-code/issues/41)).
- The `package.json` metadata describes Claw Code. It adds an issues link, uses the categories `AI` and `Chat`, and drops the `pnpm` field, which pnpm no longer reads.
- Gateway error messages explain what went wrong. Authentication and protocol errors stop the reconnect attempts. A pending pairing pauses them, and rate limits slow them down.

### Removed

- Settings `openclaw.chat.thinkingLevel`, `openclaw.chat.temperature` and `openclaw.chat.maxTokens`.
- The upstream README, `ROADMAP.md`, `TESTING.md` and `SUMMARY.md`. A new README and the documents under `docs/` replace them.
- The upstream banner and screenshots (`assets/images/readme.png`, `single-chat.png`, `slash-commands.png`, `multi-thread.png`), which showed the old extension.

### Fixed

- Attachments on macOS were always rejected and sent as `[Could not read file]`.
- File search on Windows did not match queries that contain `/`.
- When **OpenClaw: Connect** failed, it showed the raw error instead of a readable one with credentials removed.
- A tool toggle or uninstall was confirmed before the Tools view had refreshed. A failed refresh is now reported.
- Errors that are not JavaScript `Error` objects were shown as `[object Object]`.

### Security

- The Gateway token is kept in VS Code's SecretStorage. A token in the old plaintext setting `openclaw.gateway.token` in user settings is moved there and deleted from `settings.json`, unless a different token is already saved, in which case it is only deleted. If SecretStorage or the deletion fails, the setting stays and a warning says so. A token in workspace settings is never used, and is deleted once the workspace is trusted.
- A warning appears when the token would be sent unencrypted, over `ws://`, to a Gateway on another machine.
- Credentials are removed from the error messages and log lines of acpx, Connect, the Gateway transport, the access summary and the hardening status. This covers URL user names and passwords, sensitive values in query strings, and secrets written as `key=value`.
- The extension no longer writes prompt text to its logs: a sent prompt is logged by its length, and the debug panel logs only the type of each message. acpx's stderr and an agent's error message, either of which can quote the prompt, are logged only by their size; the chat still shows the error, with credentials removed ([#42](https://github.com/OlehPendrakovskyi/claw-code/issues/42)).
- `@`-mentions attach only files inside the workspace, with symlink escapes rejected. A file dropped from outside the workspace is attached only after you confirm it. Every attachment is read up to a size limit, through a handle whose own path the operating system confirms is the file checked when it was attached: the fd link on Linux, `F_GETPATH` on macOS, `GetFinalPathNameByHandleW` on Windows, where a final symlink or junction is not followed either. On any other system attachments are refused ([#40](https://github.com/OlehPendrakovskyi/claw-code/issues/40)).
- A workspace's `.acpxrc.json` can redefine the commands acpx runs for agents and MCP servers, so it is used only after you approve that exact file.
- Child processes run only from absolute, validated paths, without a shell. The hardening command no longer passes its settings through a shell.
- Replies are inserted into the webview only as Markdown that the extension host has sanitised, with unsafe links removed again in the webview; other text is escaped. The webview's content security policy admits only scripts and styles that carry a cryptographic nonce.
- The dashboard opens only `http://` and `https://` URLs.
- `brace-expansion` is overridden to `^5.0.7` for [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp).

### Development

- The 2,160-line `extension.ts` is split into the modules under `src/core/`, `src/vscode/`, `src/webview/` and `src/overview/`.
- The runtime dependency [koffi](https://koffi.dev/) makes the macOS and Windows system calls of the attachment reader. Its native binaries for macOS and Windows, x64 and arm64, are copied into `out/native` at build time, since the package carries no `node_modules`.
- Tests run on Vitest, with coverage thresholds of 93–95%. Linting uses oxlint with type-aware rules, and `pnpm run check:rules` enforces the development rules.
- CI runs on Linux, Windows and macOS. It also checks the licences of production dependencies, and Dependabot proposes dependency updates.
- New project documents:
  - [roadmap](docs/roadmap.md);
  - [engineering foundation](docs/engineering.md);
  - [development rules](docs/development-rules.md);
  - designs for features not built yet, under [docs/design/](docs/design/);
  - `AGENTS.md`;
  - a pull-request template.

### Merged pull requests

- [#1](https://github.com/OlehPendrakovskyi/claw-code/pull/1) Sprint 0: rebrand to Claw Code, oxlint, a first Gateway transport, CI, and `extension.ts` split into modules.
- [#2](https://github.com/OlehPendrakovskyi/claw-code/pull/2), [#3](https://github.com/OlehPendrakovskyi/claw-code/pull/3), [#4](https://github.com/OlehPendrakovskyi/claw-code/pull/4), [#5](https://github.com/OlehPendrakovskyi/claw-code/pull/5) Dependabot: bump `actions/checkout`, `actions/setup-node`, `pnpm/action-setup` and a group of minor and patch updates.
- [#8](https://github.com/OlehPendrakovskyi/claw-code/pull/8) Sprint 1: split `accessInfo` into submodules and adopt `lodash-es`.
- [#9](https://github.com/OlehPendrakovskyi/claw-code/pull/9) Dependabot: bump TypeScript from 6.0.2 to 6.0.3.
- [#10](https://github.com/OlehPendrakovskyi/claw-code/pull/10) Sprint 2: split `commands.ts` and `ChatViewProvider.ts` without changing behaviour.
- [#11](https://github.com/OlehPendrakovskyi/claw-code/pull/11) Gateway chat over OpenClaw protocol v4, the acpx fallback, and a hardened webview.
- [#12](https://github.com/OlehPendrakovskyi/claw-code/pull/12) Development rules from the review of #11.
- [#13](https://github.com/OlehPendrakovskyi/claw-code/pull/13) Development rules 35–39 from a review of earlier PRs.
- [#14](https://github.com/OlehPendrakovskyi/claw-code/pull/14) Unit tests for the v4 readers, dashboard URL validation and `ChatService` bounds.
- [#15](https://github.com/OlehPendrakovskyi/claw-code/pull/15) Override `brace-expansion` to `^5.0.7` for GHSA-3jxr-9vmj-r5cp.
- [#16](https://github.com/OlehPendrakovskyi/claw-code/pull/16) CI on Ubuntu, Windows and macOS; fix macOS attachments and Windows file search.
- [#17](https://github.com/OlehPendrakovskyi/claw-code/pull/17) Development rules for cross-platform CI and portability.
- [#19](https://github.com/OlehPendrakovskyi/claw-code/pull/19) One module for type guards, with a readers facade.
- [#20](https://github.com/OlehPendrakovskyi/claw-code/pull/20) Shared utilities and one registry of constants.
- [#21](https://github.com/OlehPendrakovskyi/claw-code/pull/21) One set of protocol readers, and unified protocol types.
- [#22](https://github.com/OlehPendrakovskyi/claw-code/pull/22) Remove duplicated command helpers.
- [#23](https://github.com/OlehPendrakovskyi/claw-code/pull/23), [#24](https://github.com/OlehPendrakovskyi/claw-code/pull/24) Dependabot: bump `pnpm/action-setup` to 6.1.0 and a group of minor and patch updates.
- [#26](https://github.com/OlehPendrakovskyi/claw-code/pull/26) Settle duplicated logic: token counts, approval decisions, a shared bounded read loop, truncation wording and the protocol-mismatch code.
- [#27](https://github.com/OlehPendrakovskyi/claw-code/pull/27) Development rules for unverified claims, unchecked registries and untested behaviour.
- [#28](https://github.com/OlehPendrakovskyi/claw-code/pull/28) Run the tests on Vitest instead of Jest, and add rules 50–55.
- [#29](https://github.com/OlehPendrakovskyi/claw-code/pull/29) Use `lodash-es` natively and drop the CommonJS `lodash` dev dependency.
- [#31](https://github.com/OlehPendrakovskyi/claw-code/pull/31) Type partial mock factories with `Partial<typeof import(...)>`.
- [#32](https://github.com/OlehPendrakovskyi/claw-code/pull/32) The project roadmap, with Sprint 1 audited against the code.
- [#33](https://github.com/OlehPendrakovskyi/claw-code/pull/33) Reorganise the development rules, enforce them in CI, and harden credential redaction. Includes [#34](https://github.com/OlehPendrakovskyi/claw-code/pull/34): type-aware linting, `check:rules`, coverage thresholds, and fixes for prompt text in logs (#35), unredacted acpx stderr (#36), the Tools view refresh (#37), the raw Connect error (#38) and a session-key type guard (#39).
