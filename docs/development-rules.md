# Development Rules (derived from the claw-code retrospective, 2026-09-27)

Basis: PR #8/#10 (Sprints 1–2), PR #11 MVP (28 Copilot rounds, ~90 findings, ~25 fix commits, a day of fixes).

## General rules (any project)

1. **Resource ownership is designed before code.** For every mutable resource (socket, callback, buffer, run) — a single owner, explicit lifecycle (register/retire/replace), and documented semantics. Multiple maps with different keys pointing at one resource = future races.

2. **Every `await` is a state-transition boundary.** After each await — revalidate preconditions (entity still active, generation unchanged, ownership retained). Capture generation/epoch identifiers BEFORE the await, compare AFTER.

3. **Monotonic epoch/generation for all async invalidation.** Bump BEFORE destructive operations (abort/close), check BEFORE applying results. Terminal events (done/close) are idempotent.

4. **A Promise is never checked as a boolean.** Async validation only via await. An unchecked Promise is always truthy.

5. **Untrusted input is validated at every trust boundary** — semantically (not just shape), and re-validated after each await when the data is externally controllable.

6. **Filesystem checklist:** realpath at ingestion → containment check → open with O_NOFOLLOW (+O_NONBLOCK for potentially special files) → fstat-vs-lstat (dev/ino) + isFile() → revalidate after await. Check-then-use is a race by default. Residual windows must be documented honestly, naming the responsible component.

7. **Tests exercise interleavings, not the happy path:** send during abort, rebind during send, reconnect during a run, duplicate frames. Every fixed race gets a regression test that fails without the fix. A test that codifies wrong behavior is a bug; when semantics change, re-read test contracts.

8. **A "push → N findings" loop is a design symptom, not a code one.** If a review round finds problems in a fresh fix — stop and rethink the architecture instead of patching. Adversarial self-review BEFORE pushing is cheaper than day-long fix cycles.

9. **Small focused PRs.** A large PR (12 commits, concurrency core) = hours of review and churn. Ship the concurrency core as a separate PR with its own design.

10. **Log hygiene:** never log secrets/prompts/file contents; only counters, keys, ids.

11. **Background process infrastructure:** interval ≥ maximum run duration (no overlaps); durable progress markers; single-flight.

## claw-code specifics (VS Code extension + OpenClaw gateway)

1. **Session/thread ownership model:** run sink vs transcript sink vs persistent callback; callback key is the thread id (threads share sessions). abort/clear/reset only when `status==='running'` with local ownership (`hasOwnedRun`); never abort behind idle subscribers.

2. **Streaming invariants:** frames may omit messageId; delta vs text vs mixed (cumulative/divergent); dedupe complete frames claim-before-dispatch; the seen-set holds only complete assistant rows; catch-up is gated on cursor + `allowUnscopedCatchUp` only for no-history paths; pre-ack buffers are provisionally associated with every in-flight send (ownership is unknown until settlement — see 23); `chat.send` only after subscription ack; `done` is idempotent.

3. **Config/SecretStorage:** token only in SecretStorage; migration iterates ALL targets (user/workspace/folder × normal/language × Code/Code-OSS/VSCodium/Insiders + nested .code-workspace); per-folder updates in multi-root; scope comes from @types/vscode — `{languageId, uri?}` (there is no folderUri field); tri-state migration result, retry incomplete, never cache failure; deprecated settings registered in package.json.

4. **Webview:** only createElement/textContent (no innerHTML with data); interactive rows are buttons (a11y); session keys from the webview are validated against the sessions.list allowlist (awaited); emitState after every await that changes rendering.

5. **Paths/attachments:** containment on resolve AND on read; O_NOFOLLOW + O_NONBLOCK + isFile + dev/ino + recheck after await; slash commands use the same guards as handleSend.

