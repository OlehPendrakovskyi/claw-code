# Claw Code — roadmap

> **Status on 2026-10-04.** Version 0.1.0, not yet released (the numbering restarted from upstream's 0.2.1). The MVP (Gateway chat) is largely shipped; the next milestone is **R0 — public release** (§7). Feature status lives in one place: the table in §6.
>
> **Naming.** Internally the UX goal was called "Claude for OpenClaw". "Claude" is an Anthropic trademark, so it is not used as or in the product's name or branding, nor in identifiers (namespaces, commands, settings). Published material refers to it only where factually necessary — this note, or third-party file names such as `CLAUDE.md` that the rules ingester reads.

This replaces the earlier single-file plan (the root `ROADMAP.md`, removed by this change set together with the upstream README, and the long version of this file). Design detail and history now live in separate documents:

| Document | Contents |
| --- | --- |
| [design/diff-and-checkpoints.md](design/diff-and-checkpoints.md) | P1-1, P1-1b, P1-1c, P1-4, P1-4b: diff view, Reject, per-change review, checkpoints, Rewind — invariants and mechanism |
| [design/terminal-bridge.md](design/terminal-bridge.md) | P1-0: agent-requested commands in a VS Code terminal |
| [design/rules-ingester.md](design/rules-ingester.md) | A-11: project rules into memory-wiki |
| [engineering.md](engineering.md) | Stack, code structure, logging, code quality, PR policy, CI/CD |
| [development-rules.md](development-rules.md) | Rules learned from past PRs |
| [audits/2026-10-03-sprint1.md](audits/2026-10-03-sprint1.md) | The Sprint 1 audit (historical) |

**Rule for this document:** each requirement is stated once, in the document that owns it; everything else links to it. Status changes go into the §6 table (and, once they exist, GitHub issues), not into prose.

## 1. Product

**Claw Code** is a VS Code companion for [OpenClaw](https://docs.openclaw.ai): a chat panel for Gateway agents with editor context, plus OpenClaw setup and hardening tools. The UX target is parity with the best AI coding extensions (see the appendix) for users who run their agents on an OpenClaw Gateway.

**Project status: community.** A public product for all OpenClaw users, not one owner's customisation. Every requirement covers the full range of setups — local CLI, a Docker gateway on a NAS, a remote server — with data locality, no telemetry and a clear compatibility story.

**Origin.** A fork of [openknots/openclaw-extension](https://github.com/openknots/openclaw-extension) (MIT, by Val Alexander), continued as a standalone project. Upstream is not pulled or synced — most of the code has since been rewritten — and remains only a licence and attribution reference.

**Distribution:** this repository, the VS Code Marketplace and Open VSX, and ClawHub where applicable.

## 2. Community requirements

1. **Zero-config connection.** At minimum, "enter the gateway URL + token" onboarding; later, gateway discovery on the local network (Bonjour), which users can disable via env (`OPENCLAW_DISABLE_BONJOUR`). **Transport security:** plaintext `ws://` is acceptable only for a loopback host. A non-loopback gateway must use `wss://` or a secure tunnel, because the token travels in the `auth` object of the first `connect` RPC. Today `GatewayConfigService.sendsTokenInCleartext` classifies the URL and `ChatServiceFactory.warnIfCleartext` (`chatServiceFactory.ts:164,302-309`) shows a one-off warning and connects anyway — enforcement is **SEC-1**.
2. **Private by default.** The token is kept in SecretStorage; no telemetry. On the Gateway transport nothing leaves the machine except the WebSocket to the user's own gateway. On the acpx transport, prompts and attached context go to whatever agent and model provider the local CLI is configured with — the extension does not control that path, and the README says so. Logging red lines: [engineering.md §3](engineering.md#3-logging).
3. **Dual transport.** Gateway WebSocket (primary) and the local acpx CLI (fallback), selected by `openclaw.gateway.transport` (`gateway | acpx | auto`). The acpx path keeps existing users of the original extension working.
4. **Standalone project.** One repository, one PR flow — [engineering.md §5](engineering.md#5-pr-policy).
5. **English UI, ready for localisation.** UI strings gathered in one place for translation. Not yet true: strings are spread across `package.json`, `content-js.ts` and the extension-host modules. The migration is **ENG-14**.
6. **Documentation.** A README covering the key scenarios (Gateway connection, the three topologies of §5, choosing an agent, and the Terminal Bridge once it ships), a CHANGELOG, and semantic versioning.
7. **Licence.** Keep the upstream MIT notice and attribution, and state the fork's origin in the README and CHANGELOG.

## 3. Release identity: name and publisher

**Name.** `Claw Code` (owner's choice, 2026-09-24). Fallbacks: `OpenClaw Companion`, `OpenClaw Studio`, `OpenClaw IDE`, `Clawside`. Before the first publish, check availability on the VS Code Marketplace, Open VSX and npm, and check for trademark conflicts (**REL-1**).

**Publisher (REL-2).** The extension must be published under a **publisher identity the owner registers and controls**, on both registries:

- `package.json` still carries `"publisher": "openknot"`, inherited from the upstream package. That publisher is not ours, so publishing under it is impossible and would also misrepresent the project as the upstream extension. Register a new VS Code Marketplace publisher and a matching Open VSX namespace, and set `package.json` `publisher` to it.
- The extension ID becomes `<publisher>.claw-code`. Everything derived from the ID follows it: the URI handler authority (`vscode://<publisher>.claw-code/…`, P2-4), the Marketplace/Open VSX listing URLs, and any docs or deep links that name the ID.
- **Storage moves with the ID.** VS Code scopes SecretStorage and `globalState` by extension ID, so under a new ID the gateway token, the paired device identity and device tokens (`gatewayConfig.ts`), and the persisted acpx approvals (`acpxProjectConfig.ts`, via `activate.ts:79`) start empty. Make the change **before the first public release** so no published user is affected; anyone running a local build re-enters the token and re-pairs once. The `openclaw.*` setting and command IDs are not tied to the publisher and do not change.
- Publishing credentials (`VSCE_PAT` for that publisher, `OVSX_TOKEN` for that namespace) belong to the owner and live only in GitHub Secrets ([engineering.md §6](engineering.md#6-cicd)).
- **Remove the legacy extension ID when installing the new one.** VS Code treats `<publisher>.claw-code` as a different extension from the current `openknot.claw-code` build, so installing it is not an upgrade: both stay installed and both contribute the same `openclaw.*` commands, settings and views. The switch therefore includes (a) a migration note in the README and CHANGELOG — uninstall `openknot.claw-code` first (`code --uninstall-extension openknot.claw-code`); (b) `scripts/install-local.sh` uninstalling the legacy ID before installing the new VSIX; and (c) an activation check (`vscode.extensions.getExtension('openknot.claw-code')`) that, if the legacy build is still present, warns the user and offers to open it in the Extensions view for removal.
- Leftover upstream naming goes in the same change: `scripts/install-local.sh` still packages `openclaw-extension-<version>.vsix`.

## 4. Architecture

- **Transport.** A direct WebSocket to the OpenClaw Gateway (default port 18789, token auth, handshake `role=operator`) is the primary path, implemented by `GatewayChatService` (`src/core/gatewayChatService.ts`) over versioned protocol adapters (`src/core/gatewayProtocol/`, currently v4). `ChatService` (acpx) is the fallback. `chatServiceFactory` picks the backend; callers use the `ChatService | GatewayChatService` union.
- **Agent selection.** `sessions.list` → the chosen agent's main session → every send carries its `sessionKey`.
- **RPCs and events in use** (the v4 contract, `src/core/gatewayProtocol/v4/schema.ts`): `connect`, `chat.send` (no client-side `queueMode`; the session's stored queue mode decides start-or-steer), `chat.abort`, `chat.history` (+ `deltaCursor` catch-up), `sessions.list`, `sessions.subscribe`, `sessions.messages.subscribe` / `unsubscribe`, and approvals and questions through `exec.approval.*`, `plugin.approval.*` and `question.*` (list / resolve). Events: `session.message` (text deltas), `session.tool` (tool-call lifecycle), `sessions.changed`, `chat`, `agent`, the `*.requested` / `*.resolved` approval and question events, `tick` and `shutdown`.
- **Planned, not in the v4 contract yet:** `sessions.preview` (history previews), `sessions.create` and `sessions.title.prepare` (P2-1), `sessions.patch` (A-1 model switching; P1-6 steering via the stored queue mode) and `sessions.abort`. Each is added to the contract, behind capability discovery, by the item that needs it.
- **The protocol is not frozen,** so coupling is kept low: capabilities come from `hello-ok.features.methods`, all methods and fields go through one adapter layer with versioned schemas, and events are handled additively (unknown event types are ignored, never crash the UI).
- Protocol references: the Gateway's `docs/gateway/protocol.md` and `protocol/*.md` (transport, handshake, rpc-methods, rpc-session-control, auth); the reference client is the Gateway's webchat UI.
- Code layout: [engineering.md §2](engineering.md#2-code-structure).

## 5. Deployment topologies

The Gateway and the agent's workspace often live on one host (Docker server, NAS, VPS) while VS Code runs on another. Where the project files live decides what the extension can do with them:

| Topology | When | What works |
| --- | --- | --- |
| **A. Repo next to the Gateway, opened with VS Code Remote (SSH / WSL / Tunnel)** | The recommended path for code | Files are local to the window, so chat context and attachments work today; diffs and checkpoints will work here once P1-1 and P1-4 ship |
| **B. Repo on the Gateway host, window local, no Remote** | Remote is not an option | Today: the agent edits files on the Gateway host and the window sees them only as chat text. Planned: reads and previews via a paired node (`dir.list` / `file.fetch` through Gateway RPC) and textual diffs (P1-1) |
| **C. No shared filesystem** | Closed environments, code the agent cannot reach | The extension inlines text into the prompt (already supported); the agent returns a patch or text, applied by hand |

Topology A is the one optimised for and needs nothing extra; B gets the paired-node reads and textual-diff fallback of P1-1; C already works. The README documents all three.

## 6. Feature status

Effort: **S** ≈ hours to a day, **M** ≈ 2–4 days, **L** ≈ a week or more. Milestones are defined in §7.

### Release, security and engineering

| ID | Item | Milestone | Status | Effort | Notes |
| --- | --- | --- | --- | --- | --- |
| REL-1 | Name availability and trademark check for `Claw Code` | R0 | Todo | S | §3 |
| REL-2 | Owner-controlled publisher and Open VSX namespace; update `package.json` and derived IDs | R0 | Todo | S | §3 |
| REL-3 | README for Claw Code | R0 | Done | S | Rewritten for the fork; the upstream README was removed in the same change set |
| REL-4 | Release workflow (tag → vsce + ovsx → GitHub Release) | R0 | Todo | M | [engineering.md §6](engineering.md#6-cicd) |
| REL-5 | `SECURITY.md` with a private vulnerability-reporting path | R0 | Todo | S | Required before the Terminal Bridge ships |
| REL-7 | Pin the packaging tools: add `@vscode/vsce` (MIT) and `ovsx` as dev dependencies, and make `install-local.sh`, `publish-all.sh` and the `publish:*` scripts call them via `pnpm exec`. Done so far: `install-local.sh` pins `@vscode/vsce@4.0.0` (it uses no `ovsx`), and `publish-all.sh` pins `@vscode/vsce@4.0.0` and `ovsx@1.2.0` (previously it ran the deprecated `vsce` package). Remaining: the dev dependencies, and the `publish:vsce` / `publish:ovsx` package scripts, which call binaries that are not installed. `ovsx` is EPL-2.0: as a dev-only dependency it is outside the `--production` licence check, but it needs the owner's approval under the dependency policy | R0 | Partial | S | The README's manual path also pins `@vscode/vsce@4.0.0` |
| REL-6 | Marketplace listing: current screenshots, icon, categories, Open VSX metadata | R0 | Partial | S | The upstream screenshots were removed; new ones are needed |
| SEC-1 | Block, or require confirmation for, a non-loopback `ws://` gateway | R0 | Todo | S | §2 requirement 1 |
| SEC-2 | Remove prompt text from logs. Done: the `handleSend` line and the debug panel's message log ([#35](https://github.com/OlehPendrakovskyi/claw-code/issues/35)), credential redaction of acpx stderr ([#36](https://github.com/OlehPendrakovskyi/claw-code/issues/36)), and `check:rules` guarding log calls. acpx 0.19.4 does not write the prompt to stderr by design (evidence in #36). Remaining: an agent error can still quote the prompt into the logged stderr tail, which conflicts with the R0 exit criterion of no prompt text in any log; choose and implement one of the options in [#42](https://github.com/OlehPendrakovskyi/claw-code/issues/42), or record accepting the risk | R0 | Partial | S | [engineering.md §3](engineering.md#3-logging) |
| SEC-3 | Attachment reader: verify the opened handle's path through the OS (`GetFinalPathNameByHandle` on Windows, `F_GETPATH` on macOS, the fd link on Linux) and fail closed where none exists. Done: macOS and Windows through koffi (`src/core/handlePath.ts`), which also opens without following a final reparse point on Windows; other systems refuse the file ([#40](https://github.com/OlehPendrakovskyi/claw-code/issues/40)) | R0 | Done | S–M | [Design P3](design/diff-and-checkpoints.md#path-resolution-and-containment) |
| SEC-4 | Credential redaction: rewrite malformed URL-userinfo masking and `joinBoundary` around stated invariants (R56), closing the open questions in [#43](https://github.com/OlehPendrakovskyi/claw-code/issues/43): a spaced password after `/`, a URL-credential continuation in structured or spaced error details, and a terminal sequence ending right before a label. Moved out of case-by-case patching under R8 | R0 | Todo | M | [#43](https://github.com/OlehPendrakovskyi/claw-code/issues/43) |
| ENG-1 | One injected logger; production debug gate; CI file sink with tee/upload; consolidate the four output channels | v1 | Todo | M | [engineering.md §3](engineering.md#3-logging) |
| ENG-2 | Split the dump files `viewMessaging.ts` and `slashCommands.ts` (maybe `gatewayConfig.ts`) | v1 | Todo | M | [Sprint 1 audit](audits/2026-10-03-sprint1.md) |
| ENG-3 | Decide the transport layout: keep `gatewayChatService.ts` + `gatewayProtocol/`, or move to the `core/gateway/GatewayClient.ts` target | v1 | Open decision | — | [engineering.md §2](engineering.md#2-code-structure) |
| ENG-4 | CodeQL scanning | R0 | Todo | S | |
| ENG-5 | Module map and splitting plan (Sprint 1 task 1 artifact) | v1 | Partial | S | Top-level layout is in [engineering.md §2](engineering.md#current-layout) |
| ENG-7 | Move the VS Code-bound modules out of `core/` (`configIO.ts`, `gatewayConfig.ts`) or record them as exceptions | v1 | Todo | S | [engineering.md §2](engineering.md#2-code-structure) |
| ENG-8 | Manual test plan for the Gateway-era features (the upstream `TESTING.md` was removed with the old docs) | R0 | Todo | S | |
| ENG-9 | One pure event reducer `(state, event) => newState` in place of the direct mutation in `applyRunEvent` / `processChatEvent` | v1 | Todo | M | [engineering.md §4](engineering.md#4-code-quality) |
| ENG-10 | Integration smoke test against a local dev gateway (fake token, no real agent) | v1 | Todo | M | [engineering.md §4](engineering.md#4-code-quality) |
| ENG-11 | `core/markdown.ts`: move `renderMarkdown` and its link-safety helpers out of `viewMessaging.ts` | On next touch | Todo | S | [Refactoring backlog](engineering.md#refactoring-backlog); owner's decision 2026-09-26 |
| ENG-12 | `core/frames.ts`: move frame decoding out of `gatewayChatService.ts` | — | Dropped | — | Already in place: decoding lives in `GatewayProtocolAdapter.decodeFrame` (`gatewayProtocol/v4/adapter.ts:224`), and the service only calls it; `parseFrame` does not exist |
| ENG-13 | Split the accessInfo tests per submodule | v1 | Todo | S | [Refactoring backlog](engineering.md#refactoring-backlog) |
| ENG-14 | Localisation readiness: move `package.json` strings to `package.nls.json`, and host and webview UI strings to `vscode.l10n` bundles (none exist today) | v2 | Todo | M | §2 requirement 5 |
| ENG-6 | Finish `accessInfo`: replace or keep (and record why) `asString` / `getEnvVarFromRecord` / `getFilePathFromRecord`; migrate imports to one style | v1 | Partial | S | [Sprint 1 audit](audits/2026-10-03-sprint1.md) |

### P0 — the MVP: a useful chat to the Gateway

| ID | Feature | Milestone | Status | Effort | Notes |
| --- | --- | --- | --- | --- | --- |
| P0-1 | Gateway WS transport: token in SecretStorage, reconnect with backoff, capability discovery, acpx fallback | MVP | Done | M | Transport security is SEC-1 |
| P0-2 | Agent selector and session binding, with the active-run indicator | MVP | Done | M | `AgentPicker`; `hasActiveRun` in `agentSessionItems.ts` |
| P0-3 | Streaming chat with a transcript; tool calls as groups | MVP | Done | M | |
| P0-4 | Session history and resume (including cold sessions and `deltaCursor` catch-up) | MVP | Done | M | `seedHistory` / `resumeSessionForThread` |
| P0-5 | Auto-context: open file, selection, diagnostics, `@file#L5-10` mentions | MVP (build-outs in R0) | Partial | S–M | Done: `attachOpenFile`, line-range mentions (`fileMentions.ts`), `openclaw.chat.insertSelection` (`alt+k` / `cmd+alt+k`). Todo: selection attached on a normal send, macOS **Option**+K, diagnostics on a normal send |
| P0-6 | Slash commands on both transports | MVP | Done | S | `/explain /fix /review /test /refactor /doc /commit /harden /plan /compact /search`; prompts are built backend-agnostically |

### P1 — editor integration

| ID | Feature | Milestone | Status | Effort | Notes |
| --- | --- | --- | --- | --- | --- |
| P1-0 | **Terminal Bridge**: the agent runs approved commands in a VS Code terminal | v1 | Todo | M–L | [Design](design/terminal-bridge.md) |
| P1-1 | Inline diffs: diff view and Accept | v1 | Todo | M | [Design](design/diff-and-checkpoints.md); Reject is P1-1b. Needs structured tool args in the adapter; absolute paths only until the Gateway declares a root per tool call (design P1a) |
| P1-1b | Reject as an explicit conflict/force restore | v1.x | Todo | M | Automatic restore is blocked on the CAS question in the design |
| P1-2 | Permission modes (Manual / Edit automatically) at prompt and UI level, with honest wording | v1 | Partial | M | Composer chat-type selector (Chat / Code / Review / Plan) and the acpx `openclaw.chat.permissions` exist; Gateway-side modes to do. Server-side enforcement is the Gateway's |
| P1-3 | Plan mode: the plan as a Markdown document, edited and then approved | v1 | Partial | M | `/plan` and the Plan chat type exist. Todo: "Open in editor" (`plan-<ts>.md`), Approve sends the plan and the user's edits back and switches to execute, Cancel, restore the mode on resume |
| P1-4 | Checkpoints: record git snapshots per run | v1 | Todo | M | [Design](design/diff-and-checkpoints.md#checkpoints) |
| P1-4b | Rewind code to a checkpoint (conflict/force flow) | v1.x | Todo | L | Conversation fork is v2 |
| P1-5 | Tool-call groups and focus view | v2 | Partial | S | Done: collapsible groups, `openclaw.chat.hideToolActivity`. Todo: in-webview focus toggle, Ctrl+Alt+F |
| P1-6 | Abort / interrupt / steer | v1 | Partial | S | Stop is wired end to end (`cancelThread` → `chat.abort`, scoped by session key). Todo: steering via the session's stored queue mode, with an "interrupting" status — no client-side `queueMode` |
| P1-7 | Parallel sessions in editor tabs with status dots | v1 | Partial | M | Done: thread grid (`openclaw.chat.dimension`), pop-out, per-thread status. Todo: one view per session in editor tabs, tab dots (pending / finished) |
| P1-8 | Usage and context indicator | MVP | Done | S | `renderUsageIndicator`; Gateway `/usage` detail optional |
| A-1 | Mid-session model switching (`/model`) | v1 | Partial | S | Composer model picker exists; switching a Gateway session's model is to do |
| A-2 | Images: paste from clipboard | v1 | Partial | S | Drag and drop done; no paste handler |
| A-3 | Keybindings: Cmd+Esc (editor ↔ chat), Cmd+Shift+Esc (new tab), Cmd+N | v1 | Todo | S | |
| A-4 | Notification when a background run finishes | v1 | Todo | S | Tab dots are part of P1-7 |
| A-5 | `.gitignore`-aware `@` file search | v1 | Partial | S | Today a fixed exclude list (`node_modules`, `.git`, `dist`, `out`) |
| A-6 | Multi-root workspace awareness: show each file's root in context | v1 | Todo | S–M | Also required by the diff design (P1) |
| A-7 | Warn before context overflow, with a `/compact` hint | v1 | Partial | S | Gauge and `/compact` exist; the early warning does not |

### P2 — polish and ecosystem

| ID | Feature | Milestone | Status | Effort | Notes |
| --- | --- | --- | --- | --- | --- |
| P2-1 | AI titles for new sessions (`sessions.title.prepare` → `displayName`) | v2 | Todo | S | Local dynamic subjects exist |
| P2-2 | Auto-archive and per-workspace groups in history | v2 | Todo | M | |
| P2-3 | Side questions (`/btw`) in a separate one-shot session | v2 | Todo | M | |
| P2-4 | URI handler `vscode://<publisher>.claw-code/open?prompt=…&session=…` | v2 | Todo | S | Authority follows REL-2 |
| P2-5 | Copy response to clipboard | v2 | Todo | S | No copy action exists yet; conversation export to Markdown/JSON is a separate, finished feature |
| P2-6 | `@terminal` mentions and a `/tasks` map of background processes | v2 | Todo | M–L | |
| P2-7 | Screen-reader announcements for replies, tool steps and status; focus-last-message command | v2 | Partial | M | A persistent aria-live region announces approvals, questions and status changes |
| P1-1c | Per-change accept/reject in the diff (up to 100), Accept/Reject at cursor, pre-apply in Manual mode | v2 | Todo | L | [Design](design/diff-and-checkpoints.md#v2-extensions) |
| A-10 | Agent profiles per task type (coding / review / domain) | v2 | Todo | S | Domain specifics belong in user profiles, not the core |
| C-1 | Gateway discovery on the LAN (Bonjour), disableable via env | v2 | Todo | M | §2 requirement 1 |

### Later

| ID | Feature | Status | Effort | Notes |
| --- | --- | --- | --- | --- |
| A-9 | A git worktree per agent, for parallel agents in one repo | Idea | M | |
| A-11 | Project Rules Ingester and `/conventions` | Design | M–L | [Design](design/rules-ingester.md); depends on the Gateway's memory-wiki |
| P2-8 | View-only MCP / plugin listing (management stays on the Gateway) | Optional | L | |

## 7. Milestones

| Milestone | Scope | Estimate | Exit criteria |
| --- | --- | --- | --- |
| **MVP** — chat to the Gateway | P0-1…P0-6, P1-8 | Implemented before 0.1.0, except the P0-5 build-outs (local builds then carried the upstream number 0.2.x) | Connect by token with reconnect; choose an agent; replies stream; tool calls grouped; stop works; history restores, including after a window restart; slash commands and context work on both transports; acpx selectable when the Gateway is down; unit tests for the transport (mock WS), reducer and adapters |
| **R0** — public release | REL-1…REL-7, SEC-1, SEC-2, SEC-3, ENG-4, ENG-8, P0-5 build-outs | ≈ 1–2 weeks | Installs from the VS Code Marketplace and Open VSX under the owner's publisher; README covers topologies A–C; remote `ws://` is blocked or confirmed; no prompt text in any log; CI, licence check and CodeQL green |
| **v1** — editor integration | P1-0, P1-3 first (high value, contained risk); then P1-1, P1-2, P1-4, P1-6 steering, P1-7, A-1…A-7, ENG-1, ENG-2, ENG-3, ENG-5, ENG-6, ENG-7, ENG-9, ENG-10, ENG-13; ENG-11 whenever `viewMessaging.ts` is next touched | ≈ 6–8 weeks | An agent edit in a local repo shows a correct diff (or says the before-state is unavailable); every edit-capable run records a checkpoint, or is clearly marked before it starts as having none (design C6b); plan → edit → approve → execute in one session; the agent runs an approved command locally and reads its output; two sessions run in parallel tabs with status dots |
| **v1.x** — undo | P1-1b, P1-4b | ≈ 2 weeks | Reject and Rewind restore modified files to the pre-run state, and refuse with a force option when the user has edited the file since. Files the agent created or deleted are listed as not restored until a safe handle-relative create/delete primitive exists (design P5) |
| **v2** — polish and ecosystem | P2-1…P2-7, P1-1c, P1-5 focus view, A-10, C-1, ENG-14, NAS checkpoints via node exec, `/tasks` | ≈ 3–4 weeks | Per-change review with Accept/Reject at cursor; generated session titles; history groups persist per workspace; a deep link opens a tab with a prefilled prompt; the webview passes a screen-reader walkthrough |

Each milestone also requires: CI green on all three OSes, CHANGELOG updated, and the §6 table current.

## 8. Compatibility

| Area | Supported | Notes |
| --- | --- | --- |
| VS Code | `^1.105.0` | `engines.vscode` in `package.json` |
| VS Code forks (VSCodium, Cursor, …) | Target, via Open VSX | Not yet tested; to be checked during R0 |
| OpenClaw Gateway protocol | v4 (OpenClaw 2026.9.x) | `openclaw.gateway.protocolVersion`; new versions are added as adapters |
| acpx fallback | `acpx` on `PATH` | |
| Operating systems | Linux, macOS, Windows | All three in the CI matrix. When P1-0 ships, the Terminal Bridge must be tested on Windows (PowerShell) as a release requirement |
| Remote | SSH, WSL, Tunnel | Topology A |

## 9. Out of scope

| Feature | Why not |
| --- | --- |
| A bundled CLI / terminal mode | Niche; the external acpx transport remains as the fallback, but no CLI ships inside the extension |
| Vendor accounts and vendor-format permission files | Authentication is the Gateway token; permission rules are Gateway policy |
| MCP configuration from the extension | MCP lives on the Gateway and its agents; a second UI would be a second source of truth |
| A browser-control integration | OpenClaw has its own browser tool on the Gateway |
| Vendor subscription usage bars, prompt-cache clocks | Billing specifics of other products; the Gateway does model routing |
| Cloud sessions | The Gateway's `sessions.dispatch` / placement is the equivalent; a UI wrapper is optional, later |
| A plugin marketplace UI | Plugins are managed on the Gateway via ClawHub |
| A memory UI | Memory exists per agent on the Gateway; a viewer may come much later |
| Python environment activation, spawn wrappers | Leftovers of a spawn architecture. Not to be confused with the Terminal Bridge (P1-0), which is a new feature |

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| The Gateway protocol changes | Versioned adapters, capability discovery, additive event handling; one place to change per protocol version |
| File edits happen outside the VS Code process | Snapshots and git checkpoints, textual fallback, topology A covers most cases; undo stays an explicit flow until a CAS exists ([design](design/diff-and-checkpoints.md)) |
| Complex `sessions.list` semantics (snapshots, ownership, `activeRunIds`) | Use a minimal subset: agents' main sessions plus `hasActiveRun` |
| Client-side permission modes cannot be enforced | Honest UI: modes are instructions to the agent plus Gateway policy where it exists |
| The Terminal Bridge is the largest attack surface | Approvals bound to immutable code identity, Run once by default, `SECURITY.md` before release ([design](design/terminal-bridge.md)) |
| Name or publisher rejected by a registry | Availability and trademark check before the first publish (REL-1); fallback names in §3 |
| A single maintainer (bus factor; the ruleset bypass) | Documented PR policy; tighten reviews when contributors join ([engineering.md §5](engineering.md#5-pr-policy)) |
| Estimates slip as v1 scope grows | Exit criteria per milestone; P1-0 and P1-3 first; undo split into v1.x |

## Appendix: UX reference

The UX target came from a review of the leading AI coding extension's VS Code documentation (snapshot 2026-09-24). Re-check it once per milestone. Features with a counterpart in §6:

- **Chat:** sidebar / tab / window panels, parallel sessions with tab status dots → P1-7; history with search, rename, archive, groups → P0-4, P2-2; AI titles → P2-1; resume after reload → P0-4; slash menu → P0-6; mid-session model switch → A-1; attachments via drag and drop, clipboard and `@file#5-10` → A-2, P0-5; `@terminal` → P2-6; side questions → P2-3; copy / export → P2-5; context indicator and compact → P1-8, A-7; focus view → P1-5.
- **Permissions:** Manual / Plan / edit-automatically modes → P1-2, P1-3; side-by-side diff with per-change and at-cursor accept/reject → P1-1, P1-1c.
- **Checkpoints:** rewind code, fork conversation → P1-4, P1-4b.
- **IDE context:** selection, open file, diagnostics, `.gitignore`-aware search → P0-5, A-5.
- **Keyboard and accessibility:** focus toggle, new tab, new session → A-3; screen-reader support → P2-7; a URI handler for scripts → P2-4.
- **Ecosystem:** MCP and plugin management, browser integration, usage accounting → §9 and P2-8; subagent progress and background tasks → P2-6.
