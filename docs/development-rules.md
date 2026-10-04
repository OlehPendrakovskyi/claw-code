# Development rules

Living document, last updated 2026-10-04. It started as the claw-code retrospective of 2026-09-27 (PR #8/#10, Sprints 1–2; PR #11 MVP: 28 Copilot rounds, ~90 findings, ~25 fix commits, a day of fixes). Every later section was added from a real review cycle.

## How to read and cite this file

- **IDs are stable.** `R1`–`R55` are the original numbered rules with their original numbers; `S1`–`S6` are the former "claw-code specifics" 1–6, renamed so they no longer collide with `R1`–`R6`. New rules continue from `R56`. An ID is never renumbered or reused. When rules merge, the absorbed ID keeps a one-line pointer entry. A reference such as "rule 50" in an older commit or code comment means `R50`.
- **Grouped by topic, not by date.** Position in the file carries no meaning; cite the ID.
- **Strength.** **MUST**: breaking it is a defect. **SHOULD**: deviate only with the reason stated in the PR.
- **Scope.** *General* rules apply to any project and are the portable part of this file; *claw-code* rules apply to this repository.
- **Check** says how a rule is verified: the compiler, the linter, CI, a test, or the review checklist at the end of this file.

| Topic | Rules |
| --- | --- |
| [Concurrency and resource lifecycle](#concurrency-and-resource-lifecycle) | R1, R2, R3, R4, R11, S1, R16, R17, R28 |
| [Streaming and event mapping](#streaming-and-event-mapping) | S2, R14, R23, R38 (absorbs R18, R22) |
| [Protocols and external contracts](#protocols-and-external-contracts) | R24, R33, R25, R26, R27, R15, R29, R32, R37, R39 |
| [Untrusted input, secrets and the webview](#untrusted-input-secrets-and-the-webview) | R5, R13, R10, R35, R36, R30, R31, S3, S4 |
| [Filesystem and paths](#filesystem-and-paths) | R6 (absorbs S5), R46 |
| [Testing](#testing) | R7, R34, R49, R12, R44, R50, R51, R53, R54 |
| [Cross-platform and CI](#cross-platform-and-ci) | R40, R41, R42, R43, R45 |
| [Documentation, claims and registries](#documentation-claims-and-registries) | R47, R52, R48, R56, R57, R58, R59 |
| [Process and review](#process-and-review) | R8, R9, R19, R20, R21, R60, S6, R55 |
| [Review checklist](#review-checklist-recurring-bug-classes) | Recurring bug classes |

## Concurrency and resource lifecycle

**R1. Resource ownership is designed before code.** *General, MUST.* For every mutable resource (socket, callback, buffer, run): a single owner, an explicit lifecycle (register/retire/replace), and documented semantics. Multiple maps with different keys pointing at one resource = future races.
*Check:* review checklist; teardown changes re-read R1, R16, R17 and R23 together.

**R2. Every `await` is a state-transition boundary.** *General, MUST.* After each await, revalidate the preconditions (entity still active, generation unchanged, ownership retained). Capture generation/epoch identifiers BEFORE the await and compare them AFTER.
*Check:* review checklist; interleaving tests (R7).

**R3. Monotonic epoch/generation for all async invalidation.** *General, MUST.* Bump BEFORE destructive operations (abort/close), check BEFORE applying results. Terminal events (done/close) are idempotent.
*Check:* review checklist; interleaving tests (R7).

**R4. A Promise is never checked as a boolean.** *General, MUST.* Async validation happens only via `await`. An unchecked Promise is always truthy.
*Check:* review checklist.

**R11. Background process infrastructure.** *General, MUST.* Interval ≥ maximum run duration (no overlaps); durable progress markers; single-flight.
*Check:* review checklist.

**S1. Session/thread ownership model.** *claw-code, MUST.* Run sink vs transcript sink vs persistent callback; the callback key is the thread id (threads share sessions). abort/clear/reset only when `status==='running'` with local ownership (`hasOwnedRun`); never abort behind idle subscribers.
*Check:* `ChatViewProvider` session tests.

**R16. Suspend ≠ dispose: transport lifecycle invariants.** *claw-code, MUST.* Stopping a transport (fallback/switch) must: close the socket and reconnect loop, retire run sinks with `done`, BUT preserve persistent transcript/resume sinks and make them re-subscribable; purge pre-ack buffers together with their keys; a retired send resets the thread's streaming status synchronously (`emitState`), otherwise the UI hangs in "running".
*Check:* transport switch tests.

**R17. Aborts swallow late events entirely.** *claw-code, MUST.* Late `chat`/`session.message` frames for an aborted run are skipped just like other late events; the terminal flow delivers `done` from the run's own terminal `chat` frame (`state: final`/`aborted`/`error` in protocol v4).
*Check:* abort interleaving tests.

**R28. Runs are correlated by the runId from the ack, not by shared mutable state.** *claw-code, MUST.* Seq-dedupe/replace of events; retrying a send whose ack was lost reuses the same idempotency key; only an explicit `ok:false` is a rejection; `chat.abort` is sent only over the connection that started the run; a non-stoppable run keeps streaming with a notification; the canonical session key is learned from hello-ok/subscribe; catch-up by cursor with reset.
*Check:* `gatewayChatService` tests.

## Streaming and event mapping

**S2. Streaming invariants.** *claw-code, MUST.* Frames may omit `messageId`; delta vs text vs mixed (cumulative/divergent); dedupe complete frames claim-before-dispatch; the seen-set holds only complete assistant rows; catch-up is gated on cursor + `allowUnscopedCatchUp` only for no-history paths; pre-ack buffers are provisionally associated with every in-flight send (ownership is unknown until settlement — see R23); `chat.send` only after subscription ack; `done` is idempotent.
*Check:* streaming tests with duplicate, mixed and keyless frames.

**R14. "Rendered" paths without a cursor are an early boundary, not a skip.** *claw-code, MUST.* If catch-up is gated on a cursor and history was rendered without one, do not skip catch-up entirely: seeded rows form a boundary, deliver replay after it, and dedupe the seeded tail with ordered fingerprints (keyless rows are not covered by the `messageId` seen-set).
*Check:* catch-up tests.

**R23. Pre-ack frames for foreign keys are buffered with wide attribution.** *claw-code, MUST.* A key frame (a `session.message` row, or a terminal `chat` frame with `state: final`/`aborted`/`error`) whose key has no sink yet, while a pre-ack send is in flight, is buffered attributed to all in-flight sends (the owner is unknown until settlement — remap yields the resolved key, and the `preAck` set stores requested); drain correlates on settled requested→resolved and drops ambiguous ones. Finalizing on such a key earlier is a no-op that loses the terminal event and leaves "eternal streaming" after the ack.
*Check:* pre-ack tests.

**R38. Event mapping preserves identity and metadata end-to-end; empty is missing; a delta never shadows a final row.** *claw-code, MUST.* A tool-call/assistant row carries `id` + `arguments`/`result`/`details` through every lifecycle update. At all protocol boundaries, empty `messageId`/`delta`/`role:''` are treated as missing (`asNonEmptyString`), otherwise empty keys corrupt dedupe/seen-sets (was R18). On any recovery/dedup path keyed by id, a row with a non-empty `delta` (partial text) is skipped in favour of a final row with the same id, otherwise the recovered transcript is truncated to the delta (was R22). (Latent in PR #1, ~6 findings in PR #11.)
*Check:* protocol event tests.

**R18. Empty string ≠ missing value.** Merged into R38.

**R22. Delta rows do not shadow final rows.** Merged into R38.

## Protocols and external contracts

**R24. Never invent protocols, wire formats, APIs, CLI semantics, or library behaviour.** *General, MUST — the most important rule in this file.* External contracts (gateway protocol, JSON-RPC, handshake, third-party tools) are written ONLY from documentation or actual source code. If none is at hand, ask the owner for docs, sources or a link. Only after an explicit "none exists" is empirical probing permitted. Applies to all development, not just claw-code. Precedent: the assumed OpenClaw gateway contract (`sessions.messages.subscribe {sessionKeys}`, `chat.send {text, queueMode}`, `session_end`, `deltaCursor`) was rejected by the real gateway, and the protocol had to be rewritten entirely.
*Check:* review checklist — every external call names its source document or file.

**R33. Fact-checking against the real environment beats internal models.** *General, MUST.* Reviews and fixes made against an imagined contract have no value. Verifying against the live gateway or the real schemas is mandatory before approving code correctness (see R24).
*Check:* R25.

**R25. Wire frames are tested against the product's real schemas.** *claw-code, MUST.* Every outgoing frame is validated against JSON Schema exported from the real gateway's TypeBox schemas (fixtures, regenerable via `scripts/sync-openclaw-protocol.mjs`), plus frames captured from a live gateway; the implementation is verified end-to-end against a real instance on loopback.
*Check:* the `gatewayProtocolV4*` test suites.

**R26. Protocol versioning goes through an adapter + negotiation.** *claw-code, MUST.* A version-neutral model, `GatewayProtocolAdapter`, a v4 adapter; registration negotiates the version from a setting (`openclaw.gateway.protocolVersion: auto | 4`); an unsupported version yields a clear permanent error; the negotiated version is visible in the status badge and logs.

**R27. Handshake uses the server's closed enums.** *claw-code, MUST.* Client id/mode only from the gateway's permitted values (for example `gateway-client/backend`); failures are classified by `error.details.code` exactly as the server sends them (`AUTH_*`, `DEVICE_AUTH_*`, `PAIRING_REQUIRED`, `PROTOCOL_MISMATCH`); credential/protocol failures stop reconnecting with a clear message, rate-limit/unavailability is backed off while respecting `retryAfterMs`; `hello-ok.policy` is parsed and clamps client limits.

**R15. Parse foreign configs per the product's specification, not guesswork.** *General, MUST.* Discovery/migration for chained language-override keys (`[ts][js]`) must rely on the product's actual semantics (VS Code `overrideIdentifiersFromKey` — indexing under each identifier), otherwise the guard misses valid data.

**R29. Third-party CLI agents are described by their real behaviour, not guesses.** *claw-code, MUST.* For acpx: the real output format (ACP JSON-RPC from `--format json`), stdin `exec --file -` (the prompt as one explicit ACP text block — a leading `[` is parsed as content blocks), exit 5 = denied permission after a response (a normal completion with a notice), JSON-RPC ids are attributed by direction (an agent-side error ≠ a failed prompt), images are ACP image blocks, not temp files.

**R32. Limits are measured in the form the transport actually reads.** *General, MUST.* The prompt budget is computed over the JSON-escaped payload (not raw text); per-file/per-image/frame limits come from the gateway's `hello-ok.policy`, not invented constants; the Windows argv budget uses worst-case quoting, NUL → one-byte substitute.

**R37. Foreign-payload mapping is alias-tolerant, complete, and numerically validated.** *General, MUST.* One canonical mapper per direction; do not duplicate it (mapping drift). Read each semantic alias group completely (`input`, `inputTokens`, `promptTokens`, `input_tokens`, `prompt_tokens` for prompt tokens; `output`, `outputTokens`, `completionTokens`, `output_tokens`, `completion_tokens` for completion tokens; `totalTokens`, `total`, `total_tokens` for total). Complementary counters are never aliases of each other. Numbers are validated per R13. (PR #1: snake_case + duplicate mapper; PR #11: usage; PR #12: NaN.)

**R39. Structural validators distinguish absent from malformed where the difference is security- or data-bearing.** *General, MUST.* An array arriving where a record is expected, `null` where a field is optional, and a truncated object are distinct failure modes. The canonical reader pattern in this codebase normalises malformed payloads to safe defaults (`readRecord` → `EMPTY_RECORD`, readers → `null`) and drops the row — the right default for render paths. Where a security or data-integrity decision is made (path segments, secrets, sinks), the validator branches on the distinction instead of lumping it into one bucket that either drops valid data or accepts garbage. (PR #1, #8.)

## Untrusted input, secrets and the webview

**R5. Untrusted input is validated at every trust boundary.** *General, MUST.* Semantically (not just shape), and re-validated after each await when the data is externally controllable.

**R13. `Number(x) || fallback` is not validation.** *General, MUST.* `NaN` is falsy, so `NaN || fallback` selects the fallback rather than letting `NaN` pass. The real failure modes are the opposite: a valid `0` also selects the fallback, while truthy invalid values such as `Infinity` and negative numbers pass unchecked. Validate numbers from untrusted input with a `Number.isFinite(v) && v >= 0`-style helper — in this codebase `readNonNegativeInteger` / `readPositiveInteger` in `src/core/typeGuards.ts` — never with `||`.
*Check:* review checklist.

**R10. Log hygiene.** *General, MUST.* Never log secrets, prompts or file contents; log only counters, keys and ids.
*Check:* review checklist. Known open violations are tracked as SEC-2 in the [roadmap](roadmap.md).

**R35. Credentials are redacted on every egress surface, not only in logs.** *General, MUST.* UI labels, tree descriptions, reports, error messages, and prompt wrappers pass a sanitiser (URL forms: userinfo and `?key=***`; plaintext: `key=…`, `OPENAI_API_KEY=…`, `"token":"…"`, `Bearer …`); a child process's `stderr` is sanitised too; never echo the raw value of a workspace setting back in an error. R10 covers logs only; this is the separate, equally mandatory surface. (Recurring class: 30 findings across PRs #1, #8, #11.)
*Check:* review checklist.

**R36. Workspace-configurable values are untrusted command/URL input.** *General, MUST.* Never interpolate a workspace setting into a shell; only `execFile` with an argv vector and a quote-aware parser. Configured actions that execute or connect in a workspace context (`autoConnect`, hardening command) are gated on `workspace.isTrusted`; both are application-scoped user settings, so a workspace can neither supply nor disable them. `openDashboard` is deliberately NOT trust-gated: it scheme-validates the URL (http/https allow-list) before `openExternal`, which is the entire protection for that path. Do not conflate user-scope secret protection (R31) with workspace-trust gating. (PR #1.)
*Check:* review checklist.

**R30. External commands run only from absolute paths.** *General, MUST.* PATH entries without an absolute path (relative, repo-planted) are ignored (protection against planted `node.exe`/`cli.js`); npm/pnpm shims on Windows resolve to the JS entry and run through node without a shell; children never receive an empty PATH; PATH is read case-sensitively on POSIX.
*Check:* review checklist; `searchPath` / `cliLauncher` tests.

**R31. Sensitive settings are user-scope only.** *claw-code, MUST.* A legacy token is never accepted from workspace settings; devices are identified per host via device identity (pairing); secrets live in robust credential storage; a workspace `.acpxrc.json` (which can override the agent command) executes only after explicit approval of that exact file (per folder + content hash).

**S3. Config and SecretStorage.** *claw-code, MUST.* The token lives only in SecretStorage; migration iterates ALL targets (user/workspace/folder × normal/language × Code/Code-OSS/VSCodium/Insiders + nested `.code-workspace`); per-folder updates in multi-root; the scope comes from `@types/vscode` — `{languageId, uri?}` (there is no `folderUri` field); tri-state migration result, retry incomplete, never cache failure; deprecated settings are registered in `package.json`.

**S4. Webview.** *claw-code, MUST.* Only `createElement`/`textContent` (no `innerHTML` with data); interactive rows are buttons (a11y); session keys from the webview are validated against the `sessions.list` allowlist (awaited); `emitState` after every await that changes rendering.

## Filesystem and paths

**R6. Filesystem checklist.** *General, MUST.* `realpath` at ingestion → containment check → open with `O_NOFOLLOW` (+`O_NONBLOCK` for potentially special files) → `fstat`-vs-`lstat` (dev/ino) + `isFile()` → revalidate after await. Containment is checked on resolve AND on read, and every entry point uses the same guards (in claw-code, slash commands use the same guards as `handleSend` — was S5). Check-then-use is a race by default. Residual windows are documented honestly, naming the responsible component.
*Check:* review checklist; attachment-reader tests.

**S5. Paths/attachments.** Merged into R6.

**R46. A platform-specific OS facility is a first-class code path — absolute binary, and an honest residual limit.** *General, MUST.* macOS cannot read the full path behind a descriptor through `/dev/fd` (it echoes its own path), so the full path comes from `lsof` run **by absolute path** (`/usr/sbin/lsof` — never a PATH lookup, same class as R30/R36), with a short timeout and a retry back-off so a stalled tool costs one timeout, not one per attachment; `lsof`'s escaped output (`\\`, `\t`, `\xHH`) is decoded before comparison. The gate is fail-closed exactly where the tool can tell: when the expected path is unambiguous to `lsof` (no caret/control character), any mismatch or missing answer rejects. Where `lsof` prints the name ambiguously (a caret or control character), the check falls back to `/dev/fd`, which only proves the basename — a same-named file in another directory can still pass, and that residual limit is documented in the code rather than claimed as full identity proof.

## Testing

**R7. Tests exercise interleavings, not the happy path.** *General, MUST.* Send during abort, rebind during send, reconnect during a run, duplicate frames. Every fixed race gets a regression test that fails without the fix. A test that codifies wrong behaviour is a bug; when semantics change, re-read the test contracts.
*Check:* review checklist.

**R34. Every block of code gets unit tests.** *General, MUST.* Logic, branches, guards, parsers and error handlers are tested: all condition branches, error paths and edge cases (empty/zero/NaN/missing values), interleavings and races, destructive lifecycle transitions (register/retire/replace), limit and budget boundaries. New code without tests is unfinished work; fixes ship with a regression test that fails without the fix. Integration/E2E tests complement unit tests but do not replace them. Coverage is not measured in CI yet, so until it is, this is a review obligation.
*Check:* review checklist.

**R49. A refactor that changes behaviour needs a test that fails without the change.** *General, MUST.* A green suite can still hide a semantic change: the change compiles, the old tests pass, and nothing exercises the edge. When a commit message says a caller "now observes" something different, that sentence is a test obligation. Cover the boundary explicitly — a rejected value, and what the caller sees instead. This matters most for extraction PRs, where the code looks unchanged because lines only moved between files. (PR #26 changed the token-count validator from "positive finite" to "positive safe integer" and moved a truncation suffix between layers; three of four findings were the untested new behaviour — a rejected count reads as `0`, not as the sent value.)
*Check:* review checklist.

**R12. Platform-dependent test setup goes inside a guarded hook.** *General, MUST.* `mkfifo` and other POSIX-only operations in `beforeEach` run before `it.skip`, so the test fails on Windows. Guard fixture setup/teardown with the same `process.platform` condition as the test itself.

**R44. Platform pinning covers OS-independent branches; OS-specific fixtures stay skipped.** *General, SHOULD.* Two situations, two tools. (a) A branch whose *setup* runs anywhere but whose logic asserts one OS (POSIX process-group signals, a `/proc`/`/dev/fd` path the spec stubs itself) **pins `process.platform`** for the enclosing `describe` with a save/restore hook (`helpers/platform.usePlatform`), so it runs on every runner. (b) A test whose *fixture or read path genuinely needs that OS's filesystem* (`mkfifo` a FIFO, read a real `/proc/self/fd` link) stays `posixOnly`-skipped on Windows, with its setup guarded per R12. Classify each case by whether the OS-specificity is real or only asserted.

**R50. A module mock's factory returns every export the code under test reaches, transitively.** *General, MUST.* Vitest throws at access to a missing mocked export (`No "x" export is defined on the "y" mock`), but only once something reads that name — and the name it reads is whatever the module's own internals reach, not just what the test file names. Check the factory against the transitive reach of the code under test: walk the mocked module's consumers, not the test's own call sites. The cheap safe form is to return the whole export surface and assert it (`satisfies typeof import('…')`); a partial mock must still cover everything reachable, including the module's own `require`/dynamic-import edges. A mock that intercepts a name nothing reaches is worse than none: it reads as isolation that is not there.

**R51. A deprecated alias is not a removal.** *General, MUST.* Keeping `jest.SpyInstance`-shaped names alive next to the canonical ones means two spellings of one concept, and a runner swap turns the spare one into a type error at every use site. When canonicalising a name, migrate every call site in the same pass and delete the alias; a `@deprecated` JSDoc tag does not make a duplicate definition safe.

**R53. `await` binds to the member access, not to the call.** *General, MUST.* `await resolveOnWindows(...).args` awaits the property of a promise, which is `undefined`, so the assertion fails with a plausible-looking diff and no error at the call. When a call becomes async, every `.field` on its result needs parens: `(await resolveOnWindows(...)).args`. Grep the whole diff for `await <call>(…).<prop>`; this is silent, not a build error.

**R54. A test hook's return value is an instruction, not a leftover.** *General, MUST.* `beforeEach(() => spy.mockReset().mockResolvedValue(…))` returns the mock itself. Vitest runs a **returned function** as the test's teardown, so the same line calls the mock once more after every test, and the damage lands on whichever test that extra call breaks — it reads as an unrelated or flaky failure. Write hooks that perform work with braces, so they return nothing; where the value is wanted, assign it to a named local. Audit the whole suite for expression-bodied hooks, not just the one that failed: `beforeEach(() => vi.useFakeTimers())` returns the `vi` object, not a function — harmless by accident, not by design.

## Cross-platform and CI

Basis: PR #16 turned a copied Windows job into a ubuntu/windows/macos matrix and fixed the portability bugs the new platforms exposed — temp paths and file search on Windows, attachment fd identity on macOS.

**R40. A platform matrix is one job, not N copied jobs.** *General, MUST.* Run one `strategy.matrix` job over the hosted labels `[ubuntu-latest, windows-latest, macos-latest]` with `fail-fast: false`; never copy-paste a per-OS job (copies drift — PR #16's first Windows job silently lost the Ubuntu job's Build/License steps). OS-independent work (typecheck, lint, licence check) runs once on the cheap runner (`if: runner.os == 'Linux'`); only the OS-sensitive step (build + test) runs on every runner. `workflow_dispatch` lets a maintainer re-run without an empty push.
*Check:* `.github/workflows/ci.yml`.

**R41. A required check behind a matrix is an aggregate job.** *General, MUST.* When a branch ruleset requires a fixed check name (here `ci`), a matrix job (whose checks are named `test (ubuntu-latest)` etc.) cannot satisfy it, and renaming the matrix job breaks the gate. Add a tiny `needs: [matrix]` + `if: always()` aggregate job **named exactly `ci`** that fails unless every OS passed.
*Check:* `.github/workflows/ci.yml`.

**R42. Concurrency cancellation must spare the default-branch run.** *General, MUST.* `cancel-in-progress: true` with a group keyed only on `github.ref` cancels a queued `main` run when a newer commit lands, so a main commit can land without a status. Key the group so a newer *PR* push supersedes the PR run, while every other run (main push, dispatch) gets a unique group: `group: ci-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}`.
*Check:* `.github/workflows/ci.yml`.

**R43. Tests own no absolute temp path.** *General, MUST.* Never `mkdtempSync('/tmp/...')` — `/tmp` does not exist on Windows, and on macOS `os.tmpdir()` is reached through a `/var → /private/var` symlink that a realpath-sensitive reader rejects. Use the shared helper that returns the **canonical** root, `fs.realpathSync.native(os.tmpdir())` (`src/__test__/helpers/tempDir.ts`), and build children with `path.join`. Build every path with `path.join`/`path.resolve`, never string `+ '/' +`. A fixture byte-compared across checkouts needs `.gitattributes: * text=auto eol=lf`, or Windows git rewrites it to CRLF.
*Check:* review checklist; the Windows and macOS CI legs.

**R45. Paths shown to a user are normalised to forward slashes on every OS.** *General, MUST.* A `relativePath` compared against a query typed as `src/app` must be `path.relative(...).split(path.sep).join('/')` — otherwise it matches on POSIX and fails on Windows, which is a product bug (file search), not just a test concern.

## Documentation, claims and registries

The refactor phases (PRs #17, #20, #21, #26) produced bookkeeping faults rather than design faults: claims that the code did not back up. PR #32 (the roadmap) showed the same class at document scale: about 30 Copilot rounds on one docs PR, each finding real gaps.

**R47. A comment describing a contract is a claim, and is verified like one.** *General, MUST.* A doc comment or README sentence that states a guarantee is part of the deliverable, not narration. Every claim of identity, fail-closed behaviour, completeness, or equivalence is checked by reading the branch it describes, and the residual limit is stated in the same sentence. "Returns the bytes" is a claim about a cap, a read loop and a stat — if any of the three differs between two call sites, the comment must not merge them. (PR #17: a macOS fallback described as fail-closed when its ambiguous-name branch is not; PR #21: a field documented with the wrong type; PR #26: a sync reader documented with the async reader's growth contract.)
*Check:* review checklist.

**R52. A shared reader's two entry points are two contracts.** *General, MUST.* Extracting one loop behind two wrappers (sync and async) produces wrappers whose *documented* guarantees differ, and the cheaper one is usually wrong: a sync wrapper that sizes one buffer from a prior `stat` reads short when the file grows below the cap, while the async loop reports the over-cap condition. Doc comments and regression tests state the difference per entry point — R47 one level up.

**R48. A registry is a list of facts, and every entry is checked in both directions.** *General, MUST.* A constants registry that replaces scattered literals is a second source of truth, and it rots the moment a registration moves. Repair it with a two-way diff, not a read-through: every entry is grepped to a real registration, and every registration is either in the registry or in a documented exclusion. Entries that belong to another registry are named in that registry's comment as an explicit scope statement, so the next reader can tell a decision from an omission. Here the registries partition by declaration: `COMMANDS` holds the ids `package.json` declares, `INTERNAL_COMMANDS` the ones the host registers without declaring. (PR #20: one finding covered four `INTERNAL_COMMANDS` ids nothing registered.)
*Check:* review checklist.

**R56. A design document states invariants, not the history of its review.** *General, MUST.* Binding behaviour is written as numbered rules (MUST statements with an ID), followed by the mechanism and a list of open questions. Arguments about why an earlier version was wrong belong in the PR thread, not in the document. When a review round reshapes the same paragraph again, rewrite it as invariants instead of patching the prose (R8). (PR #32: the diff/restore section grew to a 900-word paragraph of "X is not sufficient because…" before it was split into P/B/A/R/C rules.)
*Check:* review checklist.

**R57. Each requirement is stated in exactly one place.** *General, MUST.* Other documents link to it rather than restate it. A requirement repeated in N places turns every correction into N edits and drifts the first time one is missed. (PR #32: the Terminal Bridge approval rule appeared in five places, and the CI log upload in three.)
*Check:* review checklist — grep the docs for the requirement's key phrase before adding it.

**R58. A status claim cites the code that backs it.** *General, MUST.* "Done", "implemented", "tested", "partial", "works today" and any line or file reference are checked against the current code before they are written, and the evidence (file, symbol or test) is named next to the claim. A plan describes the target; it never presents planned behaviour as current. (PR #32: features marked Partial with no implementation, topologies described as working before the feature existed, and a backlog item for a function that did not exist.)
*Check:* review checklist.

**R59. A security design states its threat model.** *General, MUST.* Before the mechanism, say which attackers are in scope: workspace or repository content, other local accounts, a process running as the same user, the network, a remote Gateway host. Each protection is then judged against that list, and what it does not cover is stated. (PR #32: snapshot permissions, approval stores and loopback "locality" were each corrected only once the threat they had to resist was named.)
*Check:* review checklist.

## Process and review

**R8. A "push → N findings" loop is a design symptom, not a code one.** *General, MUST.* If a review round finds problems in a fresh fix, stop and rethink the design instead of patching. Adversarial self-review BEFORE pushing is cheaper than day-long fix cycles. **Stop criterion:** when three consecutive review rounds produce findings in the same section of a file, stop patching it; rewrite that section (as invariants, R56) or move its remaining edge cases into an explicit "Open questions" list, then continue.
*Check:* the PR author counts rounds per section.

**R9. Small focused PRs.** *General, SHOULD.* A large PR (12 commits, concurrency core) means hours of review and churn. Ship the concurrency core as a separate PR with its own design.

**R19. Every review round is a bug class, not a line.** *General, MUST.* After a finding, grep the whole diff (and then the codebase) for the same class, and fix similar valid spots in the same commit. After the PR, run a separate codebase-wide pass, with a PR immediately following the current one.

**R20. Rules are a living document.** *General, MUST.* Every technical PR, after its review cycle, adds or amends a declarative rule here (not "we fixed X" but "always do Y"). It goes under the right topic with the next free ID, never renumbering existing ones. The *General* rules are the portable part: they are copied to other projects as written.

**R21. GitHub language is English.** *General, MUST.* All communication on GitHub (code comments, JSDoc, PR titles, descriptions, threads, summary comments, review bodies) is English-only, for any project, by owner decision (2026-09-29: for claw-code unconditionally, regardless of community-project status). It does not apply to internal chats or memory, and applies to new content only: existing Russian comments are not rewritten. Repository documentation is included: every new repository document is written in English.

**R60. Copilot review protocol.** *General, MUST.* Verify every finding against HEAD (review snapshots are often stale). Reply in every thread with what was done and the fixing commit, then resolve it. Read each review overview's **Open** and **Previously missed** sections as well as the inline threads. "Previously missed" findings have no thread, so answer them in one PR comment per review, finding by finding (valid → fixed in `<sha>`; invalid → the evidence). A finding that needs a code or dependency change outside the PR's scope is tracked (roadmap ID or issue), not silently dropped. Stop rule: a round that produces no commits ends the loop.
*Check:* zero unresolved threads, and a disposition comment for every review with "Previously missed" items.

**S6. Repository process.** *claw-code, MUST.* Explicit branch fetch (refspec hygiene, `git remote prune`); rebase onto the remote tip before pushing (verify with `ls-remote`); Conventional Commits; run the CI gates before every commit, in CI's order: `pnpm run typecheck`, `pnpm run lint`, `pnpm run compile`, `pnpm exec vitest run`, `pnpm run license:check`. Run the test runner directly as CI does: `pnpm run test` would repeat compile and lint through `pretest`. Diagnose hangs explicitly rather than force-terminating runs. Copilot reviews follow R60.

**R55. Removing a tool is only complete when nothing names it.** *General, MUST.* After removing a tool, search the whole repository for its name — config, scripts, workflows, docs, and `/// <reference types="…" />` directives (which keep a removed package's types alive and hide the removal from `tsc`) — and change every invocation, not only the source that used it. Verify by running what CI runs, not what you just typed. (The Jest → Vitest migration went green locally while a CI step and a package script still named the old binary.)
*Check:* review checklist.

## Review checklist: recurring bug classes

Use this list in reviews; the counts are from PR #11 unless noted.

- Stale continuation after await (generation not captured or not checked) — ~15 findings — R2, R3
- Duplicated delivery (live + catch-up + pre-ack buffer without attribution) — ~10 — S2, R23
- Over- or under-aggressive teardown (retiring all sinks vs leaking callbacks) — ~8 — R1, R16, R17, R23. When retiring a resource, retire exactly the owner's own registration, never the whole session set.
- Path traversal / symlink TOCTOU / special files / case comparisons — ~8 — R6, R46
- Mixed delta + text frames (lost or duplicated text, a poisoned seen-set) — ~6 — S2, R38
- Token migration (scope semantics, multi-root, language override, distro paths) — ~8 — S3
- Async validation without await (allowlist bypass) — ~3 — R4, S4
- Fixes introducing new bugs (settled-first, union retry) — ~4 — R8, R19
- Secrets or prompts on a log or egress surface — 30 across PRs #1, #8, #11 — R10, R35
- Claims in comments or docs that the code does not back — PRs #17, #21, #26, #32 — R47, R58