6. **Repo process:** explicit branch fetch (refspec hygiene, `git remote prune`), rebase onto the remote tip before pushing (verify with ls-remote), Conventional Commits, gates before every commit, run tests via the canonical `npm test` script (`"test": "vitest run"`) and diagnose hangs explicitly rather than force-terminating runs with `--forceExit`; Copilot protocol: verify every finding against HEAD (snapshots are often stale), reply in every thread, resolve threads, stop-rule for a round without commits, check the Open/Previously missed sections in overview review bodies.

## PR #11 bug classes (for future review checklists)

- Stale continuation after await (generation not captured/not checked) — ~15 findings
- Duplicated delivery (live + catch-up + pre-ack buffer without attribution) — ~10
- Over/under-aggressive teardown (retiring all sinks vs leaking callbacks) — ~8
- Path traversal / symlink TOCTOU / special files / case comparisons — ~8
- Mixed delta+text frames (lost/duplicated text, poisoning the seen-set) — ~6
- Token migration (scope semantics, multi-root, language-override, distro paths) — ~8
- Async validation without await (allowlist bypass) — ~3
- Fixes introducing new bugs (settled-first, union retry) — ~4

## PR #11 lessons (rounds 7–12, 2026-09-27) — error classes and preventive rules

12. **Platform-dependent test setup goes inside a guarded hook.** `mkfifo`/POSIX-only operations in `beforeEach` run before `it.skip`, so the test fails on Windows. Rule: guard fixture setup/teardown with the same `process.platform` condition as the test itself.

13. **`Number(x) || fallback` is not validation.** `NaN` is falsy, so `NaN || fallback` selects the fallback rather than letting `NaN` pass. The real failure modes are the opposite: a valid `0` also selects the fallback, while truthy invalid values such as `Infinity` and negative numbers pass unchecked. Rule: validate numeric values from untrusted input with a `Number.isFinite(v) && v >= 0`-style helper (toFinite*), not `||`.

14. **"Rendered" paths without a cursor are an early boundary, not a skip.** If catch-up is gated on a cursor and history was rendered without one — do not skip catch-up entirely: seeded rows form a boundary, deliver replay after it, and dedupe the seeded tail with ordered fingerprints (keyless rows are not covered by the messageId seen-set).

15. **Parse foreign configs per the product's specification, not guesswork.** Discovery/migration for chained language-override keys (`[ts][js]`) must rely on the product's actual semantics (VS Code `overrideIdentifiersFromKey` — indexing under each identifier), otherwise the guard misses valid data.

16. **Suspend ≠ dispose: transport lifecycle invariants.** Stopping a transport (fallback/switch) must: close the socket and reconnect loop, retire run sinks with `done`, BUT preserve persistent transcript/resume sinks and make them re-subscribable; purge pre-ack buffers together with their keys; a retired send resets the thread's streaming status synchronously (emitState), otherwise the UI hangs in "running".

17. **Aborts swallow late events entirely.** Late `chat`/`session.message` frames for an aborted run are skipped just like other late events; the terminal flow delivers `done` from the run's own terminal `chat` frame (`state: final`/`aborted`/`error` in protocol v4).

18. **Empty string ≠ missing value.** At all protocol boundaries, empty `messageId`/`delta`/`role:''` are treated as missing (asNonEmptyString), otherwise empty keys corrupt dedupe/seen-sets.

19. **Every review round is a bug class, not a line.** After a finding, grep the whole diff (and then the codebase) for the same class; fix similar valid spots in the same commit. Post-PR: a separate codebase-wide pass with a PR immediately following the current one.

20. **Rules are a living document.** Every technical PR, after its review cycle, adds a declarative rule to development-rules.md (not "we fixed X", but "always do Y"). Distilled into a wiki how-to for portability across projects.

21. **GitHub language is English.** All communication on GitHub (code comments, JSDoc, PR titles, descriptions, threads, summary comments, review bodies) is English-only, for any project, by owner decision (2026-09-29: for claw-code — unconditionally, regardless of community-project status). Does not apply to internal chats/memory. Applies to new content only; existing Russian comments are not rewritten. Repository documentation is included: every new repository document must be written in English.

