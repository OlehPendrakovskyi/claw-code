# Proposal: Type-Guard Unification & Code Deduplication

- **Status:** proposal (no code written yet) — awaiting owner review
- **Date:** 2026-09-30 · repo @ `22e0264` (post PR #17)
- **Task card:** `8777fb5e` — "Refactor: typeGuards unification across src/"
- **Method:** jscpd whole-repo scan (min 70 tokens) + full census of guard/read helpers + three read-only recon agents (protocol, webview/chat, core/vscode); every finding verified by reading source; call-site counts via grep. **Estimated effect: ~600–800 lines removed, zero behavior change** (except Phase 5 items, which change behavior deliberately).

---

## 0. Executive summary

1. **`src/core/typeGuards.ts` is dead code — zero importers repo-wide** (tests included). The module the task card is named after is unused, while three other `asString`-family helpers and four `isRecord` implementations live scattered across the tree.
2. The dedup is not "delete copied helpers"; it is **re-assembling a drifted canonical vocabulary**: one guard/read layer (`typeGuards.ts` + a slim `v4/readers.ts` facade), one constants registry (`constants.ts`), one home per duplicated type.
3. Seven items are **semantic forks that need an owner decision** (§6) — merging them silently would change behavior (validation strictness, sentinel values, security hardening posture).

---

## 1. Inventory — modules that stay in the project

| Module | Verdict |
|---|---|
| `core/typeGuards.ts` | **Revive as canonical primitives home** (see §2) |
| `core/gatewayProtocol/v4/readers.ts` | Stays as **facade**: re-export primitives from typeGuards + keep protocol-domain readers (`readTailHistory` etc.) |
| `core/gatewayProtocol/v4/{adapter,messages,prompts,events,errors}.ts` | Stay; strip local duplicates (§3) |
| `core/gatewayProtocol/{model,registry,schema}.ts` | Stay; schema aliases model types (§5) |
| `core/gatewayChatService.ts` | Stays (2328 lines; split candidate — **out of scope**); adopts shared utils |
| `core/{accessInfo/**,configIO,tools,searchPath,cliLauncher,hardeningCommand,setupOptions,agentSessionItems,truncatedRows,operatorPrompts,gatewayConfig,gatewayRunText,agentPicker}` | Stay; adopt canonical helpers |
| `core/constants.ts` | **Becomes the real constants registry** (currently: 1 constant, 1 consumer) |
| `core/` new tiny modules | `core/async.ts` (`withTimeout`), `core/errors.ts` (`errorMessage`), `isImageMime` + image-extension list near attachment types |
| `webview/ChatViewProvider.ts` | Stays (2940 lines — split candidate, **out of scope**); local guards → canonical |
| `webview/{content,debugPanel}.ts` | `getNonce` exported from content.ts; debugPanel reuses it (fixes CSP drift) |
| `webview/content-js.ts` / `content-css.ts` | Stay as-is (injected assets); host↔injected `escapeHtml` is two layers, **do not merge** |
| `chat/{ChatService,acpxProjectConfig}.ts` | Stay; ChatService quartet → canonical; acpx reader handled with care (§6.4) |
| `vscode/commands/*` | Stay; shared UI helpers into `vscode/commands/shared.ts` (§4) |

---

## 2. The helper vocabulary today (the core problem)

| Implementation | Signature | Lives in | Used by |
|---|---|---|---|
| `asNonEmptyString` / `asString(v, fallback)` | `string \| null` / `string` | `typeGuards.ts` | **nobody** |
| `asString(v)` | `string \| undefined`, no fallback | `accessInfo/util.ts:10` | format, tools |
| `readString` / `readText` / `readTrimmedString` | `string \| null` | `v4/readers.ts` | all 5 v4 modules |
| `isNonEmptyString` (type guard) | `value is string` | `ChatViewProvider.ts:82` | 5 sites — predicate byte-identical to `asNonEmptyString` |

Four `isRecord` implementations: `v4/readers.ts` (canonical — excludes arrays; all 5 v4 modules import it), `accessInfo/util.ts:5` (**deliberately array-inclusive**, documented), `ChatService.ts:99` (private), `cliLauncher.ts:232` (private).

**Decision (proposed):** `core/typeGuards.ts` becomes the canonical primitive home — it sits in `core/`, outside the protocol, so webview/vscode layers may import it. Move the primitives out of `v4/readers.ts` (`isRecord`, `readRecord`, `readString`, `readText`, `readTrimmedString`, `readArray`, `readStrings`, `readFiniteNumber`, `readPositiveInteger`, `readNonNegativeInteger`, `readDelayMs`, `MAX_TIMER_DELAY_MS`), add `isOptionalString`, `isIndexInRange`, `asRecord` (record-or-undefined), `parseJsonRecord`. `v4/readers.ts` re-exports them — the 5 v4 import sites and tests keep working unchanged.
**Do NOT touch:** `accessInfo/util.ts isRecord` (array-inclusive by design) and its `asString(v)` signature (`string | undefined`, no fallback) — incompatible semantics, excluded from the merge.

---

## 3. Function dedup — clusters

### Cluster 1 — canonical readers (foundation, low risk)

| # | What | Evidence | Sites | Action |
|---|---|---|---|---|
| 1.1 | `readLimit` = pure alias of `readPositiveInteger ?? fallback`; one-off `clamp` | `v4/adapter.ts:91-97` | 6 + 2 | **Delete both**; inline `Math.min/max` |
| 1.2 | `readString(readRecord(x).y)` triplet; one line byte-identical twice | `adapter.ts:188,203,267,309`; `errors.ts:251`; `messages.ts:120` | 6 | `readNestedString(rec, key, subkey)` + `readStringOr(v, fallback)` in readers |
| 1.3 | "Ellipsis cap" `len > N ? slice(0,N)+'…' : text` | `errors.ts:254`, `prompts.ts:80-82`, `gatewayChatService.ts:1196`, `readers.ts describeJson` | 4 | `capText(value: string|null, max): string|null` |
| 1.4 | Session-run info: `activeRunIds`/`inFlightRun` lines identical in tail & delta readers | `v4/adapter.ts:180-206` | 2×3 | `readSessionRunInfo(fields)`; **tail-vs-delta difference stays local** (deliberate: tail allows non-array `messages`, delta requires array+cursor; `olderPageOffset` tail-only) |
| 1.5 | Alias-aggregators `firstCount` / `latestActivityMs` / `readLifetime` | `messages.ts:50-112`, `prompts.ts:134-138` | 3 (+4 internal) | Only the alias-array iterator `firstFinite(names[])` goes to readers; **aggregators stay** (different intents: first-non-negative / max-of-all / all-or-nothing) |
| 1.6 | ChatService quartet `asRecord` / `parseJsonRecord` / `tokenCount` / `isAgentMethod` | `ChatService.ts:64-114` | 9 | `asRecord`+`parseJsonRecord` → canonical; `isAgentMethod` stays (ACP vocabulary); `tokenCount` → §6.2 decision |
| 1.7 | ChatViewProvider guard quartet | `ChatViewProvider.ts:82-96` | 12 | → typeGuards (type-guard form for `isNonEmptyString`) |
| 1.8 | `parseJson` + `asRecord` | `cliLauncher.ts:221-236` | — | → shared `parseJsonRecord` |
| 1.9 | Flag coercions `x === true` | 14 sites across v4 + chatService | 14 | Optional `readBool` — **low priority, do not over-merge** |

### Cluster 2 — cross-module utilities (kill drift)

| # | What | Evidence | Sites | Action |
|---|---|---|---|---|
| 2.1 | `errorMessage(err)` + inline `err instanceof Error ? err.message : String(err)` | helper `gatewayChatService.ts:303-305`; inline `gatewayConfig.ts:237,251,460` | 4 | `core/errors.ts` |
| 2.2 | `withTimeout` (race + clearTimeout) | `gatewayChatService.ts:313-320`, `gatewayConfig.ts:399-403`, inline `gatewayChatService.ts:2047-2049`, `truncatedRows.ts:125-127` (own `withTimeout`) | 4 | One `withTimeout` in `core/async.ts`; **preserve reject-vs-resolve(null) variants** (settle-from-history resolves null on timeout) |
| 2.3 | `image/` MIME-prefix test | `v4/adapter.ts:151`, `gatewayChatService.ts:1573,1575` | 3 | `isImageMime()` — real image-vs-file drift risk (limit + error text + type) |
| 2.4 | Inline trim-readers | `gatewayConfig.ts:71,178,181,359` | 4 | → `readTrimmedString` |
| 2.5 | `realpath(x).catch(() => x)` | `ChatViewProvider.ts:819,1066,2816,2841` | 4 | `canonicalizePath()` |
| 2.6 | Bounded file-read pattern | `viewMessaging.readVerifiedBytes` (:413-474; hardened: O_NOFOLLOW + O_NONBLOCK + dev/ino + fd-link) vs `acpxProjectConfig.readBoundedRegularFile` (:131-148; **follows symlinks intentionally**) | 2 | Shared low-level read-to-cap loop with parameterized guards — **separate careful PR**; blind merge would weaken attachment hardening or break symlinked `.acpxrc.json` approval (§6.4) |
| 2.7 | Nonce generation | `content.ts:50-54` vs `debugPanel.ts:13-15` | 2 | Export `getNonce`; debugPanel CSP template lacks `img-src ${cspSource}` — fix the drift while there |
| 2.8 | accessInfo self-clone (`addLabels` closure) | `extract.ts:68-75` ≡ `:100-107`; record-iteration ×3 more | 5 | `addEntryLabels` / `addRecordLabels` in accessInfo |

### Cluster 3 — vscode commands (UI layer)

| # | What | Evidence | Sites | Action |
|---|---|---|---|---|
| 3.1 | "load config → resolve tool parent → error toast" preamble + write/refresh/notify tail | `hardening.ts:145-156` ≡ `:181-193` | 2 | `withToolEntry()` in `vscode/commands/shared.ts` |
| 3.2 | "Install CLI / More options" block | `setup.ts:106-123` ≡ `:181-198`; near-dup `hardening.ts:250-258` | 3 | `showInstallPrompt(msg, { withCancel })` |
| 3.3 | Legacy "More options" dispatch | `setup.ts:502-517` ≡ `:542-557` | 2 | `handleLegacyMoreOptions()` |
| 3.4 | "Ensure CLI available" (node check → missing prompt) | `setup.ts:84-120`, `setup.ts:288-307`, `hardening.ts:236-258` | 3 | `ensureCliAvailable(executable, opts)` — branches genuinely differ (trust check, settings action, texts): share the ~70%, keep branch tails |
| 3.5 | Clipboard + toast | `docs.ts:12`, `setup.ts:266,471,510,513,550,553` | 7 | `copyToClipboard(text, msg)` |
| 3.6 | `show(true) + sendText` | setup ×5, hardening ×2 | 7 | Optional `runInTerminal()` — low value |
| 3.7 | `getConfiguration('openclaw')` | 19 sites in 7 files | 19 | `openClawConfig()` accessor in `vscode/config.ts` (behavior-neutral) |
| 3.8 | `executable === 'openclaw' \|\| executable === 'openclaw.exe'` | `setup.ts:84,290`, `hardening.ts:239` | 3 | Shared predicate |

Already centralized — **do not touch:** terminal lazy-create (`terminals.ts`, 7 consumers), logging (single `shared.ts` output channel).

### JSON-path access note

`configIO.ts getValueAtPath` (:80-99) + `getParentAtPath` (:102-118, built on top) vs `tools.ts readEntryAtPath` (:96-104): the latter is a **deliberately lax one-step accessor** (no bounds/`in` checks; missing-key semantics matter to `computeToolToggle`). Keep `readEntryAtPath` as-is, optionally relocate beside the path-helper family; **do not** force-merge into `getValueAtPath`.

---

## 4. Constants dedup

`constants.ts` today holds exactly one constant (`OPENCLAW_DASHBOARD_URL`) with one consumer, while literals hardcode across the tree:

| Literal | Sites | Files | Note |
|---|---|---|---|
| Setting keys `openclaw.*` | ~30 | 8+ (`configIO`, `gatewayConfig`, `vscode/config`, `activate`, `chatServiceFactory`, `ChatViewProvider`, `statusbar`, `OverviewTreeProvider`) | Full registry into `constants.ts` |
| Command ids `openclaw.*` | ~36 | `activate.ts` (~20), `OverviewTreeProvider.ts` (~15), `statusbar.ts` | ⚠️ also declared in `package.json` contributes — **package.json is the source of truth**; constants mirror it |
| `MAX_TIMER_DELAY_MS = 2**31-1` | 2 | `v4/readers.ts:11` (exported) vs `operatorPrompts.ts:26` (local copy) | Exact duplicate; nearest-term fix |
| Message cap `300` | 2 | `v4/errors.ts:244` vs `gatewayChatService.ts:223` | Same meaning ("longest gateway message shown") |
| `10_000` ms history-read timeout | 2 | `gatewayChatService.ts:242` vs `truncatedRows.ts:22` | Same meaning |
| `5*60_000` max wait | 2 | `v4/errors.ts:139` vs `v4/events.ts:19` | Same value, **different intents** — keep both names |
| `'main'` session alias | 2 | `gatewayChatService.DEFAULT_SESSION_KEY` (exported) vs `agentSessionItems.DEFAULT_MAIN_KEY` (private) | One canonical export |
| `'withdrawn'` sentinel | **7** | `v4/prompts.ts:192,196`, `operatorPrompts.ts:115,142,155`, `gatewayChatService.ts:731`, `model.ts` | Bare literal in 4 modules → named const in `model.ts` |
| `'unknown'` sentinel | 4 | adapter/errors | → §6.1 |
| `'image/'` prefix | 3 | adapter + chatService ×2 | → `isImageMime()` |
| `CLIENT_VERSION '0.2.1'` | 2 | `gatewayChatService.ts:211` ↔ `package.json:5` | Manual mirror — drifts at next release; read from package.json or generate |
| `GRID_DIMENSIONS` enum | 4 | `content-js.ts:655`, `package.json` enum, `content.ts:22` (hardcoded `<option value="1x1">`), `ChatViewProvider.ts:1966` | One enum, four places; package.json is truth |
| Node-install command strings | 3×2 | **inside one file** `setupOptions.ts:80/97/113` vs `:132/135/137` | Nearest-term fix: single source |
| Docs URLs | 9 | `docs.ts:5-8` + `setup.ts:20-26` | |
| Context default `128000` | 2 | `ChatViewProvider.ts:621` vs `content-js.ts:977` | |
| Image extensions (10 items) | 2 | `ChatViewProvider.ts:788-791` vs `viewMessaging.ts:313-330` | Two lists, one job |

Coincidences — **do not merge:** `5000` ms in three different meanings (device-load timeout / pairing-retry delay / secret-call timeout); `2000` preview cap vs detail cap.

---

## 5. Type dedup

| Duplicate | Where | Action |
|---|---|---|
| `UsageInfo` ≡ `TokenUsage` | `ChatService.ts:77-82` vs `model.ts:124`; bridged in `gatewayChatService.usageEvent:335-337` | Unify on `TokenUsage` — cleanest case |
| `ApprovalDecision` ≡ `ApprovalDecisionValue` | `model.ts:182` vs `schema.ts:313` | schema type-aliases the model's |
| `{runId, sessionKey, seq}` triple | ≥3 places (schema `ChatEventBase`, `events.RunFields`, model event variants) | Own: `model.ts` |
| `SessionRow` / `SessionsListResult` | `schema.ts:280-291` — **zero importers** | Cross-ref comment ("parsed by `readSessionRow`") or delete |
| `DisplayMessage` / `DisplayContentBlock` | schema.ts — no non-test importers | Clarify intent (likely documentation-only) |
| wire/neutral pairs (`QuestionWire`/`QuestionItem`, `QuestionRecord`/`QuestionPrompt`) | schema vs model | Intentional — document the pairing |
| `StoredDeviceToken` guard lives away from its type | `gatewayConfig.ts:418-425` vs type in `deviceIdentity.ts` | Guard moves beside the type |
| Setup-option row type ×2 + narrowed variant | `setupOptions.ts:11` ≡ `:22`, narrow at `:68` | `InstallOption<T extends string>` generic |
| `HistoryMessage` (projection of `TranscriptMessage`) | `agentSessionItems.ts:71-74` | Keep as projection — not a dup |

---

## 6. Semantic forks — owner decisions required (do not merge silently)

1. **`'unknown'` vs `''` absent-string sentinel (4 vs 3 sites).** `serverVersion`/`role`/handshake & RPC `code` receive a real-looking `'unknown'`; other sites use `?? ''`. Blind unification changes what callers can distinguish. *Recommendation:* named `UNKNOWN` const + `readStringOr(v, UNKNOWN)` where the sentinel is intended; `?? ''` sites untouched.
2. **`tokenCount` (ChatService) vs `readPositiveInteger`:** `Number.isFinite` (fractions accepted) vs `Number.isSafeInteger`. Direction of unification decides what gets rejected.
3. **`isOfferedDecision` (prompt-scoped, dynamic list) vs `isDecision` (static `DEFAULT_DECISIONS`):** a gateway offering a custom decision passes one and fails the other. Keep both checks; make `DEFAULT_DECISIONS` the single shared constant.
4. **acpx reader follows symlinks intentionally** vs hardened attachment reader (O_NOFOLLOW/dev/ino/fd-link). Share the low-level read loop only; guards stay parameterized.
5. **Truncation vocabulary:** wire `TRUNCATION_MARKER '\n...(truncated)...'` (schema.ts:74, stripped in messages.ts:84-85) vs display `'\n\n…(shortened by the gateway)'` hardcoded in core (`agentSessionItems.ts:91,104`). Move the display string to the webview layer; the neutral flag becomes the single carrier.
6. **`accessInfo.util.isRecord` is array-inclusive by documented design** — do not unify the name/semantics away.
7. **`'PROTOCOL_MISMATCH'`** appears as a bare literal and an enum member in two modules — reconcile to one source.

## 6b. Refuted suspects (for the record — do not "fix")

- `toTranscriptMessages` (webview) vs `toTranscriptMessage` (v4) — different layers; the former delegates to `agentSessionItems.mapHistoryMessages`.
- `escapeHtml` host vs injected JS — two layers by construction.
- `ChatServiceBounds` — does not exist; bounds already live in `AttachmentLimits` / `PolicyDefaults`.
- Terminal access, logging — already centralized.

---

## 7. Execution plan (phased, gate after each phase)

| Phase | Scope | Risk |
|---|---|---|
| **PR-1 Foundation** | Revive `typeGuards.ts` (primitives moved from readers + new `isOptionalString`/`asRecord`/`parseJsonRecord`); readers.ts → facade; delete `readLimit`/`clamp`; ChatService & ChatViewProvider quartets → canonical; `cliLauncher.parseJson` → shared; `operatorPrompts` imports `MAX_TIMER_DELAY_MS`; `setupOptions` single source of node commands | Low |
| **PR-2 Utils & constants** | `core/errors.ts`, `core/async.ts` (with variants), `isImageMime` + image-ext list, `capText`, `canonicalizePath`, nonce export (+ debugPanel CSP fix), `constants.ts` registry (settings keys, command ids, sentinels, caps), `openClawConfig()` accessor | Low |
| **PR-3 Protocol & types** | `readNestedString`/`readStringOr`, `readSessionRunInfo` (tail/delta kept local), `firstFinite` (aggregators stay), type unification (TokenUsage, schema aliases, event triple), `StoredDeviceToken` guard relocation | Medium |
| **PR-4 vscode UI** | `showInstallPrompt`, `handleLegacyMoreOptions`, `ensureCliAvailable` (options!), `withToolEntry`, `copyToClipboard`, accessInfo label helpers | Low |
| **PR-5 Semantic forks** | One tiny PR implementing §6 decisions (each item its own commit) | Deliberate behavior change |

**Gates per phase:** full local suite (`pnpm run typecheck`, `pnpm run lint`, `pnpm exec jest` — 47 suites / 1370+ tests), then CI matrix (ubuntu/windows/macos) green before review; Copilot protocol per `docs/development-rules.md` (verify findings against HEAD, reply in every thread, resolve threads).

---

## Appendix — verification data

- jscpd: 66 exact clones, 1788 duplicated lines (4.26% of 138 files scanned); non-test clone pairs confirmed individually (accessInfo ×1, hardening ×1, setup ×2 self-clones) — all verified by reading.
- Helper census: all guard/read functions enumerated per file; name collisions cross-checked (`isRecord` ×4, `asString` ×3, `asRecord` ×2).
- Recon agents: protocol (all `gatewayProtocol/**` + `gatewayChatService.ts` read in full), webview/chat (`webview/**`, `chat/**`, `overview/**`), core/vscode (everything else). Three agents' claims cross-checked against each other and against direct source reads; no contradictions remained after verification of `MAX_TIMER_DELAY_MS`, `'withdrawn'`, `'main'` aliases, `CLIENT_VERSION`.
