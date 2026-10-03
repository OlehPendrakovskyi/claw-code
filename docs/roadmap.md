# "Claude for OpenClaw" — improvement plan for openknot/openclaw-extension

> **Status on 2026-10-03.** Sprint 1 is partially closed — see §9.1.6 and the "Sprint 1 audit" section at the end of this document. The runner is Vitest and the linter is oxlint; CI is green on ubuntu/windows/macos.

> **Relationship to the root `ROADMAP.md`.** This document is the authoritative project plan. The root `ROADMAP.md` is an older, high-level wishlist (voice chat, planning UX, and similar ideas that predate the §9 architecture decisions); where the two disagree, this document wins. The root file is kept as background, not as a second source of truth — its items have no sprint assignment, no estimates and no status here.

> **The name is a working title.** "Claude for OpenClaw" is used only inside the team to discuss UX goals. Before the public release, replace it: "Claude" is an Anthropic trademark, and using another product's trademark in the name is misleading and legally risky. Never use the word `claude` as an identifier (namespace, commands, settings) in code or configuration. Publish under a neutral name.

**Release name candidates** (theme: "a companion for OpenClaw inside the editor"): **`Claw Code` — primary candidate (owner's choice, 2026-09-24)**, then `OpenClaw Companion`, `OpenClaw Studio`, `OpenClaw IDE`, `Clawside`. Before publishing: check availability on the VS Code Marketplace / Open VSX / npm and confirm there are no trademark conflicts.

Date: 2026-09-24. Basis: the official VS Code extension documentation for Claude Code (code.claude.com/docs/en/vs-code plus related pages: checkpoints, permission modes, sessions, MCP, deep links) and an audit of the fork's code (`/home/node/.openclaw/workspace/oss/openclaw-extension`, MIT, ~7800 lines of TypeScript).

**Project status: COMMUNITY.** The fork is positioned as a public product for all OpenClaw users (not a one-owner customization). Every requirement below accounts for that: universality of setups (local CLI / Docker gateway on a NAS / remote server), data locality, no telemetry, compatibility and PR strategy. Publication: fork repository plus builds for the VS Code Marketplace and Open VSX, plus the extension package on ClawHub where applicable.

## 0. Cross-cutting community requirements

1. **Zero-config connection**: an onboarding flow of "enter ws://url + token" at minimum; gateway discovery over the local network (Bonjour addressing, disableable via env — the owner has `OPENCLAW_DISABLE_BONJOUR` set, but others may have it enabled).
2. **Private by default**: token in SecretStorage; nothing leaves the machine except the WebSocket connection to the user's own gateway; no telemetry.
3. **Dual transport** (gateway-ws | cli) — works both for people on a local CLI and for those on a Docker gateway: removes the entry barrier for existing users of the openknot extension.
4. **PR strategy**: standalone project (owner's repository); upstream OpenKnots is **not pulled and not synced** — over 90% of the code will be rewritten, so cherry-picking would become a source of conflicts rather than a saving. Upstream remains only as a **legal/archive reference** (not an active merge remote). At the fork's first commit, explicitly preserve the **MIT copyright notice of the original project** (openknots/openclaw-extension, author Val Alexander) and state **gratitude for the original** in the README/CHANGELOG: the licence and attribution survive the rebranding to Claw Code; all new code is ours.
5. **i18n neutrality**: UI strings in English (the community standard), with readiness for localization (strings gathered in one module).
6. **Documentation**: README covering the key scenarios (connecting to a Docker gateway, choosing an agent, the terminal bridge), CHANGELOG, semantic versioning.
7. **Licence**: retain the upstream MIT and explicitly state the fork's origin and differences.

---

## 1. What the Claude Code VS Code extension does (full feature list)

### 1.1 Chat and the prompt box
- A graphical chat panel (sidebar / editor tab / separate window), multi-panel parallel sessions, coloured indicators on tabs (blue = awaiting permission, orange = finished in the background).
- Session history: search, rename, archive (auto-archive after 14 days of inactivity), restore, sessions in named groups.
- AI-generated session titles.
- Resuming a session interrupted by a reload (continueAfterReload).
- Slash menu (on `/`): commands, file attachments, model switching, extended thinking, MCP, hooks, permissions, memory, output styles, export.
- Switching model and effort mid-session; `/model`, `/status`.
- Attachments: drag and drop with Shift, clipboard, `@` file mentions including `@file.ts#5-10` (file plus line range), `@terminal:name` (terminal output), `@browser`.
- Side questions via `/btw` (a side panel that does not enter the main session's context).
- Copying a response, `/export`, `/copy`.
- Context-window fill indicator and auto-compact (`/compact`).
- Focus view — collapse tool calls/thinking, leaving only prompts and responses.

### 1.2 Permissions and modes
- Permission modes in the prompt box indicator: **Auto** (a classifier decides), **Manual** (ask for edits/commands), **Plan** (describe a plan, wait for approval), **Edit automatically**.
- In Manual: side-by-side diff before an edit, accept/reject, editing the proposed content directly in the diff view before accepting, per-change accept/reject (buttons under each change, up to 100 changes), Accept/Reject Change at Cursor commands plus the editor context menu.
- Persistent permission rules (Allow/Ask/Deny, with user/project/local scopes).

### 1.3 Plan mode
- Switching via mode or `/plan`, `/plan <task>`, `/plan open`.
- The plan opens as a full Markdown document in the editor — commentable inline before the work starts.

### 1.4 Diffs, checkpoints, rollback
- Inline diffs in the editor and in the panel, auto-accept mode.
- **Checkpoints**: a rewind button on every message with three options: fork conversation / rewind code only / fork + rewind.
- Autosave of files before the agent reads or writes them.

### 1.5 IDE context
- Claude sees the selection automatically; `Option+K` inserts an @-mention of the selection.
- attachOpenFile — the open file enters the context automatically.
- Exchange of diagnostics (linter problems) with the CLI; respectGitIgnore for file search; git diff/staged in context.
- Automatic Python environment activation.

### 1.6 Keyboard and commands
- `Cmd+Esc` toggles focus editor↔chat; `Cmd+Shift+Esc` opens a new tab; `Option+K` @-mention; Cmd+N new session; Cmd+Shift+T reopen closed session; Focus last message (accessibility).
- Full screen reader support (announcing replies, tool steps, permission prompts, statuses).
- URI handler `vscode://anthropic.claude-code/open?prompt=...&session=***` — launching sessions from scripts.

### 1.7 Ecosystem and the rest
- MCP management UI (`/mcp`), plugins and marketplaces (`/plugins`, install-plugin deep link).
- Subagents with live progress lines; `/tasks` — a map of background tasks (dev servers and the like).
- Multi-root workspaces, per-workspace session groups.
- `/usage` — spend and limit accounting with attribution.
- Chrome integration (`@browser`).

---

## 2. Current state of the openknot extension

Fork stack: **TypeScript strict** (`module: ESNext`, `moduleResolution: bundler`, `target: ES2022`, `lib: ES2020`), esbuild bundling (its output is CommonJS), vitest tests (plus a vscode mock), oxlint lint, pnpm for packages; publishing via vsce/ovsx. The scalability problems described below are what the restructuring addresses (§11):

- `src/extension.ts` — a **one-line bootstrap**: the ~72 KB monolith was already decomposed, and activation now lives in `src/vscode/`.
- `src/chat/getWebviewContent.ts` — **the file is gone**: the ~117 KB UI monolith was already moved into `src/webview/content-js.ts` / `content-css.ts`.
- `ChatService.ts` is the concrete acpx (local CLI) implementation — there is no separate transport interface; `chatServiceFactory` selects `gateway | acpx | auto` and hands callers one of two classes (`ChatService | GatewayChatService`) (acpx is the fallback when the Gateway is unreachable within a short timeout).
- Token/settings are centralised in `src/core/gatewayConfig.ts` (settings + SecretStorage).

| Present | Details |
|---|---|
| Chat webview | `ChatViewProvider` (sidebar view) + pop out; one active process per message |
| Transport | `chatServiceFactory` selects `gateway \| acpx \| auto`: Gateway WS RPC (`GatewayChatService`, the primary path) with a fallback to the local CLI process (`new ChatService()`, which spawns acpx per message), both streaming ChatEvent (text / toolCall / usage / done / error) |
| Slash commands | /explain /fix /review /test /refactor /doc /commit /harden /search /plan /compact — with auto-context (selection, file, diagnostics, gitDiff, gitStaged) |
| IDE context | selection listener, diagnostics listener, @-mentions of files, attachments |
| Hardening workflow | openclaw.harden commands, access summary |
| Onboarding | CLI setup/model wizard |
| Debug panel | chat event inspector |
| Multipanel | partial (pop out) |

What is missing (the main gaps against the Claude UX): permission modes, plan mode UI, inline diffs with accept/reject, checkpoints/rollback, focus view.

Already implemented since the plan was written, and therefore **not** gaps: agent/session selection (command-palette `AgentPicker`, `ChatViewProvider.ts:2032`), session history restore and restart resume (`seedHistory` / `resumeSessionForThread`, `ChatViewProvider.ts:2721-2737`), auto-context for the open file (setting `openclaw.chat.attachOpenFile`, `ChatViewProvider.ts:1062`) and the usage indicator (`renderUsageIndicator`, `content-js.ts:987`).

---

## 3. Target architecture (approved)

- **Transport**: a direct WebSocket connection to the OpenClaw Gateway (port 18789, token, handshake `role=operator`) is the primary path. The local CLI transport (acpx) is **not removed**: it stays as a fallback (see §0.3, P0-1 and the MVP criterion), with `chatServiceFactory` choosing `gateway | acpx | auto`.
- **Agent selector**: `sessions.list` → `chat.send` into the chosen agent's session → per-agent memory via memory-lancedb.
- Protocol: `/app/docs/gateway/protocol.md` plus `protocol/*.md` (transport, handshake, rpc-methods, rpc-session-control, auth). The reference client is the webchat UI in `/app/dist`.
- **The protocol is not frozen** → minimise coupling: build a thin `GatewayClient` that discovers capabilities through `hello-ok.features.methods`, route all methods and fields through a single adapter layer, version our expectations in one file (`src/core/gateway/contract.ts`), and handle events additively (unknown event types are ignored rather than crashing the UI).

Key RPCs: `sessions.list` (+`sessions.subscribe`), `sessions.create`, `chat.send` (queueMode), `chat.history` (+deltaCursor catch-up), `chat.abort`, `sessions.abort`, `sessions.patch`, the `session.message` event (deltaText, toolCall lines), `session.approval` (optionally with includeApprovals).

---

## 4. Feature map by priority

Effort legend: S ≈ hours to a day, M ≈ 2–4 days, L ≈ a week or more.

### P0 — must-have (without these the extension is neither "Claude-like" nor useful)

| # | Feature | Taken from the Claude UX | Implementation on the openknot stack | Estimate | Dependencies / risks |
|---|---|---|---|---|---|
| P0-1 | **Gateway WS transport** | n/a (architectural) | New `src/core/gateway/GatewayClient.ts`: WS to `ws://nas:18789`, handshake per protocol.md (`role=operator`), token from settings (secret storage, not plaintext settings), auto-reconnect with backoff, discovery via `hello-ok.features.methods`. `GatewayChatService` is a sibling concrete implementation next to `ChatService` (the acpx implementation, kept as fallback); callers type the backend as the `ChatService | GatewayChatService` union. | **M** | The protocol is documented; risk: protocol versions → mitigation: contract.ts + discovery |
| P0-2 | **Agent selector + session binding** | "sessions/account" in Claude ≈ model selection | A picker in the webview and palette: `sessions.list` → filter to agents' main sessions → choose → all sends carry that `sessionKey`/`agentId`. Show the hasActiveRun indicator. | **M** | P0-1; `sessions.list` semantics are complex (snapshots/ownership) — take a minimal subset |
| P0-3 | **Streaming chat with a transcript** | the basic panel UX | Subscribe to session events; reduce events into a UI model (text deltas, toolCall lines, done/error). Reuse the ChatEvent model, but with tool calls as collapsible groups (see P1-5). | **M** | P0-1; deltaCursor for catch-up on reconnect |
| P0-4 | **Session history + resume** | Session history, resume, AI titles | A "History" button: `sessions.list`/`sessions.preview` → a list with previews and titles; click → `chat.history` to restore the transcript in the webview; continuing → `chat.send` into the same session. | **M** | P0-1..3; "cold" storage status → placeholder |
| P0-5 | **Auto-context: open file, selection, diagnostics** | attachOpenFile, automatic selection visibility, Option+K @-mention, diagnostic sharing | Already done: (a) auto-insert the open file when `attachOpenFile=true` (`ChatViewProvider.ts:1062`, see §2). To build out: (b) @-mentions with a line range `@file#L5-10`; (c) an Option+K/Alt+K keybinding to insert a selection mention. We pack context into the prompt text (the Gateway agent can already read files; we only need a pointer plus a snippet). | **S–M** | low risk |
| P0-6 | **Slash commands over the new transport** | the `/` menu | SLASH_COMMANDS already exists (including /plan and /compact); redirect them to chat.send, turning them into text prompts with context (as now). | **S** | P0-3 |

### P1 — greatly increases the value (what makes it a product)

| # | Feature | Taken from the Claude UX | Implementation | Estimate | Dependencies / risks |
|---|---|---|---|---|---|
| P1-0 | **Terminal Bridge** — the agent asks to run commands in a VS Code terminal | equivalent to Claude Code's local exec | The extension connects to the Gateway as a **client/node role** (official mechanism: node host over WS). The agent calls exec (tests, scripts, rg) through the Gateway's standard exec-approvals mechanism; the extension receives the request, executes it in a VS Code terminal (`window.createTerminal` + shell integration API), and the output streams back to the agent. The loop closes: edit → test → fix. Approval: show the command to the user + an allowlist (`pytest`, `npm test`, `rg`, `dotnet test` — without confirmation). | **M–L** | The key feature for "the agent lives on the Gateway, the project lives on the local machine". Depends on P0-1. Details: §5.5 |
| P1-1 | **Inline diffs with accept/reject** | Manual mode, per-change review, Accept/Reject at Cursor | Mechanism (see §5.1): extract file edits from the agent's toolCall events; show the proposed version via `vscode.diff` (an OriginalContentProvider for the "before" state), accept = apply to disk/commit, reject = ignore. MVP simplification: **the agent already applied the edit on the Gateway host** → work with the already-changed file: keep a pre-edit snapshot (from a toolCall "write started" event or from git), show a diff view, accept = keep, reject = restore the snapshot. Per-change buttons — v2. | **L** | The main risk: edits happen on the Gateway/agent side, not in VS Code. For local repos the files are directly accessible; for a NAS see §5.4 |
| P1-2 | **Permission modes (Manual / Edit automatically)** | a mode indicator in the prompt box | A UI flag → passed into the prompt context (an instruction to the agent "do not write files, show the plan of changes") plus a soft restriction via the Gateway's tool policy, if available. Full server-side enforcement is a question for the Gateway; on the MVP: prompt-level + movement of acceptance through P1-1. | **M** | Agent-side enforcement is not guaranteed — we set honest expectations in the UI |
| P1-3 | **Plan mode** | `/plan`, the plan as a Markdown document, inline comments | A chat mode "plan": send the task with a system instruction "compose a plan, do not change files"; the result is Markdown. Buttons under the plan: "Open the plan in the editor" (an untitled/`plan-<ts>.md` in the workspace, which the user comments on/edits) and "Approve plan" (sends the document, or its diff, back as approval via chat.send; the mode switches to edit). | **M** | P0-3; low risk |
| P1-4 | **Checkpoints / rollback of edits** | a rewind button on a message: fork / rewind code / fork+rewind | For local git repos: a git hook before/after each "wave" of edits (a toolCall event carrying files) → tagged commits/stash, or in-memory snapshots. Rewind = `git checkout` the snapshot. Fork conversation = a new Gateway session with the history copied (to be worked out; MVP: "rewind code" only, fork is v2). | **L** | Depends on P1-1; for NAS repos git runs in the same place, with commands issued by the agent or via node exec |
| P1-5 | **Tool-call groups + Focus view** | collapsible tool steps, Ctrl+Alt+F | Render toolCall events as collapsible rows; a toggle in the webview to hide tool activity (persisted in settings). | **S–M** | P0-3 |
| P1-6 | **Abort / interrupt / steer** | (implicit in the UX) | A stop button → `sessions.abort`/`chat.abort`; a new message while a run is active → `chat.send queueMode:"steer"` (with the UI status updated to "interrupting"). | **S** | P0-3 |
| P1-7 | **Multi-panel parallel sessions + indicators** | Open in New Tab/Window, coloured tab dots | One ChatViewProvider class, instances per session (webview views in editor tabs). A dot on the tab when pending/finished. | **M** | P0-2, P0-3 |
| P1-8 | **Usage/token indicator** | a context indicator | `usage` events are already in the ChatEvent model; show totalTokens plus a rough context estimate. The Gateway's `/usage` method for detail (optional). | **S** | P0-3 |

### P2 — nice to have

| # | Feature | Implementation | Estimate |
|---|---|---|---|
| P2-1 | AI titles for new sessions | `sessions.title.prepare` → `displayName` on `sessions.create` | S |
| P2-2 | Auto-archive/groups in the history list | local categorisation over sessions.list (grouping per workspace folder in VS Code state) | M |
| P2-3 | Side questions `/btw` | a side panel: a second webview with a separate one-shot chat session that does not write into the main one | M |
| P2-4 | URI handler `vscode://openknot.claw-code/open?prompt=...&session=***` (the ID must match `publisher.name` in package.json — `openknot.claw-code`; VS Code routes `vscode://<publisher>.<name>/`, so a `openknot.openclaw` authority would never reach this extension) | registerUriHandler, prompt prefill, resume by sessionKey | S |
| P2-5 | Export conversation / copy response | serialising the transcript to md/txt; a copy button | S |
| P2-6 | @terminal and background tasks (/tasks) | the Windows/Terminal API to read the active terminal; mapping Gateway background processes (background-process docs) | M–L |
| P2-7 | Screen reader announcements | aria-live in the webview, a focus-last-message command | M |
| P2-8 | MCP/plugin management | delegate to the Gateway (plugins already live on the Gateway); the UI is view-only | L, optional |

### Explicitly out of scope (we do not duplicate — and why)

| Claude feature | Why we skip it |
|---|---|
| **Bundled CLI / terminal mode** | We will **not bundle our own CLI** into the extension — terminal mode is niche. This does not mean dropping the existing external acpx transport: it remains the fallback (§0.3, P0-1) |
| **Login/Anthropic accounts, Claude-format permission rules storage, `~/.claude/settings.json`** | Authentication is a Gateway token; permission rules belong to Gateway policy, not the extension |
| **MCP configuration from the extension** | MCP lives on the Gateway/agents; manage it from the Control UI. Duplicating the UI means maintaining two sources of truth |
| **Claude in Chrome (`@browser`)** | OpenClaw has its own browser tool on the Gateway; the extension only needs to mention it in prompts |
| **Claude subscription usage bars, prompt cache clock** | Specifics of Anthropic billing; we have the Gateway's model routing |
| **Cloud sessions (claude.ai Web tab)** | The equivalent is the Gateway's sessions.dispatch/placement; that is a gateway feature, not an extension one (a UI wrapper is optional in v3) |
| **Plugins/marketplace UI** | ClawHub/OpenClaw plugins are managed on the Gateway; no local marketplace in the IDE |
| **Claude's auto memory UI** | Memory is already implemented (memory-lancedb per agent); a memory-reveal UI is possible far in the future, but not within this plan |
| **Python environment activation, useTerminal, claudeProcessWrapper (spawn leftovers)** | Environment activation and spawn-architecture wrappers go away with it. Do NOT confuse this with the **Terminal Bridge (P1-0)**: there the VS Code terminal executes agent requests through Gateway exec-approvals, which is a new feature, not a leftover |

---

## 5. Specific mechanics

### 5.1 Inline diffs (accept/reject) — in detail

Event flow: the agent works on the Gateway (or a paired node). File edits appear as **toolCall events** in the session stream (the write/edit/apply_patch class of tools). The extension:

1. **Interception**: in the event reducer, recognise a toolCall with a file effect (the `write`/`edit`/`apply_patch` class; concrete tool names come from discovery/the agent runtime, and the mapper lives in contract.ts).
2. **File location**:
   - local workspace: relative path → `workspace.rootPath`;
   - NAS/paired node: see §5.4.
3. **Diff rendering**: `vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title)`, where left is the `openclawOriginal:` content provider (holding the "before" content; the source is (a) reading the file before the apply event, (b) or, if we are late, git HEAD/stash), and right is the real/proposed file.
   - MVP: the agent writes the file directly → a diff of "HEAD vs working copy", accept = mark reviewed, reject = restoring the **exact pre-agent snapshot** (the file contents read before the apply event). `git checkout -- file` is not a valid reject: it restores HEAD and would destroy uncommitted user edits that existed before the agent started; only fall back to HEAD if the file's cleanliness was verified beforehand.
   - v2: pre-apply — in Manual mode the agent returns proposed content in the toolCall details → the extension applies it itself (the edit happens on the client — works only for local repos), per-change accept/reject buttons in the diff (TextDocumentContentProvider + decorations).
4. **Accept/Reject for unobserved edits**: if the file is on a NAS and not reachable through the filesystem — degrade to a textual diff (from the toolCall details or a `git diff` requested from the agent) in the chat with accept ("ok")/reject ("revert file X") buttons. An honest fallback with no false UX.
5. **Commands**: `openclaw.acceptChangeAtCursor` / `rejectChangeAtCursor` — by cursor position in the open diff document (v2).

Risks: event ordering (the edit is applied before we read the "before" state) — closed by pre-reading on the toolCall start event plus a git fallback; an unsynchronised agent on another host — a textual diff fallback.

### 5.2 Plan mode — in detail

State in the UI: `plan | execute`. Entry: a mode button, `/plan [task]`. Sending: a system instruction plus the prompt; the agent replies with a plan (Markdown). Buttons under the plan: "Open in the editor" (an untitled md in the workspace, with inline comments), "Approve" (sends: "the plan is approved, execute it; user edits: <diff/comments>"), "Cancel". After approval — the mode switches to execute and the same session continues. Resume: if a session ended in plan — restore the mode (the last message being a plan is recognised by its marker/structure).

### 5.3 Checkpoints/rollback — in detail

The unit is a "wave of edits" between toolCall lulls within one run. For local git repos: before each run with file effects — take a snapshot (configurable: by default we use `git stash create` without touching the index and store the SHA in the session's checkpoint registry). Rewind: `git checkout <stash> -- .` or restoring specific files. **`git stash create` does not cover untracked files**, and `git checkout <stash> -- .` does not remove files created after the snapshot — so the checkpoint registry must also store the set of untracked/new/deleted paths, otherwise the rewind is incomplete. Non-git folders: shadow copies under `~/.openclaw/vscode-checkpoints/`. On a NAS: git operations are performed by the agent at the extension's request (the prompt protocol) or via node exec — if a paired node exists, the second option is more reliable (v2).

### 5.4 Where the project files live: gateway vs the local machine (the universal breakdown)

The general case for the product: the Gateway (and the agent's workspace) lives on one host (Docker server, NAS, VPS), while the user's VS Code is on another. The project files may sit next to the Gateway, on the machine with VS Code, or be absent from the filesystem entirely (chats via paste). Options:

| Option | When | Mechanics |
|---|---|---|
| **A. Repo next to the Gateway + VS Code Remote (SSH/WSL/Tunnel)** | the main path for code | Remote opens the folder in the same place the agent's repo lives — all files are "local" to the window; diffs/checkpoints work as usual. The recommended path for code. |
| **B. Paired node exec** | the window is local, the repo is on the Gateway host, Remote is not used | For reading/diffs: `nodes`-invoke through Gateway RPC (dir.list/file.fetch) — for previews/context only; edits go through the agent. The diff is textual (see 5.1.4). |
| **C. Textual context without a filesystem** | the code is not reachable by the agent through the filesystem (closed environments, no git sources) | The extension inlines text fragments into the prompt (it already can); the agent returns a patch/text, applied manually. No filesystem magic. |

Decision: the MVP is optimised for A (nothing needed — it works out of the box); B is a textual-diff fallback (P1-1); C already exists. **Documenting all three scenarios in the product README is still outstanding** — the current README has no Remote/SSH, paired-node, NAS or textual-filesystem fallback section, so this item must not be counted as delivered.

### 5.5 Terminal Bridge — in detail (P1-0)

The problem: the agent (on the Gateway) must be able to run commands on the user's machine — tests, project scripts, `rg`/codebase search, builds — and get the output. Without this, an agent on the Gateway is "blind and handless" with respect to a local project.

Mechanics (all the components already exist in the Gateway, nothing to wait for):
1. **Executor registration**: on connecting, the extension declares itself as a node/client role with exec capability (the same protocol the OpenClaw desktop nodes use; see protocol/handshake — caps/commands/permissions).
2. **Agent request**: standard exec through the Gateway with `exec-approvals` — the agent initiates, the Gateway routes to our "node" client.
3. **Execution in the VS Code terminal**: `window.createTerminal` (plus the shell integration API for structured output). The user sees the command and the output in real time — the same transparency as Claude Code.
4. **Approval UX**: a popup/indicator "the agent wants to run: …" with Run once / Always allow / Deny. **Always allow is scoped to the exact execution context — command + arguments + working directory + workspace — not to a runner-name allowlist**: an allowlist by name (`pytest`, `npm test`, `tsc`) is unsafe, because those commands execute workspace-controlled scripts and can run arbitrary code. Deny returns a refusal to the agent — it adapts.
5. **Returning output**: stdout/stderr streams to the agent as the tool result; long outputs are truncated with the tail kept (like tokenjuice).

Implementation in stages:
- **MVP+ (optional in the MVP)**: a manual mode — the extension shows a "command request" in the chat, the user runs it themselves, and a button sends the output to the agent.
- **v1 (full P1-0)**: automatic exec via approvals with an allowlist, output streaming.
- **v2**: background tasks (dev servers) in `/tasks`, several parallel terminals, working across multiple workspaces.

Risks: security (allowlist + approvals are mandatory, never "execute everything silently"); the shell integration API differs across VS Code terminals — a fallback to plain output capture; Windows (PowerShell) — tested separately.

**An alternative for scenario B (repo on a NAS, window local)**: the commands are executed by the agent on the NAS itself — no terminal bridge needed, only output. The Bridge covers the "repo on the local machine" scenario (Remote-SSH is still preferable, but the bridge also works without it — via the paired node mechanism).

---

## 6. Roadmap: MVP → v1 → v2

### MVP (≈ 2–3 weeks) — "a useful chat to the Gateway"
Contents: P0-1..P0-6 (WS transport with a fallback to the old acpx, agent selector, streaming, history+resume, auto-context build-outs, slash commands), P1-6 (abort/steer), P1-8 (usage), P1-5 (tool-call groups, focus view can wait for MVP+).
**Readiness criteria:**
- Connecting to the Gateway by token with reconnect; the token in SecretStorage.
- Choosing an agent in the UI; a message goes to its session; the reply streams; tool calls are visible as groups; stop works.
- History: a session list with previews, clicking restores the transcript (including the cold placeholder), continuing works after a window restart (catch-up by deltaCursor).
- Slash commands work on the new transport; the selection/open file/diagnostics reach the context.
- The old acpx transport is selectable if the Gateway is unavailable (a fallback switch in settings).
- Tests: unit tests for GatewayClient (mock WS), the event reducer, contract adapters.

### v1 (≈ +3–4 weeks) — "editor integration"
Contents: **P1-0 (terminal bridge: approvals + allowlist + output streaming)**, P1-1 (inline diffs MVP: a diff view, accept/reject at the file level, a textual fallback for a NAS), P1-2 (Manual/Edit automatically modes at the prompt+UI level), P1-3 (full plan mode: the plan as an md document, approve), P1-4 (checkpoints: git-based for local repos, rewind code), P1-7 (multipanel with indicators).
**Readiness criteria:**
- An agent edit in a local repo shows a diff; reject returns the file to its previous state.
- Plan mode: a full plan→edit the plan→approve→execute cycle within one session.
- The checkpoint button on a message returns files to their pre-run state (git repo).
- Two parallel sessions in different tabs with activity indication.

### v2 (≈ +2–4 weeks) — "polish and ecosystem"
Contents: per-change accept/reject, P2-1 (AI titles), P2-2 (groups/auto-archive), P2-3 (/btw), P2-4 (URI handler), P2-5 (export/copy), P2-7 (a11y), the focus view toggle, NAS checkpoints via node exec if a paired node is connected, a `/tasks` map of background tasks (P2-6 partly).
**Readiness criteria:**
- Per-change review in the diff (up to 100 changes), Accept/Reject at Cursor.
- Session titles are generated; history groups persist per workspace.
- A deep link opens a tab with a prefilled prompt.
- The webview passes a basic screen reader walkthrough (aria-live, focus last message).

---

## 7. Summary priority table

| Priority | Features | Total estimate |
|---|---|---|
| P0 | WS transport, agent selector, streaming, history/resume, auto-context, slash | ~2–3 weeks |
| P1 | **Terminal bridge**, diffs, permission modes, plan mode, checkpoints, multipanel, abort/steer, usage, focus view | ~3–4 weeks |
| P2 | Titles, groups, /btw, deep links, export, a11y, /tasks | ~2–3 weeks |
| out of scope | Bundled CLI, Anthropic accounts, MCP UI, Chrome, cloud tab, plugin marketplace, memory UI | — |

## 8. Main risks (summary)

1. **The Gateway protocol is not frozen** → a contract layer `contract.ts`, discovery, additive event handling. Keep one file as the diff when the protocol changes.
2. **File edits happen outside the VS Code process** → MVP via git/snapshots plus a textual fallback; the Remote-SSH path covers 80% of scenarios.
3. **Complex `sessions.list` semantics** (snapshots, ownership, activeRunIds) → use a minimal subset: a list of agents' main sessions + hasActiveRun; do not try to reproduce the entire visibility model.
4. **Client-side permission enforcement is unreliable** → honest UI: the modes are instructions to the agent plus server-side policy, if/when the Gateway exposes it.

## 9. Review additions 2026-09-24 (productivity)

Gaps found at the second review (beyond the terminal bridge P1-0):

| # | Feature | Why | Priority | Estimate |
|---|---|---|---|---|
| A-1 | **Mid-session model switching** (`/model`) | For coding: a fast model for routine work, a strong one for architecture; Claude can | P1 | S |
| A-2 | **Inserting images/screenshots** (paste from the clipboard, drag & drop) | A UI bug screenshot → the fix; Claude supports it | P1 | S |
| A-3 | **Keybinding set**: `Cmd+Esc` (editor↔chat focus), `Cmd+Shift+Esc` (new tab), `Cmd+N` | Working speed, Claude UX parity | P1 | S |
| A-4 | **Notification on background completion** (OS notification + a coloured dot on the tab) | Long tasks: you left the tab → you come back via a notification | P1 | S (the dots are part of P1-7) |
| A-5 | **Gitignore-aware @ file search** | The @-menu must not offer node_modules/builds/artifacts | a P0-5 addition | S |
| A-6 | **Multi-root workspace awareness** | The client's repo plus shared libraries in one window; indicate the file's root in the context | P1 | S–M |
| A-7 | **Context-window indicator + a /compact hint** | Warn before overflow, not after | a P1-8 addition | S |
| A-8 | **Privacy: no telemetry, the token only in SecretStorage** | a mandatory community-product requirement (see §0.2) | cross-cutting | — |
| A-9 | **Git worktree for the agent** (v3) | Parallel agents in one repo without conflicts | P3/idea | M |
| A-10 | **Agent profiles per task type** (coding/review/domain) | Starting a session with the right agent + slash set quickly; domain-specific nuances belong in user profiles, not in the core | P2 | S |
| A-11 | **Project Rules Ingester — built-in loading of project rules/skills** | Projects carry knowledge in standardised files (AGENTS.md, CLAUDE.md, .cursor/rules, .github/copilot-instructions.md, CONTRIBUTING, docs/adr). The ingester scans the repo by a configurable directory pattern set and publishes the rules to memory-wiki with provenance (file + lines) and a project binding; recall at session start by key. This is part of the plugin (not a separate product), strengthens every Gateway agent, and provides the `/conventions` slash command in the extension. | P1 | M–L |

#### A-11 Project Rules Ingester — design

**Project binding (hierarchy):**
1. **Git remote URL** (normalised origin) — the primary key; it survives renames and works when the repo is cloned elsewhere.
2. **An explicit alias** (`project: <name>`) — a manual override, required for non-git projects (proprietary configurations, legacy repos).
3. **Path/folder name** — a fallback when there is no git.
Recall: at session start or on agent selection the extension determines the key (git remote from the workspace → an alias from settings → the path) and supplies the found rules to the context.

**The format catalogue (configurable, not hardcoded):** AGENTS.md, CLAUDE.md/.claude/*.md, .cursor/rules/*.mdc, .github/copilot-instructions.md, .windsurfrules, .clinerules, CONTRIBUTING.md, docs/adr/*.md, README#Architecture; custom globs. Extraction is a faithful copy of the text with provenance (LLM compression is an option, the raw text is always stored).

**Lifecycle:** ingest on request (/conventions ingest) or on first contact with the repo → wiki synthesis with project metadata → a "fingerprint" (a hash of the files) → on change: a proposed update diff, never silent. Export back (opt-in): writing rules from the wiki back into the repo's AGENTS.md — this makes the project useful for any agent (Cursor, Claude), a strong argument for the community.

**Privacy (mandatory for the community):** everything is local (the user's memory-wiki vault); corporate rules do not leak anywhere; no telemetry.

**Extension slash commands:** `/conventions` (show/update the project rules), `/conventions ingest` (scan the current workspace).

A note on specific formats: domain-specific formats (for example .bsl files, proprietary LSP servers) belong in **user configs/profiles** (A-10), not in the product core. The core is format-agnostic; the terminal bridge plus textual context (§5.4 C) closes the "code → question → edit" loop regardless.

## 9.1 Architectural foundation: infrastructure, logging, code quality

Technical decisions made once before the code starts, binding for the whole project (community product → universality, locality, maintainability).

### 9.1.1 Project infrastructure

- **Stack** (owner's decisions): TypeScript **strict**, esbuild (bundling), **Vitest** (owner's decision 2026-10-03: the migration from Jest is complete, PR #28), **oxlint** (owner's decision, the oxc ecosystem; the migration from eslint is complete). pnpm stays. Do not add new runtimes (no root bundler/monorepo on top).
- **The bundler stays esbuild for now (decision, 2026-09-24).** Faster Rust options were considered (Rolldown 1.2.x/tsdown — the main candidate; oxc-transform). The decision NOT to change now: (1) the speed gain is insignificant at the extension's bundle size — main + webview already build in a fraction of a second; (2) esbuild is already configured in the fork and is CSP-correct for the webview (`content-security-policy` — a flat file); (3) a switch would add risk at the MVP stage with no payoff. **Deferred option**: if the webview build starts slowing the dev loop as the project grows — move to tsdown/Rolldown in one step (a familiar `defineConfig`), a single migration PR.
- **The main unit of code is a class** (owner's decision): business logic and services are classes with explicit dependencies (DI through the constructor, injecting the logger/client/etc.), not utility functions and not global singleton state. This improves testability (Vitest mocks on a class) and readability. Functions are acceptable as thin cleaning utilities inside core/util, but not as state carriers.
- **Repository structure** (decomposing the fork's monoliths):
  - `src/extension.ts` — activation/deactivation only (a thin bootstrap).
  - `src/core/` — runtime not bound to VS Code: `gateway/GatewayClient.ts`, `gateway/contract.ts` (protocol types + versions), `gateway/adapters/`, an event dispatcher, a UI-model reducer, the two chat backends (`ChatService` for acpx, `GatewayChatService` for the Gateway), used through their union type.
  - `src/vscode/` — VS Code bindings: commands (the registry), views (webview controllers), config (settings + SecretStorage), terminals (the bridge), diffs/checkpoints, the status bar.
  - `src/webview/` — the webview frontend: views/components, HTML assembly (pulled out of the 117 KB string), the webview↔extension message layer.
  - `src/__test__/` — tests per module (Vitest).
- **Separating core/vscode** — testability: the whole runtime (gateway, deduplication, the reducer) is testable without a VS Code head; the vscode layer is thin adapters.
- **Monolith decomposition — done** (owner's decision was to treat it as an immediate priority, not a deferred item; both have since landed — see §2): `src/extension.ts` (~72 KB) is a one-line bootstrap, and `src/chat/getWebviewContent.ts` (~117 KB) is gone, its content having moved into `src/webview/content-js.ts` / `content-css.ts`. The volume scheme above is the state the code is in now.
- **CI** (GitHub Actions, **already exists**: `.github/workflows/ci.yml`): `pnpm install` → **build + vitest on ubuntu/windows/macos**, with **typecheck, oxlint and license-check on Linux only** (those give the same answer on every OS). Triggers: `pull_request` and `push` to `main` — **no tag trigger and no vsce/ovsx publishing yet**; the release workflow below is still to be built. Catch-early on every PR.

### 9.1.2 Logging (local, without sensitive data)

- **Levels**: debug / info / warn / error. Two streams: in the event dispatcher (RPC → log) and in the transport (WS lifecycle: connect/reconnect/backoff/auth).
- **Red lines**: never log the token, keys, prompt bodies, file contents. In the WS-header log — only statuses (connect/error/reconnect/N), never payloads. File names are fine, contents are not.
- **Destination is unified per environment** (owner's decision, 2026-09-24):
  - **CI**: write to a log file (e.g. `logs/claw-code.log`) — needed for pipeline diagnostics; CI has no tokens/secrets.
  - **Production (VS Code on the user's machine)**: *no writing to disk by default* — only the VS Code Output Channel ("Claw Code"), at warn+ (debug only with `OPENCLAW_DEBUG=1`/a dev setting). The file-log mechanism exists (the same logger is reused), but in production it is off by default and never contains sensitive data. Just two destination configurations of one logger class (CI env / runtime).
- **Debug isolation**: a separate dev gateway — the agents' working memory is not polluted with debug events. (No such gateway is documented in this plan; the personal-context section that used to carry it was excluded — see §10.)
- **Errors** — stable codes (a `LogEvent` enum), with a context bag of safe fields only (sessionKey, iteration, event type), without stack traces leaking into the UI.

### 9.1.3 Code quality and deduplication

- **Lint/types**: oxlint + `strict` TS (`noImplicitAny`, `strictNullChecks`) — keep them enabled in CI.
- **Deduplication**: one source of truth for protocol types — `contract.ts`; adapters funnel RPC methods/fields (mitigating protocol version risk). RPC calls go through a single dispatch; events go through **one pure reducer** (owner's decision: a pure `(state, event) => newState`, no side effects; UI updates happen separately afterwards). Utilities (diff, auto-context, connection backoff) live in `core/util` and are reusable.
- **Readability**: the main units are classes (see 9.1.1); domain modules with explicit names; the webview split into views; long functions broken up; types next to their use site.
- **Logging instead of console.log**: a single logger class (owner's decision), injected into services (convenient to mock in tests).
- **Tests**: Vitest — unit tests for the core reducer (a pure function), gateway adapters (mock WS), deduplication; an integration smoke test against a local dev gateway with a fake token, with no real agent.

### 9.1.4 PR policy (community)

A standalone project (the owner's repository); upstream OpenKnots is not pulled and not synced (see §0.4) — one repository, one PR flow. Upstream is only an archive/legal reference (MIT + we keep the thanks); cherry-picking from it is not planned.

**Branches/triggers:**
- `main` protection is **in place via a ruleset, not the classic branch-protection API** (re-audited 2026-10-03): `branches/main/protection` still returns `Branch not protected`, but the active `main-branch-protection` ruleset does enforce the checks below. What the ruleset requires: required status check `ci` with the strict (up-to-date-branch) policy, `required_approving_review_count: 1`, required thread resolution, dismissal of stale reviews on push, and allowed merge methods merge/squash/rebase. It carries a `RepositoryRole` bypass (`always`), so the owner can merge without an external approval. The review gate at the start: **the owner is the sole maintainer and approver**. GitHub **does not let a PR author approve their own PR**, so the `1`-approval requirement is satisfied only through that owner bypass today; tighten it (2 reviews for other people's PRs, and reconsider the bypass) once other maintainers/contributors appear.
- `dev` as a pre-release branch is optional at the start (the MVP can go straight to main through a PR).
- Branch naming: `feat/`, `fix/`, `chore/`, `refactor/`, `docs/`.
- **Conventional Commits** (semver derived from messages automatically).
- **Commit signing**: for the owner — **mandatory, a GPG key + GitHub Verified** (the gold standard, the owner's choice 2026-09-24): generate the key once, add the public one to GitHub, configure git to sign commits/tags automatically; commits in `main` and releases are `Verified`. For contributors — **recommended, not gating** (a hard signing requirement would scare newcomers away before their first PR).
- **Mandatory checks in a PR**: typecheck → oxlint → vitest → build → license-check.
- CHANGELOG: automatic (release-please) or manual by category.

### 9.1.5 CI/CD (GitHub Actions — **CI already exists in the fork**: `.github/workflows/ci.yml`; what still needs building is below)

- **Workflow 1 — CI (already implemented, `pull_request` + `push` to `main`):** `pnpm install --frozen-lockfile` → **`build` + `vitest` on a ubuntu/windows/macos matrix**, plus **`typecheck` + `oxlint` + `license-check` on Linux only** (`ci.yml` gates them on `runner.os == 'Linux'`, since those answers do not vary by OS). Still to do: extend the OS matrix to typecheck/lint if a platform-specific failure ever appears, and add the tag-triggered release workflow.
- **Workflow 2 — Release (on a `v*` tag):** the full pipeline → build `.vsix` via vsce → publish to the **VS Code Marketplace** and **Open VSX** (2 artifacts) → a GitHub Release with the `.vsix` + an auto-CHANGELOG. The version comes from the git tag, with no manual bump. Publishing/release — owner only (requires the owner's approval; contributors do not publish).
- **Workflow 3 — a PR-generator sync from upstream** — **not needed** (we do not work with or sync from upstream, §0.4); upstream is only an archive reference for attribution.
- **License-check**: `license-checker-rseidelsohn --production --onlyAllow "MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;0BSD;CC0-1.0;Unlicense"` — scanning **production** npm dependencies against that allowlist; an explicit allowance for specific exceptions; **fail on copyleft** (GPL/AGPL/LGPL) and on undefined licenses. Note `--production` means dev dependencies are **excluded from the check**, not held to a separate list — the roadmap previously claimed otherwise. Only allowlisted code goes into the prod bundle.
- **Pre-approved dependencies (owner's decision, 2026-09-25)**: **lodash** (MIT) and **luxon** (MIT) — allowed without separate approval if a task requires them. Both pass the current license-check allowlist.
- **Dependency proposals**: the assistant may propose other tools/libraries if they meet the licensing requirements (MIT/Apache-2.0/BSD/ISC; fail on copyleft) — the owner reviews each proposal before it is added.
- **Quality enforcement**: required status checks on main — the `main-branch-protection` ruleset requires the aggregate `ci` check, and `ci.yml:66-75` fails unless every OS in the matrix passed, so license-check and the ubuntu/windows/macos legs all gate the merge; **Dependabot** for dependencies; **CodeQL** security scan (free for public repos).
- **Secrets in CI**: OVSX_TOKEN and the like — through GitHub Secrets, never in code or logs. The release job handles publishing secrets, so **every CI job's log is sensitive by default**: no job may dump environment values or protocol payloads, and the file log (§9.1.2) is safe only because the red lines above are enforced, not because it runs in CI. Check for accidental secrets in the diff.

### 9.1.6 Sprint 1: refactoring "dump files" + architecture analysis (included in Sprint 1, owner's decision 2026-09-25)

**Owner's principle**: the project must not have "dump files" — large multi-purpose modules get split by purpose. Namespaces are allowed for tidying up code organisation (owner's decision 2026-09-25).

**Task 1 — Architecture analysis and planning** (the first days of the sprint, before code):
- Review every module under `src/` (core/, vscode/, webview/, overview/, chat/) for "dumps": files over 300 lines with more than 10 exports of differing purposes.
- Target structure: modules by responsibility, namespaces/barrels for public surfaces, classes + DI for stateful parts.
- Result: a module-map document (into the plan, an addition to §3) + a list of dump files with a plan for splitting them.
- Explicit candidates: `src/core/accessInfo.ts` (~416 lines, 20+ exported functions).

**Task 2 — Refactoring accessInfo.ts** (after task 1, per its map):

**File**: `src/core/accessInfo.ts` (~416 lines, 20+ exported functions) — it grew into a utility dump in a single module. The refactoring plan:

1. **Split into modules by purpose** (the main work, not lodash):
   - `core/redact.ts` — `redactEndpoint`, `redactPlainSecrets` (security utilities, self-contained and testable)
   - `core/extract.ts` — `extractAccessInfoFromConfig`, `extractAccessInfoFromCli`, `extractMcpServers`, `extractTools`, `scanAccessInfo`
   - `core/format.ts` — `formatAccessSummaryShort`, `formatAccessSummaryMarkdown`, `formatList`, `formatNamedEntry`, `summarizeKeySources`
   - `core/util.ts` — small predicates/helpers: `isRecord`, `asString`, `isUrl`, `looksLikePath`, `uniqueList`, `isKeyIndicator`, `extractEnvVarName`, `getEnvVarFromRecord`, `getFilePathFromRecord`, `createEmptyAccessInfo`
2. **lodash replacements** (pre-approved, MIT): `uniqueList` → `_.uniq`, `asString` → `_.toString`/`isString`, `getEnvVarFromRecord`/`getFilePathFromRecord`/`extractMcpServers` → `_.get`/`_.pick`/`_.map` combinations. Pure lodash paraphrases are a utility for its own sake.
3. **Rules during the refactoring**: function descriptions at the function level (a USER.md directive), no per-line comments; classes + DI for modules with state; re-exports from `accessInfo.ts` are preserved until the imports are migrated (without breaking PRs).
4. **Estimate**: S (half a sprint), possible in waves: (a) extract into core/redact.ts + lodash replacements; (b) the divergence of format/extract/util with re-exports; (c) deleting the shim file.

### 9.1.7 Sprint 3 candidate: a shared markdown/text utility module (owner's proposal, 2026-09-26)

**Facts**: there is no duplication today — `renderMarkdown`/`escapeHtml`/`escapeGlob` live only in `webview/viewMessaging.ts`; `accessInfo/format.ts` is markdown report generation (domain formatting, not rendering). But both layers work with markdown.

**Plan (S). Owner's decision 2026-09-26: do it on the next touch of these files, do not allocate a separate sprint:**
- Move out `core/markdown.ts` (or `core/text.ts`): `renderMarkdown` (markdownToHTML + sanitize + the escapeHtml fallback), `escapeHtml`, `escapeGlob` — pure text/markdown utilities with no vscode dependency.
- `viewMessaging.ts` imports from there; do NOT move `accessInfo/format.ts` (that is a domain report; moving it would create a new mini-dump).
- If accessInfo ever needs HTML escaping — take it from `core/markdown.ts`.
- Sprint 3 leftovers from the Architect's review: `core/frames.ts` (parseFrame + mappers from gatewayChatService/contract), splitting the accessInfo tests per submodule.

---

## Sprint 1 audit (checked against the code, 2026-10-03)

§9.1.6 checked against the repository's actual state, not against the plan.

### Task 1 — architecture analysis and planning: **partial**

Fully covered:
- `src/extension.ts` — **1 line, 58 bytes**. The ~72 KB monolith was decomposed.
- `src/chat/getWebviewContent.ts` — **the file is gone**. The ~117 KB monolith was moved into `src/webview/content-js.ts` / `content-css.ts`.

Not covered:
- **The module map as an artifact is missing.** §9.1.6 required the result to be "a module-map document + a list of dump files with a plan for splitting them". Neither that document nor a section of this plan exists — to this day there is only the `core/` / `vscode/` / `webview/` split.
- **Dump files above the threshold were never identified — the measurement exists, the conclusion does not.** The task's threshold is "more than 300 lines with more than 10 exports of differing purposes". A line count gives:

| File | Lines | Assessment |
|---|---|---|
| `src/webview/ChatViewProvider.ts` | 2940 | the largest candidate |
| `src/webview/content-js.ts` | 2774 | imported TypeScript source: webview script fragments (`TOOL_STATUS_JS` and friends) plus `CONTENT_JS`; hand-written code, a candidate for splitting |
| `src/core/gatewayChatService.ts` | 2307 | protocol + transport in one module |
| `src/webview/content-css.ts` | 1276 | checked-in source (its header says: a mechanical extraction of the `<style>` block, verbatim) — not a generated build artifact, but not hand-designed either; a candidate for moving into a separate CSS file |
| `src/chat/ChatService.ts` | 801 | over the line count, but under the export threshold (7 top-level exports) — so it does not meet the full criterion |
| `src/webview/viewMessaging.ts` | 781 | above the threshold |
| `src/vscode/commands/setup.ts` | 579 | candidate |
| `src/core/gatewayConfig.ts` | 564 | candidate |

`extension.ts` and `getWebviewContent.ts`, named explicitly, did exit the monolith list; the others grew **after** the task was set, so they never fell into its scope.

### Task 2 — refactoring `accessInfo.ts`: **partially closed**

- The `src/core/accessInfo.ts` monolith is **gone**; the directory `src/core/accessInfo/` contains `redact.ts`, `extract.ts`, `format.ts`, `util.ts`, `types.ts`, `index.ts`.
- Wave (a) — extract + lodash replacements: `extract.ts` imports `compact, get, map` from `lodash-es`; `util.ts` — `sortBy, uniq`. **But** §9.1.6 also required replacing `asString`, `getEnvVarFromRecord` and `getFilePathFromRecord` — all three **still live** in `src/core/accessInfo/util.ts:9-57`. Only the lodash paraphrases for `compact/get/map` and `sortBy/uniq` were removed; the hand-written `asString`/`getEnvVarFromRecord`/`getFilePathFromRecord` remain, so the requirement is not fully met — a deliberate departure, not a completed task.
- Wave (b) — splitting by module: done, with the re-export living in `index.ts`.
- Wave (c) — deleting the shim file: the shim is gone, the public surface moved into the directory with a barrel.
- Imports are not fully migrated: 4 sites import the `accessInfo` barrel, 4 import submodules directly. The plan explicitly permits this ("re-exports are preserved until the imports are migrated, without breaking PRs"), but it means the migration is not finished as a formality.

### Conclusion

Sprint 1 is **partially** closed: for task 2, waves (b)/(c) and the lodash-paraphrase replacements are done, but wave (a) is not fully met (see above); for task 1, the named monoliths are done, but its **artifact** is not — the module map and the dump-file inventory. The next sensible step: write the module map from the current structure and decide what from the table above goes into the work (the candidates are `gatewayChatService.ts` and `ChatViewProvider.ts`).

§9.1.7 (Sprint 3 candidate, `core/markdown.ts`) is not part of Sprint 1 and was not performed — by the owner's decision of 2026-09-26 it is done on the next touch of the files.

---

## 10. Owner's personal context (not part of the product)

The original section is intentionally excluded from the repository: it is itself marked "not part of the product" and contains data about a specific machine (a NAS, ports, proprietary 1C configurations). The full version lives outside the repository.