22. **Delta rows do not shadow final rows.** On any recovery/dedup path keyed by id, a row with a non-empty `delta` (partial text) must be skipped in favor of a final row with the same id, otherwise the recovered transcript is truncated to the delta.

23. **Pre-ack frames for foreign keys are buffered with wide attribution.** A key frame (a `session.message` row, or a terminal `chat` frame with `state: final`/`aborted`/`error`) whose key has no sink yet, while a pre-ack send is in flight, is buffered attributed to all in-flight sends (the owner is unknown until settlement — remap yields the resolved key, and the preAck set stores requested); drain correlates on settled requested→resolved and drops ambiguous ones. Finalizing on such a key earlier is a no-op that loses the terminal event and leaves "eternal streaming" after the ack.

## Protocol rework lessons (owner rounds, 2026-09-28/29)

24. **!VERY IMPORTANT! Never invent protocols, wire formats, APIs, CLI semantics, or library behavior.** External contracts (gateway protocol, JSON-RPC, handshake, third-party tools) must be written ONLY from documentation or actual source code. If none is at hand — ask the owner for docs/sources/a link. Only after an explicit "none exists" is empirical probing permitted. Applies to ALL development, not just claw-code. Precedent: the assumed OpenClaw gateway contract (`sessions.messages.subscribe {sessionKeys}`, `chat.send {text, queueMode}`, `session_end`, `deltaCursor`) was rejected by the real gateway — the protocol had to be rewritten entirely.

25. **Wire frames are tested against the product's real schemas.** Every outgoing frame is validated against JSON Schema exported from the real gateway's TypeBox schemas (fixtures, regenerable via `scripts/sync-openclaw-protocol.mjs`), plus frames captured from a live gateway; the implementation is verified end-to-end against a real instance on loopback.

26. **Protocol versioning goes through an adapter + negotiation.** Version-neutral model, `GatewayProtocolAdapter`, a v4 adapter, registration negotiates the version from a setting (`openclaw.gateway.protocolVersion: auto | 4`); an unsupported version yields a clear permanent error; the negotiated version is visible in the status badge and logs.

27. **Handshake uses the server's closed enums.** Client id/mode only from the gateway's permitted values (e.g. `gateway-client/backend`); failures are classified by `error.details.code` exactly as the server sends them (`AUTH_*`, `DEVICE_AUTH_*`, `PAIRING_REQUIRED`, `PROTOCOL_MISMATCH`); credential/protocol failures stop reconnecting with a clear message, rate-limit/unavailability is backed off while respecting `retryAfterMs`; `hello-ok.policy` is parsed and clamps client limits.

28. **Runs are correlated by the runId from the ack, not by shared mutable state.** Seq-dedupe/replace of events; retrying a send whose ack was lost reuses the same idempotency key; only an explicit `ok:false` is a rejection; `chat.abort` is sent only over the connection that started the run; a non-stoppable run keeps streaming with a notification; the canonical session key is learned from hello-ok/subscribe; catch-up by cursor with reset.

29. **Third-party CLI agents are described by their real behavior, not guesses.** For acpx: the real output format (ACP JSON-RPC from `--format json`), stdin `exec --file -` (the prompt as one explicit ACP text block — a leading `[` is parsed as content blocks), exit 5 = denied permission after a response (a normal completion with a notice), JSON-RPC ids are attributed by direction (an agent-side error ≠ a failed prompt), images are ACP image blocks, not temp files.

30. **External commands run only from absolute paths.** PATH entries without an absolute path (relative, repo-planted) are ignored (protection against planted node.exe/cli.js); npm/pnpm shims on Windows resolve to the JS entry and run through node without a shell; children never receive an empty PATH; PATH is read case-sensitively on POSIX.

