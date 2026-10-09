# Development rules

Binding rules for this repository, cited by ID.

## How to read and cite this file

- **IDs are stable.** Rules are `R1`–`R70` and `S1`–`S6`. An ID is never renumbered or reused; a new rule takes the next free `R` number. Merged IDs resolve to the rule that absorbed them: `R18` and `R22` → `R38`, `S5` → `R6`.
- **Grouped by topic.** Position carries no meaning; cite the ID.
- **Strength.** **MUST**: breaking it is a defect. **SHOULD**: deviate only with the reason stated in the PR.
- **Scope.** *General* rules apply to any project; their examples, paths and Check lines are this repository's and are adapted when a rule is copied elsewhere. *claw-code* rules apply to this repository only.
- **Check** says how a rule is verified: the compiler, the linter, CI, a test, or review. Mechanical checks live in `scripts/check-rules.mjs`; the PR template (`.github/pull_request_template.md`) carries the review items. Where the code does not meet a rule yet, the gap is listed under [Known gaps](#known-gaps).

| Topic | Rules |
| --- | --- |
| [Concurrency and resource lifecycle](#concurrency-and-resource-lifecycle) | R1, R2, R3, R4, R11, S1, R16, R17, R28 |
| [Streaming and event mapping](#streaming-and-event-mapping) | S2, R14, R23, R38 |
| [Protocols and external contracts](#protocols-and-external-contracts) | R24, R33, R25, R26, R27, R15, R29, R32, R37, R39 |
| [Untrusted input, secrets and the webview](#untrusted-input-secrets-and-the-webview) | R5, R13, R10, R35, R36, R30, R31, S3, S4 |
| [Sanitisers and redaction](#sanitisers-and-redaction) | R61, R62, R63, R64, R65, R66 |
| [Filesystem and paths](#filesystem-and-paths) | R6, R46 |
| [Testing](#testing) | R7, R34, R49, R12, R44, R50, R51, R53, R54, R70 |
| [Cross-platform and CI](#cross-platform-and-ci) | R40, R41, R42, R43, R45, R69 |
| [Documentation, claims and registries](#documentation-claims-and-registries) | R47, R52, R48, R56, R57, R58, R59, R68 |
| [Process and review](#process-and-review) | R8, R9, R19, R20, R21, R60, S6, R55, R67 |
| [Review checklist](#review-checklist-recurring-bug-classes) | Recurring bug classes |
| [Known gaps](#known-gaps) | Where the code does not meet a rule yet |

## Concurrency and resource lifecycle

**R1. Resource ownership is designed before code.** *General, MUST.* Every mutable resource (socket, callback, buffer, run) has a single owner, an explicit lifecycle (register, retire, replace) and documented semantics. Several maps with different keys pointing at one resource are a future race.
*Check:* review; teardown changes re-read R1, R16, R17 and R23 together.

**R2. Every `await` is a state-transition boundary.** *General, MUST.* After each `await`, revalidate the preconditions: the entity is still active, the generation is unchanged, ownership is retained. Capture generation or epoch identifiers before the `await` and compare them after.
*Check:* review; interleaving tests (R7).

**R3. Monotonic epoch/generation for all async invalidation.** *General, MUST.* Bump before destructive operations (abort, close); check before applying results. Terminal events (done, close) are idempotent.
*Check:* review; interleaving tests (R7).

**R4. A Promise is never checked as a boolean.** *General, MUST.* Async validation happens only through `await`; an unawaited Promise is always truthy.
*Check:* `pnpm run lint` (type-aware oxlint; `no-floating-promises` and `no-misused-promises` are errors).

**R11. Background process infrastructure.** *General, MUST.* Interval ≥ the maximum run duration (no overlaps); durable progress markers; single-flight.
*Check:* review.

**S1. Session/thread ownership model.** *claw-code, MUST.* Run sink vs transcript sink vs persistent callback; the callback key is the thread id (threads share sessions). Abort, clear and reset only when `status==='running'` with local ownership (`hasOwnedRun`); never abort behind idle subscribers.
*Check:* `ChatViewProvider` session tests.

**R16. Suspend ≠ dispose: transport lifecycle invariants.** *claw-code, MUST.* Stopping a transport (fallback, switch) closes the socket and reconnect loop and retires run sinks with `done`, but preserves persistent transcript/resume sinks and keeps them re-subscribable. Pre-ack buffers are purged together with their keys. A retired send resets the thread's streaming status synchronously (`emitState`), or the UI stays in "running".
*Check:* transport switch tests.

**R17. Aborts swallow late events entirely.** *claw-code, MUST.* Late `chat`/`session.message` frames for an aborted run are skipped like other late events; the terminal flow delivers `done` from the run's own terminal `chat` frame (`state: final`/`aborted`/`error` in protocol v4).
*Check:* abort interleaving tests.

**R28. Runs are correlated by the runId from the ack, not by shared mutable state.** *claw-code, MUST.* Seq-dedupe/replace of events; a retried send whose ack was lost reuses the same idempotency key; only an explicit `ok:false` is a rejection; `chat.abort` goes only over the connection that started the run; a non-stoppable run keeps streaming with a notification; the canonical session key is learned from hello-ok/subscribe; catch-up by cursor with reset.
*Check:* `gatewayChatService` tests.

## Streaming and event mapping

**S2. Streaming invariants.** *claw-code, MUST.* Frames may omit `messageId`; handle delta, text and mixed frames (cumulative or divergent); dedupe complete frames claim-before-dispatch; the seen-set holds only complete assistant rows; catch-up is gated on cursor, with `allowUnscopedCatchUp` only for no-history paths; pre-ack buffers are provisionally associated with every in-flight send, because ownership is unknown until settlement (R23); `chat.send` only after the subscription ack; `done` is idempotent.
*Check:* streaming tests with duplicate, mixed and keyless frames.

**R14. Rendered history without a cursor is an early boundary, not a skip.** *claw-code, MUST.* If catch-up is gated on a cursor and history was rendered without one, do not skip catch-up: the seeded rows form a boundary, replay is delivered after it, and the seeded tail is deduped with ordered fingerprints (keyless rows are not covered by the `messageId` seen-set).
*Check:* catch-up tests.

**R23. Pre-ack frames for foreign keys are buffered with wide attribution.** *claw-code, MUST.* A key frame (a `session.message` row, or a terminal `chat` frame with `state: final`/`aborted`/`error`) whose key has no sink yet, while a pre-ack send is in flight, is buffered and attributed to all in-flight sends: remap yields the resolved key, and the `preAck` set stores the requested one. Drain correlates on settled requested→resolved and drops ambiguous frames. Finalising on such a key early is a no-op that loses the terminal event and leaves the thread streaming forever after the ack.
*Check:* pre-ack tests.

**R38. Event mapping preserves identity and metadata end to end; empty is missing; a delta never shadows a final row.** *claw-code, MUST.* A tool-call or assistant row carries `id` and `arguments`/`result`/`details` through every lifecycle update. At every protocol boundary an empty `messageId`, `delta` or `role` is treated as missing (`asNonEmptyString`); empty keys corrupt dedupe and seen-sets. On any recovery or dedupe path keyed by id, a row with a non-empty `delta` (partial text) yields to a final row with the same id, or the recovered transcript is truncated to the delta.
*Check:* protocol event tests.

## Protocols and external contracts

**R24. Never invent protocols, wire formats, APIs, CLI semantics or library behaviour.** *General, MUST.* External contracts (gateway protocol, JSON-RPC, handshakes, third-party tools and libraries) are written only from documentation or actual source code. If neither is at hand, ask the owner for docs, sources or a link; probe empirically only after an explicit "none exists". A contract written from assumption is rejected by the real peer and has to be rewritten whole.
*Check:* review — every external call names its source document or file.

**R33. Verification against the real environment beats internal models.** *General, MUST.* A review or fix made against an imagined contract has no value. Before approving correctness, verify against the live peer or its real schemas (R24).
*Check:* R25.

**R25. Wire frames are tested against the product's real schemas.** *claw-code, MUST.* Every outgoing frame is validated against JSON Schema exported from the real gateway's TypeBox schemas (fixtures, regenerable with `scripts/sync-openclaw-protocol.mjs`) and against frames captured from a live gateway; the implementation is verified end to end against a real instance on loopback.
*Check:* the `gatewayProtocolV4*` suites validate frames against the exported schemas and captured frames. Until the integration smoke test exists (ENG-10 in the [roadmap](roadmap.md)), a protocol change is verified by hand against a gateway on loopback before merge, and the PR says so.

**R26. Protocol versioning goes through an adapter and negotiation.** *claw-code, MUST.* A version-neutral model, `GatewayProtocolAdapter`, and a v4 adapter; registration negotiates the version from a setting (`openclaw.gateway.protocolVersion: auto | 4`); an unsupported version is a clear permanent error; the negotiated version shows in the status badge and logs.
*Check:* `gatewayProtocolV4.test.ts` (version negotiation).

**R27. The handshake uses the server's closed enums.** *claw-code, MUST.* Client id and mode come only from the gateway's permitted values (for example `gateway-client/backend`). Failures are classified by `error.details.code` exactly as the server sends it (`AUTH_*`, `DEVICE_AUTH_*`, `PAIRING_REQUIRED`, `PROTOCOL_MISMATCH`). Credential and protocol failures stop reconnecting with a clear message; rate limiting and unavailability back off, respecting `retryAfterMs`. `hello-ok.policy` is parsed and clamps client limits.
*Check:* `gatewayProtocolV4.errors.test.ts`.

**R15. Foreign configuration is parsed by the product's specification, not by guesswork.** *General, MUST.* Discovery or migration of another product's config follows its actual semantics. Example: chained language-override keys (`[ts][js]`) are indexed under each identifier, as VS Code's `overrideIdentifiersFromKey` does; a guard that guesses misses valid data.
*Check:* `gatewayConfig.test.ts` (language-override migration).

**R29. Third-party CLI agents are described by their real behaviour.** *claw-code, MUST.* For acpx: the output is ACP JSON-RPC from `--format json`; the prompt goes on stdin through `exec --file -` as one explicit ACP text block (a leading `[` is parsed as content blocks); exit 5 after a response means a denied permission, a normal completion with a notice; JSON-RPC ids are attributed by direction (an agent-side error is not a failed prompt); images are ACP image blocks, not temp files. This holds for the acpx releases from `ACPX_TESTED_FROM` up to, but not including, `ACPX_UNTESTED_FROM` (`src/chat/acpxVersion.ts`), and any other version gets a warning. Raising that range first re-reads the new release's source for these behaviours and for what it writes to stderr (R24).
*Check:* the `ChatService*.test.ts` suites; `acpxVersion.test.ts` for the tested range; review when the range is raised.

**R32. Limits are measured in the form the transport actually reads.** *General, MUST.* A payload budget is computed over the encoded form (for a JSON transport, the escaped payload, not the raw text). Per-item and per-frame limits come from the peer's declared policy (`hello-ok.policy`), not invented constants. A Windows argv budget uses worst-case quoting, and counts a NUL as the one-byte substitute it is replaced with.
*Check:* `ChatServiceBounds.test.ts` (encoded prompt budget). The prompt reaches acpx on stdin, so the argv clause is a review item for any change that passes a payload on a command line.

**R37. Foreign-payload mapping is alias-tolerant, complete and numerically validated.** *General, MUST.* One canonical mapper per direction, never a duplicate. Each semantic alias group is read completely: `input`, `inputTokens`, `promptTokens`, `input_tokens`, `prompt_tokens` for prompt tokens; `output`, `outputTokens`, `completionTokens`, `output_tokens`, `completion_tokens` for completion tokens; `totalTokens`, `total`, `total_tokens` for the total. Complementary counters are never aliases of each other. Numbers are validated per R13.
*Check:* review; the usage alias tests in `gatewayProtocolV4.messages.test.ts` (`readUsage`).

**R39. Structural validators distinguish absent from malformed where the difference carries security or data.** *General, MUST.* An array where a record is expected, `null` where a field is optional, and a truncated object are distinct failures. Render paths may normalise malformed payloads to safe defaults (`readRecord` → `EMPTY_RECORD`, readers → `null`) and drop the row. Where a security or data-integrity decision is made (path segments, secrets, sinks), the validator branches on the distinction instead of one bucket that either drops valid data or accepts garbage.
*Check:* review.

## Untrusted input, secrets and the webview

**R5. Untrusted input is validated at every trust boundary.** *General, MUST.* Semantically, not just by shape, and again after each `await` when the data is externally controllable.
*Check:* review; validation tests at each boundary (`gatewayProtocolV4*`, `viewMessagingHandlers.test.ts`).

**R13. `Number(x) || fallback` is not validation.** *General, MUST.* A valid `0` selects the fallback, while truthy invalid values such as `Infinity` and negative numbers pass unchecked. Validate numbers from untrusted input with a `Number.isFinite(v) && v >= 0`-style helper — here `readNonNegativeInteger` / `readPositiveInteger` in `src/core/typeGuards.ts` — never with `||`.
*Check:* review.

**R10. Log hygiene.** *General, MUST.* Never log secrets, prompts or file contents; log only counters, keys and ids.
*Check:* `pnpm run check:rules` flags any logger call (`log`, `logger`, `this.logger`, `console`, …) with a prompt- or payload-named value (`text`, `prompt`, `body`, …) or `JSON.stringify` in an argument. It judges by name, not type, so review still applies.

**R35. Credentials are redacted on every egress surface, not only in logs.** *General, MUST.* UI labels, tree descriptions, reports, error messages and prompt wrappers pass a sanitiser (URL forms: userinfo and `?key=***`; plaintext: `key=…`, `OPENAI_API_KEY=…`, `"token":"…"`, `Bearer …`). A child process's `stderr` is sanitised too. Never echo the raw value of a workspace setting in an error. A fallback never restores the raw source when the sanitised value comes out empty: `sanitise(x) || x` re-exposes exactly what was removed, so fall back to a fixed placeholder. R10 covers logs; this is the separate, equally mandatory surface.
*Check:* review.

**R36. Workspace-configurable values are untrusted command and URL input.** *General, MUST.* Never interpolate a workspace setting into a shell; use only `execFile` with an argv vector and a quote-aware parser. An action that executes or connects in a workspace context is gated on workspace trust, and a setting that can choose such an action is user-scoped, so a workspace can neither supply nor disable it. A URL taken from settings is scheme-validated against an allow-list before it is opened. Do not conflate user-scope secret protection (R31) with workspace-trust gating. *In claw-code:* `autoConnect` and the hardening command are gated on `workspace.isTrusted` and are application-scoped; `openDashboard` is not trust-gated, because its http/https allow-list before `openExternal` is that path's entire protection.
*Check:* `pnpm run check:rules` flags `exec`/`execSync` from `child_process` under any binding, and a `shell` option other than `false`, `null` or `undefined` on spawn options; trust gating and URL validation need review.

**R30. External commands run only from absolute paths.** *General, MUST.* PATH entries that are not absolute (relative, repository-planted) are ignored, against a planted `node.exe` or `cli.js`. npm/pnpm shims on Windows resolve to the JS entry and run through node without a shell. Children never receive an empty PATH. PATH is read case-sensitively on POSIX.
*Check:* review; `searchPath` and `cliLauncher` tests.

**R31. Sensitive settings are user-scope only.** *claw-code, MUST.* A legacy token is never accepted from workspace settings; devices are identified per host through device identity (pairing); secrets live in credential storage; a workspace `.acpxrc.json` (which can override the agent command) runs only after explicit approval of that exact file (per folder and content hash).
*Check:* `gatewayConfig.test.ts` and `acpxProjectConfig.test.ts`.

**S3. Config and SecretStorage.** *claw-code, MUST.* The token lives only in SecretStorage. Migration iterates all targets (user/workspace/folder × normal/language × Code/Code-OSS/VSCodium/Insiders, plus nested `.code-workspace`), updates per folder in multi-root, and takes the scope from `@types/vscode` — `{languageId, uri?}` (there is no `folderUri`). The migration result is tri-state; an incomplete one is retried, and a failure is never cached. Deprecated settings stay registered in `package.json`.
*Check:* `gatewayConfig.test.ts`.

**S4. Webview.** *claw-code, MUST.* Data reaches the DOM through `createElement`/`textContent`, or as markup built from strings in which every data value passes `escapeHtml`/`escapeAttr`. The one path that inserts data as HTML is a reply's `html`, which only `renderMarkdown` produces (`viewMessaging.ts`: `markdownToHTML` with `sanitize: true` and unsafe links neutralised, or the escaped text if that fails); the webview strips unsafe links again before linkifying. A new path that sets `innerHTML` from data goes through the same sanitiser or is a defect. Interactive rows are buttons (a11y); session keys from the webview are validated against the `sessions.list` allowlist (awaited); `emitState` follows every `await` that changes rendering.
*Check:* `viewMessagingHandlers.test.ts` (`renderMarkdown` neutralises unsafe links), `contentJs.test.ts` (non-web link targets stripped from reply HTML) and `ChatViewProvider.sessions.test.ts` (session-key allowlist); review greps the diff for `innerHTML`.

## Sanitisers and redaction

These rules apply R35 to how a sanitiser is built. A sanitiser that guesses boundaries and spellings, instead of following the producer's grammar, leaks one more input form each time it is patched.

**R61. A sanitiser ends a secret only where the producer's grammar guarantees it ends.** *General, MUST.* Once a credential marker is seen (a sensitive key, `user:pass@`, `Bearer`), mask to a terminator the format guarantees: the matching unescaped closing quote or bracket, otherwise the end of the input. Never end a secret at a heuristic boundary (the first space, `/`, `@`, newline or a length cap): `password=correct horse battery staple` must not become `password=*** horse battery staple`. Where the end is ambiguous, mask to the end or withhold the text. Structured forms are parsed with the real parser (`new URL()`), not re-derived with regexes, and a form the parser rejects is masked whole. Sensitive names are one closed list in one constant, matched as whole tokens; a missing name is added there, never at a call site.
*Check:* review; each marker's unterminated-value case belongs in `describe('redactText')` in `accessInfo.test.ts`.

**R62. Canonicalise once, then match.** *General, MUST.* Before any matcher runs, bring the text to one spelling in a single step: strip terminal control sequences (CSI, OSC, DCS, C1), decode the escapes the sources can emit (JSON `\"`, `\uXXXX`, `\/`), and drop characters the target parser ignores (tab, CR, LF inside a URL). Decoding never creates structure: percent-encoding is decoded per component after the URL is parsed with its escapes intact, because decoding first turns `?token=prefix%26mode%3DPRIVATE` into a second parameter that token redaction leaves visible. The matchers then see one form; never add a matcher per escape spelling or nesting depth.
*Check:* review; the encoded variants of each marker belong in one table in `describe('redactText')`.

**R63. Redact the complete value, and redact last.** *General, MUST.* A sanitiser runs on the complete raw value, and again on the final assembled string: after every join of separately sanitised parts (a message and its details, a name and its URL), because a credential can be split across them, and before every step that loses context — truncation, windowing, flattening control characters, `JSON.stringify`, URL serialisation. A label-aware pass runs before known secrets are masked, so masking one value cannot erase another credential's label. Input too large to sanitise whole is withheld, never cut and then sanitised.
*Check:* `ChatServiceBounds.test.ts` (`STDERR_WITHHELD`); in `accessInfo.test.ts`, `redacts a named-entry label as assembled, a credential split across name and endpoint included` and `judges a credential split across name and endpoint on the raw name, quoted forms included`.

**R64. Code that scans untrusted input runs in linear time with bounded state.** *General, MUST.* A regex or scanner over CLI output, an error message or a payload never rescans a run from each position (nested quantifiers, a lookahead per character, a retry per `?`). Its test feeds a large adversarial input and bounds the work; above the size limit the text is withheld rather than scanned.
*Check:* `stays linear on large adversarial input` in `accessInfo.test.ts`; review.

**R65. Every sanitiser fix ships a look-alike test that must pass through unchanged.** *General, SHOULD.* A fix tested only against the leak it closes tends to mask benign text next: `http://127.0.0.1:18789` read as `user:pass`, `host:8443` as a key. Each fix adds a credential-free look-alike (`host:port`, an `@` in a query, an independent detail string) and asserts it is not masked.
*Check:* the look-alike cases in `accessInfo.test.ts` (`8443`, `127.0.0.1:18789`); review.

**R66. Describing an unknown thrown value takes nothing from it.** *General, MUST.* A helper that turns a caught value into text returns an `Error`'s `message` or a thrown string, and for anything else only its type (`Non-Error value (object)`), with no field values, key names, `String()` or custom `toString`: all of them are untrusted, unbounded, and logged by callers the helper cannot see. Its result still goes through the sanitiser before any egress (R35). Making such a helper "more helpful" changes every caller at once, so the change is reviewed against all of them.
*Check:* `errors.test.ts`.

## Filesystem and paths

**R6. Filesystem checklist.** *General, MUST.* In order:

1. `realpath` at ingestion, then a containment check against the canonical root.
2. Open without following the final component: on POSIX `O_NOFOLLOW` (plus `O_NONBLOCK` for potentially special files); on Windows, where Node exposes neither, a handle opened with `FILE_FLAG_OPEN_REPARSE_POINT` through a native helper, refused if it is a reparse point.
3. `fstat`-vs-`lstat` identity (dev/ino) and `isFile()`; on Windows, the handle's own attributes (not a directory or reparse point, a disk file).
4. Verify the opened handle's own path through the OS against the canonical root: the fd link on Linux, `F_GETPATH` on macOS, `GetFinalPathNameByHandle` on Windows.
5. Revalidate after every `await`.

A platform that cannot provide the no-follow open or the handle-path check fails closed; a plain open plus the other checks is not a fallback. Identity checks alone do not prove containment: an ancestor swapped before both the open and the `lstat` satisfies them (P3 in [the diff design](design/diff-and-checkpoints.md#path-resolution-and-containment)). Containment is checked on resolve and on read, and every entry point uses the same guards (slash commands as well as `handleSend`). Check-then-use is a race by default; residual windows are documented, naming the responsible component. The attachment reader (`readVerifiedBytes` in `viewMessaging.ts`, with the native calls in `src/core/handlePath.ts`) implements this list; reuse it rather than writing another.
*Check:* review; `describe('readAttachments handle-path check')` and `describe('readAttachments handle-path check on this OS')` in `viewMessaging.test.ts` (the latter reads through a real ancestor link on each CI OS); `handlePath.test.ts`.

**R46. A platform-specific OS facility is a first-class code path, with an honest residual limit.** *General, MUST.* Prefer the system call to a tool that prints its answer (here `F_GETPATH` and `GetFinalPathNameByHandleW` through koffi in `src/core/handlePath.ts`, not parsed `lsof` output). Where a tool is unavoidable, invoke it like any external command (R30): by absolute path, never a PATH lookup, with a short timeout and a retry back-off so a stalled tool costs one timeout, not one per use, and with its output decoded exactly before comparison. A native helper that cannot load, or a facility that cannot give a full answer, is a containment gap, not an allowed mechanism: the check fails closed (R6), and what it still cannot prove is documented.
*Check:* `handlePath.test.ts` (`without koffi`); review.

## Testing

**R7. Tests exercise interleavings, not just the happy path.** *General, MUST.* Send during abort, rebind during send, reconnect during a run, duplicate frames. Every fixed race gets a regression test that fails without the fix. A test that codifies wrong behaviour is a bug; when semantics change, re-read the test contracts.
*Check:* review.

**R34. Every block of code gets unit tests.** *General, MUST.* Logic, branches, guards, parsers and error handlers are tested: all condition branches, error paths and edge cases (empty, zero, NaN, missing values), interleavings and races, destructive lifecycle transitions (register, retire, replace), limit and budget boundaries. New code without tests is unfinished, and every fix ships a regression test that fails without the fix. Integration and end-to-end tests complement unit tests; they do not replace them.
*Check:* coverage thresholds in `vitest.config.ts` (never below 90% on any metric), enforced on CI's Linux leg (`pnpm run test:coverage` locally); per-change coverage is a review item.

**R49. A refactor that changes behaviour needs a test that fails without the change.** *General, MUST.* A green suite can hide a semantic change: the change compiles, the old tests pass, and nothing exercises the edge. When a commit message says a caller "now observes" something different, that sentence is a test obligation: cover the boundary explicitly — a rejected value, and what the caller sees instead. This matters most for extractions, where the code looks unchanged because lines only moved between files.
*Check:* review.

**R12. Platform-dependent test setup runs only where its test runs.** *General, MUST.* A static skip (`it.skip`, as `posixOnly` uses) runs none of the test's hooks. Setup still runs, and fails on the excluded platform, in two cases: a `beforeEach`/`beforeAll` shared by a `describe` that also holds tests enabled there, and a runtime skip (`ctx.skip()` or an early return), which happens after the hooks have run. Put platform-only fixtures (`mkfifo` and the like) in a `describe` whose tests are all skipped together, or guard setup and teardown with the same `process.platform` condition as the test.
*Check:* the Windows CI leg, where setup that runs before a skip fails.

**R44. Platform pinning covers OS-independent branches; OS-specific fixtures stay skipped.** *General, SHOULD.* (a) A branch whose setup runs anywhere but whose logic asserts one OS (POSIX process-group signals, a `/proc` or `/dev/fd` path the spec stubs itself) pins `process.platform` for the enclosing `describe` with a save/restore hook (`helpers/platform.usePlatform`), so it runs on every runner. (b) A test whose fixture or read path genuinely needs that OS's filesystem is skipped wherever the facility is missing, with its setup guarded per R12. The guard names the platforms the facility actually exists on: `mkfifo` is skipped on Windows only (`posixOnly`); a real `/proc/self/fd` link is skipped everywhere but Linux. Classify each case by whether its OS-specificity is real or only asserted.
*Check:* review; the CI matrix (R40) runs every pinned branch on all three OSes.

**R50. A module mock's factory returns every export the code under test reaches, transitively.** *General, MUST.* Vitest throws at access to a missing mocked export (`No "x" export is defined on the "y" mock`), but only when something reads that name, and the names read are whatever the module's own internals reach, not just what the test names. Check the factory against the transitive reach of the code under test. The cheap safe form returns the whole export surface and asserts it (`satisfies typeof import('…')`); a partial mock still covers everything reachable, including `require` and dynamic-import edges. A mock that intercepts a name nothing reaches reads as isolation that is not there.
*Check:* Vitest fails at access to a missing mocked export; review checks each factory against the transitive imports.

**R51. A deprecated alias is not a removal.** *General, MUST.* Keeping an old name alive next to the canonical one means two spellings of one concept, and a tool swap turns the spare one into a type error at every use site. When canonicalising a name, migrate every call site in the same pass and delete the alias; a `@deprecated` tag does not make a duplicate definition safe.
*Check:* typecheck after the rename; review greps for the old name.

**R53. `await` binds to the member access, not to the call.** *General, MUST.* `await resolveOnWindows(...).args` awaits a property of a promise, which is `undefined`; the assertion fails with a plausible-looking diff and no error at the call. When a call becomes async, every `.field` on its result needs parens: `(await resolveOnWindows(...)).args`.
*Check:* review — grep the diff for `await <call>(…).<prop>`.

**R54. A test hook's return value is an instruction.** *General, MUST.* Vitest runs a function returned from a hook as teardown, so `beforeEach(() => spy.mockReset().mockResolvedValue(…))` calls the mock once more after every test, and the damage reads as an unrelated or flaky failure elsewhere. Write hooks that do work with braces, so they return nothing; where the value is wanted, assign it to a named local. Audit the whole suite for expression-bodied hooks, not only the one that failed: one that returns a non-function (`beforeEach(() => vi.useFakeTimers())`) is harmless by accident, not by design.
*Check:* `pnpm run check:rules` flags expression-bodied hooks.

**R70. A test of a shipped dependency loads the copy the package ships.** *General, MUST.* When the build copies or externalises a dependency instead of bundling it (a native module, a WASM file, a runtime asset), a test that imports it from the workspace's `node_modules` proves the library works, not the package: a wrong external path or a file missing from the copy keeps CI green while every installed copy fails. Build the artifact, resolve the dependency from the bundle's location by the specifier the bundle uses, check that it came from the copy, and call into it on each OS that loads it.
*Check:* `bundle.test.ts`: `imports koffi only from the copy beside the bundle`, `copies koffi with the macOS and Windows binaries the packaged extension loads`, and `loads the copied koffi, with its binary from the copy, and calls into the OS` on the macOS and Windows legs.

## Cross-platform and CI

**R40. A platform matrix is one job, not N copied jobs.** *General, MUST.* Run one `strategy.matrix` job over `[ubuntu-latest, windows-latest, macos-latest]` with `fail-fast: false`; copied per-OS jobs drift. OS-independent work (typecheck, lint, licence check) runs once on the cheap runner (`if: runner.os == 'Linux'`); only the OS-sensitive steps (build, test) run on every runner. `workflow_dispatch` lets a maintainer re-run without an empty push.
*Check:* `.github/workflows/ci.yml`.

**R41. A required check behind a matrix is an aggregate job.** *General, MUST.* A ruleset that requires a fixed check name (here `ci`) cannot be satisfied by matrix checks (`test (ubuntu-latest)` and so on). Add a small aggregate job named exactly `ci` with `needs: test` and `if: always()`, which fails unless every OS passed.
*Check:* `.github/workflows/ci.yml`.

**R42. Concurrency cancellation spares the default-branch run.** *General, MUST.* `cancel-in-progress: true` with a group keyed only on `github.ref` cancels a queued `main` run when a newer commit lands, so a main commit can land without a status. Key the group so a newer PR push supersedes the PR run while every other run gets a unique group: `group: ci-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}`.
*Check:* `.github/workflows/ci.yml`.

**R43. Tests own no absolute temp path.** *General, MUST.* Never `mkdtempSync('/tmp/...')`: `/tmp` does not exist on Windows, and on macOS `os.tmpdir()` is reached through a `/var → /private/var` symlink that a realpath-sensitive reader rejects. Use the helper that returns the canonical root, `fs.realpathSync.native(os.tmpdir())` (`src/__test__/helpers/tempDir.ts`), and build every path with `path.join`/`path.resolve`, never string concatenation. A fixture byte-compared across checkouts needs `.gitattributes: * text=auto eol=lf`, or Windows git rewrites it to CRLF.
*Check:* `pnpm run check:rules` flags `os.tmpdir()` outside the helper and `/tmp` in `mkdtemp`; the Windows and macOS CI legs.

**R45. Paths shown to a user use forward slashes on every OS.** *General, MUST.* A `relativePath` compared with a query typed as `src/app` is `path.relative(...).split(path.sep).join('/')`; otherwise it matches on POSIX and fails on Windows, which is a product bug, not just a test concern.
*Check:* the `handleFileSearch` tests in `viewMessagingHandlers.test.ts`, on the Windows CI leg.

**R69. A green CI leg proves only what it shows it ran.** *General, MUST.* A step that exits 0 with no output is not evidence that its tool ran. Before any step that depends on it, each leg checks that its toolchain runs: the tool prints its expected output (a non-empty version), or the step fails. When a leg is added or its toolchain setup changes, read one of its logs: the test count and step durations must match the other legs.
*Check:* the `Check pnpm runs` step in `.github/workflows/ci.yml`; review compares the legs' durations when the workflow changes.

## Documentation, claims and registries

**R47. A comment describing a contract is a claim, and is verified like one.** *General, MUST.* A doc comment or README sentence that states a guarantee is part of the deliverable. Every claim of identity, fail-closed behaviour, completeness or equivalence is checked by reading the branch it describes, and its residual limit is stated in the same sentence. One comment covers two call sites only if their branches agree: "returns the bytes" is a claim about a cap, a read loop and a stat, and if any of the three differs, the comment must not merge them. A guarantee about a resource covers every path into it: name each entry point and failure branch, or narrow the claim to the paths it holds for, and to the cases that actually happened. A completeness claim over an open-ended surface (a language's syntax, a tool's configuration) is an enumerated list, never "any …" or "no … runs"; whatever lies outside the list is an open question.
*Check:* review — for each security or completeness claim, the reviewer lists its entry points and failure branches.

**R52. A shared reader's two entry points are two contracts.** *General, MUST.* One loop behind two wrappers (sync and async) produces wrappers whose guarantees differ, and the cheaper one is usually wrong: a sync wrapper that sizes one buffer from a prior `stat` reads short when the file grows below the cap, while the async loop reads that growth to EOF and reports the over-cap condition only when the file passes the cap. Doc comments and regression tests state the difference per entry point.
*Check:* regression tests per entry point (`readBounded.test.ts`).

**R48. A registry is a list of facts, checked in both directions.** *General, MUST.* A constants registry that replaces scattered literals is a second source of truth and rots the moment a registration moves. Repair it with a two-way diff: every entry is grepped to a real registration, and every registration is either in the registry or in a documented exclusion. Entries that belong to another registry are named in that registry's comment as an explicit scope statement. Here `COMMANDS` holds the ids `package.json` declares, `INTERNAL_COMMANDS` the ones the host registers without declaring.
*Check:* review.

**R56. A design document states invariants, not the history of its review.** *General, MUST.* Binding behaviour is written as numbered rules (MUST statements with an ID), followed by the mechanism and a list of open questions. Arguments about why an earlier version was wrong belong in the PR thread. When a review round reshapes the same paragraph again, rewrite it as invariants (R8). An invariant stays short — about 120 words, SHOULD — and a longer one is split into sub-IDs; a bullet that grows in two review rounds is split, not extended.
*Check:* review; the word count of any invariant a PR touches.

**R57. Each requirement is stated in exactly one place.** *General, MUST.* Other documents link to it. Applying a general rule to a specific design is not restating it, provided the design names the rule it applies and adds only what is specific to the design. Statuses follow the same rule: a roadmap item's status lives only in the roadmap's status table, and the CHANGELOG, `engineering.md` and PR descriptions cite the item's ID instead of restating it.
*Check:* review — grep the docs for the requirement's key phrase before adding it.

**R58. A status claim cites the code that backs it.** *General, MUST.* "Done", "implemented", "tested", "partial", "works today" and every file or line reference are checked against the current code before they are written, and the evidence (file, symbol or test) is named next to the claim. A plan describes the target and never presents planned behaviour — such as a future feature reusing existing code — as current. Evidence is itself a claim: every file, symbol, job and test named, including a rule's Check line, exists at HEAD and is the one that fails when the claim breaks. A claim copied from an older document or PR is re-verified, not inherited.
*Check:* review — the reviewer opens each cited file and test.

**R59. A security design states its threat model.** *General, MUST.* Before the mechanism, say which attackers are in scope: workspace or repository content, other local accounts, a process running as the same user, the network, a remote host. Each protection is judged against that list, and what it does not cover is stated.
*Check:* review.

**R68. Changing a project-wide fact updates every place that states it.** *General, MUST.* When a version, name, identifier or default changes, search the whole repository for the old value and its derived spellings (`0.2.1` and `0.2.x`; a full id and its prefix), and decide each hit: update it, or keep it because it names the old value on purpose (a fork point, a migration note). A code fallback that duplicates a manifest value gets a test that fails when they drift.
*Check:* review — the PR names the search it ran; `constants.test.ts` for the client version and the command setting defaults.

## Process and review

**R8. A "push → N findings" loop is a design symptom, not a code one.** *General, MUST.* If a review round finds problems in a fresh fix, rethink the design instead of patching. Adversarial self-review before pushing is cheaper than fix cycles. **Stop criterion:** when three consecutive review rounds produce findings in the same section (one function, one check, one invariant), stop patching it: change the mechanism, rewrite the section as invariants (R56), narrow the claimed scope, or move the remaining edge cases into an explicit "Open questions" list.
*Check:* the PR author counts rounds per section; the R60 disposition names any section that reached a third round and the redesign taken.

**R9. Small focused PRs.** *General, SHOULD.* A large PR means long review and churn. Ship a concurrency core or other risky mechanism as its own PR with its own design.
*Check:* review — a reviewer asks for a split when a PR mixes unrelated concerns.

**R19. Every review finding is a bug class, not a line.** *General, MUST.* After a finding, grep the diff, then the codebase, for the same class, and fix the similar spots in the same commit. After the PR, run a codebase-wide pass for the class, in the PR that immediately follows.
*Check:* the thread reply names the sibling spots checked or fixed (R60).

**R20. Rules are a living document.** *General, MUST.* Every technical PR, after its review cycle, adds or amends a declarative rule here: "always do Y", not "we fixed X". It goes under the right topic with the next free ID.
*Check:* review.

**R21. Repository and GitHub language is English.** *General, MUST.* Code comments, JSDoc, documents, PR titles and descriptions, threads, summary comments and review bodies are written in English. Internal chats and notes are out of scope. Existing non-English text is not rewritten for this rule alone.
*Check:* review.

**R60. Review protocol.** *General, MUST.* Verify every finding against HEAD; review snapshots are often stale. Reply in every thread, then resolve it: for a valid finding, what was done and the fixing commit; for an invalid one, the evidence (file, line, test or documentation) and no change. Read each review's summary as well as its inline threads: findings listed only in the summary have no thread of their own, so they are answered in one PR comment per review, finding by finding. A finding that needs a change outside the PR's scope is tracked (roadmap ID or issue), not dropped. A round that produces no commits ends the loop.
*Check:* zero unresolved threads, and a disposition comment for every review with summary-only findings.

**S6. Repository process.** *claw-code, MUST.* Explicit branch fetch (refspec hygiene, `git remote prune`); rebase onto the remote tip before pushing (verify with `ls-remote`); Conventional Commits; run the CI gates before every commit, in CI's order: `pnpm run typecheck`, `pnpm run lint`, `pnpm run check:rules`, `pnpm run compile`, `pnpm run test:coverage`, `pnpm run license:check`. `test:coverage` applies the coverage thresholds CI's Linux leg enforces; `pnpm run test` would repeat compile and lint through `pretest` and skip coverage. Diagnose hangs explicitly rather than force-terminating runs. Reviews follow R60.
*Check:* `.github/workflows/ci.yml` runs the same gates in the same order.

**R55. Removing a tool is complete only when nothing names it.** *General, MUST.* Search the whole repository for its name — config, scripts, workflows, docs, and `/// <reference types="…" />` directives, which keep a removed package's types alive and hide the removal from `tsc` — and change every invocation. Verify by running what CI runs, not what you just typed.
*Check:* review.

**R67. A mechanical rule check enforces a closed, allowed form, and flags what it cannot resolve.** *General, MUST.* A checker that hunts forbidden spellings meets an open set of syntax (aliases, re-exports, `.bind`, spreads, literal keys). Define instead the one form a rule allows — for example, `child_process` imported only by a listed set of modules, `os.tmpdir()` only in the temp-dir helper — and report anything the checker cannot resolve to that form. Identity is resolved through the compiler's symbols, never by name, so shadowing and constants are judged correctly. The checker's header states exactly what it enforces (R47).
*Check:* `checkRules.test.ts`; each allowed form gets a clean case and an unresolvable form a failing one.

## Review checklist: recurring bug classes

- Stale continuation after `await`: a generation not captured or not checked — R2, R3
- Duplicated delivery: live, catch-up and pre-ack buffer without attribution — S2, R23
- Over- or under-aggressive teardown: retire exactly the owner's own registration, never the whole session set — R1, R16, R17, R23
- Path traversal, symlink TOCTOU, special files, case comparisons — R6, R46
- Mixed delta and text frames: lost or duplicated text, a poisoned seen-set — S2, R38
- Token migration: scope semantics, multi-root, language overrides, distro paths — S3
- Async validation without `await` (allowlist bypass) — R4, S4
- A fix that introduces a new bug — R8, R19
- Secrets or prompts on a log or other egress surface — R10, R35
- A claim in a comment or doc that the code does not back — R47, R58, R68
- A security claim that misses an entry point or failure branch — R47
- Sanitiser boundaries guessed instead of parsed: URL grammar, value ends, escape layers — R61, R62
- Redaction after truncation or before a join; a raw fallback after empty sanitising — R63, R35
- Super-linear scanning of untrusted text — R64
- A sanitiser fix that over-redacts benign text — R65
- A rule checker that misses a syntactic form or flags safe code — R67
- A CI leg that passes without running its tools — R69
- A test that loads the workspace copy of a dependency the package ships separately — R70

## Known gaps

Where the code does not meet a rule yet. Fixing one removes its line.

- **R56:** C2a in the [diff design](design/diff-and-checkpoints.md) is about 420 words and is due to be split into sub-IDs.
- **R61:** in `redact.ts`, an unclosed quoted value still ends at a space; a URL that `new URL()` rejects has only its userinfo and sensitive query values masked (`redactUrl`), not the whole form; sensitive names are split across `SENSITIVE_PARAM`, `SENSITIVE_KEY` and `CREDENTIAL_HEADER_KEY` and matched as substrings, so `key` also matches `monkey`.
- **R62:** `redact.ts` matches escape layers case by case; the single encoded-variant table is the target.
- **R63:** `namedEntryLabel` in `format.ts` judges a split credential on the raw parts with `joinBoundary` and does not redact the assembled label.
- **R64:** `redactText` has no size limit; only the acpx stderr path withholds oversized text (`STDERR_WITHHELD`).
- **R66:** `errorMessage` still passes non-string primitives through `String()` (`uses String() for other values` expects `errorMessage(42)` to be `'42'`).
- **R67:** `scripts/check-rules.mjs` is still a symbol-resolving denylist for R10, R36 and R43.
