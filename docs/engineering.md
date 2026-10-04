# Engineering foundation

Binding technical decisions for the whole project: stack, code structure, logging, code quality, PR policy and CI/CD. Hard-won rules from past PRs live in [development-rules.md](development-rules.md); the plan lives in the [roadmap](roadmap.md). Outstanding work mentioned here is tracked in the roadmap's status table by ID.

## 1. Stack

| Area | Decision |
| --- | --- |
| Language | TypeScript **strict** (`noImplicitAny`, `strictNullChecks`); `module: ESNext`, `moduleResolution: bundler`, `target: ES2022`, `lib: ES2020` |
| Bundler | esbuild (CommonJS output) |
| Tests | Vitest, with a `vscode` mock (migration from Jest complete, PR #28 — owner's decision 2026-10-03) |
| Lint | oxlint (migration from eslint complete) |
| Packages | pnpm |
| Publishing | vsce (VS Code Marketplace) and ovsx (Open VSX) |

No new runtimes, and no root bundler or monorepo layer on top.

**Bundler stays esbuild (decision 2026-09-24).** Rolldown/tsdown and oxc-transform were considered and rejected for now: the main and webview bundles already build in a fraction of a second, esbuild is configured and CSP-correct for the webview, and a switch would add risk with no payoff. If the webview build starts slowing the dev loop, move to tsdown/Rolldown in a single migration PR.

**Pre-approved dependencies (decision 2026-09-25):** lodash (MIT) and luxon (MIT) may be added when a task needs them. Other libraries may be proposed if they meet the licence policy (§6); the owner reviews each proposal.

## 2. Code structure

- **The main unit of code is a class** (owner's decision): services and business logic are classes with explicit constructor-injected dependencies (logger, client, …), not utility functions and not global singletons. Plain functions are acceptable as small stateless helpers.
- **Namespaces are allowed** for organising code (decision 2026-09-25).
- **No "dump files"**: a module over 300 lines with more than 10 exports serving unrelated purposes gets split by responsibility. The current candidates are in the [Sprint 1 audit](audits/2026-10-03-sprint1.md).
- **`core/` is meant to be independent of VS Code**, so the runtime (gateway, deduplication, reducer) is testable without a VS Code host; `vscode/` is thin adapters. Two exceptions exist today: `core/configIO.ts` and `core/gatewayConfig.ts` import `vscode` (the latter handles SecretStorage directly). Moving them, or keeping them as recorded exceptions, is **ENG-7**.

### Current layout

| Path | Contents |
| --- | --- |
| `src/extension.ts` | One-line bootstrap; activation lives in `src/vscode/` |
| `src/core/` | Runtime without VS Code: `gatewayChatService.ts` (the Gateway transport), `gatewayProtocol/` (`adapter.ts`, `registry.ts`, `deviceIdentity.ts`, versioned `v4/` schemas), `gatewayConfig.ts` (settings + SecretStorage — imports `vscode`, see ENG-7), `accessInfo/`, helpers |
| `src/chat/` | `ChatService.ts` — the acpx (local CLI) backend |
| `src/vscode/` | Activation, command registry, config |
| `src/webview/` | `ChatViewProvider.ts`, the webview script and styles (`content-js.ts`, `content-css.ts`), webview↔extension messaging, `chatServiceFactory.ts` |
| `src/overview/` | The Overview tree |
| `src/__test__/` | Vitest tests, mocks and protocol fixtures |

The two chat backends (`ChatService` and `GatewayChatService`) are used through their union type; there is no separate transport interface.

An earlier target layout put the transport under `src/core/gateway/` (`GatewayClient.ts`, `contract.ts`, `adapters/`). The implementation went the `gatewayChatService.ts` + `gatewayProtocol/` way instead; whether to adopt the current layout as final or move to the earlier target is open item **ENG-3**.

## 3. Logging

**Red lines** — never log the gateway token, keys, prompt bodies or file contents. File names, ids, counters and statuses are fine. Transport logs record WS lifecycle only (connect / error / reconnect / backoff / auth, attempt N), never payloads.

**Target design:**

- One logger class, injected into services (easy to mock), with levels debug / info / warn / error and two streams: the event dispatcher (RPC → log) and the transport (WS lifecycle).
- **Production** (VS Code on the user's machine): no writing to disk; the Output Channel only, at warn and above; debug only behind an env var or dev setting.
- **CI**: a file log (`logs/claw-code.log`), teed to the job log and/or uploaded on failure as a short-retention artifact. GitHub Actions artifacts cannot be access-restricted and this repository is public, so an uploaded log is readable by anyone with read access. The file is treated as potentially containing credentials: safety comes from the red lines, never from assuming CI is secret-free.
- Errors carry stable codes (a `LogEvent` enum) and a context bag of safe fields only (sessionKey, iteration, event type); stack traces never reach the UI.
- **Debug isolation**: develop against a separate dev gateway so agents' working memory is not polluted by debug traffic.

**Current state (audit 2026-10-03):** none of the target exists yet. There is no shared logger class, no file sink and no debug gate; four output channels are created independently (`chat/ChatService.ts`, `vscode/commands/shared.ts`, `webview/debugPanel.ts`, `webview/viewMessaging.ts`), all at info level. Two red-line violations exist (re-checked 2026-10-04): `ChatViewProvider.ts:1032` logs the first 80 characters of every prompt, and `webview/debugPanel.ts:210` logs every message from the debug webview as JSON — including `send` messages, which carry the **complete** prompt text (`debugPanel.ts:178`). A third line needs review: `chat/ChatService.ts:412` logs the tail of acpx's stderr, whose content the CLI controls and may include prompt or file text. Tracked as **SEC-2** (the violations and the stderr review) and **ENG-1** (the logger).

## 4. Code quality

- oxlint and strict TypeScript stay on in CI.
- **One source of truth for protocol types** — the versioned schemas in `gatewayProtocol/`; all RPC methods and fields go through the adapter layer, which keeps a protocol change to one place.
- **Target:** RPC calls go through a single dispatch, and events go through **one pure reducer** `(state, event) => newState` with no side effects, with UI updates applied afterwards. **Today** only streamed run text has such a reducer (`core/gatewayRunText.ts`); other events mutate state and trigger side effects directly in `GatewayChatService.applyRunEvent` and `ChatViewProvider.processChatEvent`. Moving to the target is **ENG-9**.
- Reusable utilities (diff, auto-context, backoff) live in `core/`.
- Readability: domain modules with explicit names, the webview split into views, long functions broken up, types next to their use.
- No `console.log`: use the injected logger (§3).
- **Tests**: unit tests for the reducer, protocol adapters (mock WS) and deduplication; an integration smoke test against a local dev gateway with a fake token and no real agent. Tests exercise interleavings, not just the happy path ([development-rules.md](development-rules.md), rule 7).

### Refactoring backlog

- **`core/markdown.ts`** (owner's proposal 2026-09-26; do it on the next touch of these files, no dedicated sprint). Move `renderMarkdown` (markdown → HTML, sanitise, escaping fallback) and its link-safety helpers out of `webview/viewMessaging.ts` into a VS Code-free module and import it from there. Decide then whether the lodash `escape` fallback stays. Do not touch `content-js.ts`'s own `escapeHtml`: that script is injected into the webview as source and cannot import from `core/`. Do not move `accessInfo/format.ts` either — it is domain report formatting, and moving it would create a new mini-dump.
- **`core/frames.ts`**: `parseFrame` and the frame mappers out of `gatewayChatService.ts`.
- Split the accessInfo tests per submodule.
- The dump-file splits from the Sprint 1 audit: `viewMessaging.ts`, `slashCommands.ts`, and possibly `gatewayConfig.ts` (**ENG-2**).

## 5. PR policy

A standalone project with one repository and one PR flow. Upstream (openknots/openclaw-extension) is not pulled or synced; it is an archive and attribution reference only.

- **`main` protection** is the `main-branch-protection` **ruleset** (not the classic branch-protection API, which reports `Branch not protected`). It requires the `ci` status check with the up-to-date-branch policy, 1 approving review, resolved threads and dismissal of stale reviews on push; merge, squash and rebase are allowed. A `RepositoryRole` bypass (`always`) lets the owner merge: GitHub does not let authors approve their own PRs, so with a single maintainer the review requirement is met only through that bypass. Tighten it (2 reviews for other people's PRs, reconsider the bypass) once there are other maintainers.
- A `dev` pre-release branch is optional; PRs can go straight to `main`.
- Branch prefixes: `feat/`, `fix/`, `chore/`, `refactor/`, `docs/`.
- **Conventional Commits**; semver is derived from them.
- **Commit signing**: mandatory for the owner (GPG, GitHub "Verified" on `main` commits and release tags — decision 2026-09-24); recommended but not required for contributors.
- Required checks, in the order `ci.yml` runs them: typecheck → oxlint → build → vitest → license-check.
- CHANGELOG: release-please or manual by category, Keep a Changelog format.

## 6. CI/CD

### Workflow 1 — CI (exists: `.github/workflows/ci.yml`)

Triggers: `pull_request`, `push` to `main`, `workflow_dispatch`. `pnpm install --frozen-lockfile`, then build + vitest on ubuntu / windows / macos, and typecheck + oxlint + license-check on Linux only (their result does not vary by OS). The aggregate `ci` job fails unless every matrix leg passed, and it is the check the ruleset requires.

Outstanding: the failure-log upload or tee step of §3 (**ENG-1**); extend typecheck/lint to other OSes only if a platform-specific failure appears.

### Workflow 2 — Release (to build, **REL-4**)

On a `v*` tag: the full pipeline, then build the `.vsix` with vsce, publish to the **VS Code Marketplace** and **Open VSX**, and create a GitHub Release with the `.vsix` and the changelog. The version comes from the tag, with no manual bump. Only the owner publishes. Publishing requires the owner's own publisher identity — see [roadmap §3](roadmap.md#3-release-identity-name-and-publisher).

### Workflow 3 — upstream sync

Not needed: upstream is not synced.

### Licence check

`license-checker-rseidelsohn --production --onlyAllow "MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;0BSD;CC0-1.0;Unlicense"` scans **production** dependencies only; dev dependencies are excluded, not held to a separate list. It fails on copyleft (GPL/AGPL/LGPL) and on undefined licences; specific exceptions need an explicit allowance.

### Supply chain and security scanning

- **Dependabot** is configured (`.github/dependabot.yml`): npm and GitHub Actions, weekly, minor/patch grouped.
- **CodeQL** is planned, not configured (**ENG-4**).

### Secrets

Publishing tokens (`VSCE_PAT`, `OVSX_TOKEN`) live in GitHub Secrets, never in code or logs. Because the release job handles them, every job log is sensitive: no job dumps environment values or protocol payloads. Check diffs for accidental secrets.