31. **Sensitive settings are user-scope only.** A legacy token is never accepted from workspace settings; devices are identified per-host via device identity (pairing), secrets live in robust credential storage; a workspace `.acpxrc.json` (which can override the agent command) executes only after explicit approval of that exact file (per folder + content hash).

32. **Limits are measured in the form the transport actually reads.** The prompt budget is computed over the JSON-escaped payload (not raw text), per-file/per-image/frame limits come from the gateway's `hello-ok.policy`, not invented constants; the Windows argv budget uses worst-case quoting, NUL → one-byte substitute.

## Process lessons from the owner rounds (2026-09-28/29)

33. **Fact-checking against the real environment beats internal models.** Reviews/fixes made against an imagined contract have no value — verification against the live gateway/real schemas is mandatory before approving code correctness (see rule #24).

## Test coverage

34. **Maximum unit-test coverage is a mandatory standard.** Every block of code written (logic, branches, guards, parsers, error handlers) gets unit tests; coverage aims for maximum, not "covered the happy path". Test: all condition branches, error paths and edge cases (empty/zero/NaN/missing values), interleavings and races, destructive lifecycle transitions (register/retire/replace), limit and budget boundaries. New code without tests is unfinished work; fixes ship with a regression test that fails without the fix. Integration/E2E tests complement unit tests but do not replace them.

## Recurring classes from earlier PRs (retrospective pass, 2026-09-29)

35. **Credentials are redacted on every egress surface, not only in logs.** UI labels, tree descriptions, reports, error messages, and prompt wrappers pass a sanitizer (URL forms: userinfo and `?key=***`; plaintext: `key=…`, `OPENAI_API_KEY=…`, `"token":"…"`, `Bearer …`); a child process's `stderr` is sanitized too; never echo the raw value of a workspace setting back in an error. (Recurring class: 30 findings across PRs #1, #8, #11.)

36. **Workspace-configurable values are untrusted command/URL input.** Never interpolate a workspace setting into a shell; only `execFile` with an argv vector and a quote-aware parser. Configured actions that execute or connect in a workspace context (autoConnect, hardening command) are gated on `workspace.isTrusted`; both are application-scoped user settings, so a workspace can neither supply nor disable them; `openDashboard` is deliberately NOT trust-gated — it scheme-validates the URL (http/https allow-list) before `openExternal`, which is the entire protection for that path. Do not conflate user-scope secret protection with workspace-trust gating. (PR #1 findings; only rule 31's workspace-approval clause is limited to `.acpxrc.json` — rule 31 itself covers legacy tokens, device identity, and credential storage too.)

37. **Foreign-payload mapping is alias-tolerant, complete, and numerically validated.** One canonical mapper per direction — do not duplicate it (mapping drift); read each semantic alias group completely (`input`, `inputTokens`, `promptTokens`, `input_tokens`, `prompt_tokens` for prompt tokens; `output`, `outputTokens`, `completionTokens`, `output_tokens`, `completion_tokens` for completion tokens; `totalTokens`, `total`, `total_tokens` for total) — complementary counters are never aliases of each other; validate numbers with `Number.isFinite(v) && v >= 0`, never `Number(x) || fallback`. (PR #1: snake_case + duplicate mapper; PR #11: usage; PR #12: NaN.)

38. **Terminal/streaming event mapping preserves identity and metadata end-to-end.** A tool-call/assistant row carries `id` + `arguments`/`result`/`details` through every lifecycle update; empty `messageId`/`delta`/`role` mean missing; a delta never shadows the final row with the same id. (Latent in PR #1, ~6 findings in PR #11.)

39. **Structural validators distinguish absent from malformed where the difference is security- or data-bearing.** An array arriving where a record is expected, `null` where a field is optional, and a truncated object are distinct failure modes. The canonical reader pattern in this codebase normalizes malformed payloads to safe defaults (`readRecord` → `EMPTY_RECORD`, readers → `null`) and drops the row — that is the right default for render paths; where a security or data-integrity decision is made (path segments, secrets, sinks), the validator must branch on the distinction instead of lumping it into one bucket that either drops valid data or accepts garbage. (PR #1, #8.)

### Notes on coverage gaps this pass exposed

- Teardown/leak rules (general rule 1 on ownership, and rules 16, 17, 23) still produced the largest finding count in PR #11: when retiring a resource, retire exactly the owner's own registration, never the whole session-set — worth re-reading those rules together on any teardown change.
- Secret-redaction (general rule 10) covers logs only; egress surfaces (rule 35) are a separate mandatory surface.

## Cross-platform CI and portability (PR #16, 2026-09-30)

Basis: PR #16 turned a copied Windows job into a ubuntu/windows/macos matrix and fixed the portability bugs the new platform runs exposed — temp paths and file search on Windows, attachment fd identity on macOS. The classes below generalize what that PR had to solve.

40. **A platform matrix is one job, not N copied jobs.** Run one `strategy.matrix` job over the hosted labels `[ubuntu-latest, windows-latest, macos-latest]` with `fail-fast: false`; do not copy-paste a per-OS job (the copies drift — PR #16's first Windows job silently lost the Ubuntu job's Build/License steps). OS-independent work (typecheck, lint, license check) runs once on the cheap runner (`if: runner.os == 'Linux'`); only the OS-sensitive step (build + test) runs on every runner. `workflow_dispatch` lets a maintainer re-run without an empty push.

41. **A required check behind a matrix is an aggregate job.** When a branch ruleset requires a fixed check name (here `ci`), a matrix job (whose checks are named `test (ubuntu-latest)` etc.) cannot satisfy it and renaming the matrix job breaks the gate. Add a tiny `needs: [matrix]` + `if: always()` aggregate job **named exactly `ci`** that fails unless every OS passed — this keeps the required-check contract stable while the matrix is free to grow.

42. **Concurrency cancellation must spare the default-branch run.** `cancel-in-progress: true` with a group keyed only on `github.ref` cancels a queued `main` run when a newer commit lands, so a main commit can merge/land without a status. Key the group so a newer *PR* push supersedes the PR run, but every other run (main push, dispatch) gets a unique group and is never cancelled: `group: ci-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}`.

43. **Tests own no absolute temp path.** Never `mkdtempSync('/tmp/...')` — `/tmp` does not exist on Windows, and on macOS `os.tmpdir()` is reached through a `/var → /private/var` symlink that a realpath-sensitive reader rejects. Use a shared helper that returns the **canonical** root, `fs.realpathSync.native(os.tmpdir())`, and build children with `path.join`. Build every path with `path.join`/`path.resolve`, never string `+ '/' +` (Windows uses `\`, and a leading `/work` gains a drive letter). A fixture that is byte-compared across checkouts needs `.gitattributes: * text=auto eol=lf`, or Windows git rewrites it to CRLF and the comparison fails.

44. **Platform pinning covers OS-independent branches; OS-specific fixtures stay skipped.** Two different situations, two tools. (a) A branch whose *setup* runs anywhere but whose logic asserts one OS (POSIX process-group signals, a `/proc`/`/dev/fd` path the spec stubs itself) should **pin `process.platform`** for the enclosing `describe` with a save/restore hook (see `helpers/platform.usePlatform`), so the branch is exercised on every runner instead of only on Linux. (b) A test whose *fixture or read path genuinely needs that OS's filesystem* (`mkfifo` a FIFO, read a real `/proc/self/fd` link) cannot run elsewhere and stays `posixOnly`-skipped on Windows — do not force it onto the runner by pinning the platform, and guard its fixture setup/teardown with the same condition as the test (rule 12). Classify each case by whether the OS-specificity is real or only asserted.

45. **Paths shown to a user are normalized to forward slashes on every OS.** A `relativePath` compared against a query typed as `src/app` must be `path.relative(...).split(path.sep).join('/')` — otherwise it matches on POSIX and fails on Windows, which is a real product bug (file search), not just a test concern.

46. **A platform-specific OS facility is a first-class code path — absolute binary, and an honest residual limit.** macOS cannot read the full path behind a descriptor through `/dev/fd` (it echoes its own path), so the full path comes from `lsof` run **by absolute path** (`/usr/sbin/lsof` — never a PATH lookup, same class as rules 30/36), with a short timeout and a retry back-off so a stalled tool costs one timeout, not one per attachment; `lsof`'s escaped output (`\\`, `\t`, `\xHH`) is decoded before comparison. The gate is fail-closed exactly where the tool can tell: when the expected path is unambiguous to `lsof` (no caret/control character), any mismatch or missing answer rejects. Where `lsof` prints the name ambiguously (a caret or control character), the check falls back to `/dev/fd`, which only proves the basename — a same-named file in another directory can still pass, and that residual limit is documented in the code rather than claimed as full identity proof.

## Refactor-phase lessons (PRs #17, #20, #21, #26, 2026-09-30 → 2026-10-02)

The refactor phases moved code without re-architecting it, so the defects they produced were not design faults. They were bookkeeping faults, and this section covers three distinct classes: a claim in a comment that the code did not back up (rule 47), a registry entry the code did not back up (rule 48), and a gate that stayed green because nothing tested the edge the change introduced (rule 49). The category spans four PRs, but no single class does — rule 47 spans three PRs (#17, #21, #26), while rule 48 surfaced in #20 and rule 49 recurs as several findings inside #26. One review finding can also name several defects at once — the PR #20 registry finding covered four bad entries — so findings and defects are counted separately. That spread is what makes them worth a rule.

47. **A comment describing a contract is a claim, and is verified like one.** A doc comment or README sentence that states a guarantee is part of the deliverable, not narration. Copilot found this class three times in three PRs: a macOS fallback described as fail-closed when the ambiguous-name branch is not (PR #17), a tool-update field documented with the wrong type (PR #21), a synchronous reader documented with the async reader's growth contract, where a file that grows below the cap reads short rather than reporting over-cap (PR #26). Rule: every claim of identity, fail-closed behavior, completeness, or equivalence is checked by reading the branch it describes, and the residual limit is stated in the same sentence. "Returns the bytes" is a claim about a cap, a read loop, and a stat — if any of the three differs between two call sites, the comment must not merge them.

48. **A registry is a list of facts, and every entry is checked in both directions.** A constants registry introduced to replace scattered literals is itself a second source of truth, and it rots the moment a registration moves. One Copilot finding in PR #20 identified four entries with no call site — four defective entries, not four separate findings. The repair is a two-way diff, not a read-through: every registry entry must be grepped to a real registration, and every registration must be either in the registry or in a documented exclusion. A registry that only ever grows is a mirror of the file it replaced; entries that belong to a different registry belong in that registry's own comment as an explicit scope statement, so the next reader can tell a decision from an omission. The two registries here partition by declaration, not by audience: `COMMANDS` holds the ids `package.json` declares, `INTERNAL_COMMANDS` the ones the host registers without declaring, and that criterion is what makes a two-way diff close. An exclusion nobody wrote down is indistinguishable from an oversight — which is how `INTERNAL_COMMANDS` came to hold four ids nothing registered in PR #20.

49. **A refactor that changes behavior needs a test that fails without the change.** Rule 34 requires coverage, but a green suite can still hide a semantic change: the change compiles, the old tests still pass, and nothing exercises the edge. PR #26 changed the token-count validator from "positive finite" to "positive safe integer" and moved a truncation suffix between layers — three of four findings were the untested new behavior, and the fourth was the comment from rule 47. Rule: when a commit message says a caller "now observes" something different, that sentence is a test obligation. Cover the boundary explicitly — a rejected value, and what the caller sees instead (a rejected count reads as `0`, not as the sent value, so the reported total changes). This matters most for extraction PRs, where the shape of the code looks unchanged because the work is moving lines between files.

## Test-runner migration lessons (Jest → Vitest, 2026-10-02/03)

The refactor moved 48 suites and ~1,400 tests from Jest to Vitest with no behavior change intended. These are the classes that cost real time, recorded so the next runner swap is cheaper.

50. **A module mock's factory must return the module's whole export surface, not just the fields the test touches.** Jest let a factory omit an export and handed the importing module `undefined`; the omission stayed invisible until some unrelated line dereferenced it. Vitest throws at the access instead — `No "x" export is defined on the "y" mock` — which turns a silent stub into a hard failure, but only once something reads that name. So when mocking a module wholesale, copy its export list from the source and assert the mock is complete (`satisfies typeof import('…')`), rather than listing the two or three members the current test happens to call. The members the test does not touch still have to exist.

51. **A deprecated alias is not a removal.** Keeping `jest.SpyInstance`-shaped names alive next to the canonical ones means two spellings of one concept, and the runner swap turns the spare one into a type error at every use site. When canonicalizing a name, migrate every call site in the same pass and delete the alias; a `@deprecated` JSDoc tag does not make a duplicate definition safe.

52. **A shared reader's two entry points are two contracts.** Extracting one loop behind two wrappers (sync and async) produces wrappers whose *documented* guarantees differ, and the cheaper one is usually wrong: a sync wrapper that sizes one buffer from a prior `stat` reads short when the file grows below the cap, while the async loop reports the over-cap condition. Doc comments and regression tests must state the difference per entry point, not share one description — the same class as rule 47, one level up.

53. **`await` binds to the member access, not to the call.** `await resolveOnWindows(...).args` awaits `resolveOnWindows(...).args` — the property of a promise, which is `undefined`, so the assertion fails with a plausible-looking diff and no error at the call. When a call becomes async, every `.field` on its result needs parens: `(await resolveOnWindows(...)).args`. Grep the whole diff for `await <call>(…).<prop>` and parenthesize it; this is silent, not a build error.

54. **A test hook's return value is an instruction, not a leftover.** `beforeEach(() => spy.mockReset().mockResolvedValue(…))` is an expression-bodied arrow, so it evaluates to whatever the last call returns — here, the mock itself. Jest discards a hook's return value, so the shape survived review for years; Vitest runs a **returned function** as the test's teardown, so the same line calls the mock once more after every test. The damage lands on whichever test's state that extra call breaks, not on the hook that caused it — which is why it reads as an unrelated or flaky failure. Rule: write a hook that performs work with braces, so it returns nothing; where the value is genuinely wanted, assign it to a named local and let the arrow stay block-bodied. Audit the whole suite for expression-bodied hooks rather than only the one that failed: `beforeEach(() => vi.useFakeTimers())` returns the `vi` object, not a function, so it is harmless today — harmless by accident, not by design. An `afterEach(() => vi.useRealTimers())` rewritten as `afterEach(() => vi.restoreAllMocks().mockReset())` would start returning a function and break every test in the file.

## Tool-swap lessons (Jest → Vitest, continued)

55. **Removing a tool is only complete when nothing names it.** The migration removed `jest`, `ts-jest` and `@types/jest` from the dependency graph, and the suite went green locally — because the local command was the *new* one. What stayed behind were the invocations: a CI step still ran the old binary, and a package script still named it. A deleted dependency is not gone while any file still calls it, and the surfaces that keep calling it are exactly the ones nobody re-reads — CI steps, package scripts, contributor docs, and `/// <reference types="…" />` directives, which keep a removed package's types alive in type checking and therefore hide the fact from `tsc`. Rule: after removing a tool, search the whole repository for its name — config, scripts, workflows, docs, type directives — and change every invocation, not only the source that used it. Verify by running what CI runs, not what you just typed.
