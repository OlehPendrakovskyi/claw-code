# Design: inline diffs, reject and checkpoints

Covers roadmap items **P1-1** (diff view and Accept), **P1-1b** (Reject, v1.x), **P1-1c** (per-change review, v2), **P1-4** (recording checkpoints) and **P1-4b** (Rewind, v1.x). Status: design, not implemented. Back to the [roadmap](../roadmap.md).

## Problem

The agent edits files outside the VS Code process — on the Gateway host or a paired node — and the extension learns about an edit only from the session's toolCall events, after the write has usually already happened. Showing a trustworthy diff, and undoing an edit without destroying the user's own work, therefore depends on what the extension captured *before* the run and on what it can attribute to the agent *after* it.

## Terms

| Term | Meaning |
| --- | --- |
| **Owning root** | The `WorkspaceFolder` a toolCall declares as the root its relative path belongs to |
| **Before-state** | The file contents before the agent touched it |
| **Post-agent baseline** | The contents the agent produced, as recorded by the extension |
| **Wave** | The edits between toolCall lulls within one run; the unit of a checkpoint |
| **Restore** | Writing a before-state back to disk — used by both Reject and Rewind |

## Invariants

These are the binding rules. Each is stated once here; the roadmap and other documents link to this section instead of repeating it.

### Path resolution and containment

- **P1.** A toolCall path is resolved only against the owning root the toolCall **declares**. Never use the deprecated single-root `workspace.rootPath`, and never infer the owner by longest matching prefix: a relative path carries no root, and an inferred owner can be the wrong repository. An ambiguous path is refused with a clear error.
- **P2.** Containment is checked on **canonical** paths. Canonicalise the root with `realpath`; canonicalise the target with `realpath` when it exists, or canonicalise its nearest existing parent and re-append the remaining segments when it does not. The canonical target must lie inside the canonical root, so neither `..` segments nor symlinks can leave the folder. An escaping path is refused, never guessed.
- **P3.** Canonicalisation is a **pre-operation** check, not a guarantee: a directory can be swapped for a symlink between `realpath` and the open. Reads repeat the check at operation time using the pattern already in the attachment reader (`src/webview/viewMessaging.ts:413-438`): open through a handle, `O_NOFOLLOW` on the final component, compare the handle's dev/ino with a fresh `lstat`, verify the handle's own location via the fd link, re-canonicalise afterwards and discard the result on any drift.
- **P4.** Writes must guarantee containment **before** writing, because post-write drift detection can report an escape but cannot undo it. Open the destination through a handle with `O_NOFOLLOW`, verify the handle's location (dev/ino plus the fd link) against the canonical root, and write only through that verified handle — never through a re-opened path string. Without a resolvable fd link, fall back to the identity comparison made before the write. Where operation-time containment cannot be guaranteed, the **automatic** restore is disabled and only the explicit conflict/force flow is offered.

### Before-state

- **B1.** Admissible sources of the before-state, in order: (a) a snapshot captured before the run; (b) an acknowledged pre-write protocol in which the client applies the edit itself (v2, below); (c) git HEAD or a stash, **only** if it was captured before the run or the file's cleanliness was verified beforehand.
- **B2.** The toolCall *start* event is not a pre-write barrier — the Gateway can emit it and finish the write before the extension receives it — so a pre-read triggered by it is not a before-state.
- **B3.** When no admissible source exists, the diff reports the before-state as **unavailable**. A late HEAD diff is never presented as the agent's diff: a file with uncommitted user edits would attribute those edits to the agent.

### Post-agent baseline

- **A1.** The baseline is valid only when it is **attributable to the agent**: the bytes or a hash observed as the toolCall result, or change tracking established before the run began. Reading the file when the toolCall completes is not enough on its own — the write and the event are asynchronous, so a user edit in the gap would be recorded as agent output.
- **A2.** The baseline is recorded once, at the toolCall completion / wave-close boundary, and never refreshed. Reading it later (for example when the diff or rewind UI opens) silently adopts any user edit made in between.
- **A3.** If the baseline cannot be attributed, the automatic restore is refused as ambiguous; offer a three-way conflict flow or an explicit force-restore instead.

### Restore (Reject and Rewind)

- **R1.** `git checkout -- <file>` is not a Reject: it restores HEAD and destroys uncommitted edits that existed before the agent started. HEAD is used only when the file's cleanliness was verified beforehand (B1c).
- **R2.** A restore is **conditional**: it proceeds only if the current on-disk contents still equal the post-agent baseline. Otherwise refuse, tell the user the file changed, and offer an explicit force-restore.
- **R3.** The R2 comparison is a **staleness check, not a compare-and-swap** — an edit landing between the compare and the write is still overwritten — and the UI must not describe the restore as safe. None of these close that window: a temp-file rename (atomic replacement, but not conditioned on the destination), re-comparing just before the replace, writing under a content-addressed key (does not touch the destination), or `RENAME_NOREPLACE` (fails whenever the destination exists, so it cannot replace a file at all).
- **R4.** An **automatic** restore requires a true compare-and-swap on the destination, conditioned on its exact version or generation (a versioned update, a generation-conditional write, or a platform compare-exchange). No filesystem primitive on this project's targets qualifies today, so automatic restore stays disabled and Reject/Rewind ship as the explicit conflict/force flow. See *Open questions*.

### Checkpoints

- **C1.** Take the snapshot **before every run that can edit files** — any run whose mode or agent permits writes — not when the first file-effect toolCall arrives: by then the write has already happened (B2). A run that ends without file effects simply discards its snapshot. Within a run, the checkpoint unit is a wave.
- **C2.** Git snapshot: `git stash create` (it does not touch the index), with the SHA stored in the session's checkpoint registry. On a clean tree it prints nothing and exits 0, so the checkpoint always records an explicit baseline instead: the HEAD commit, or the index tree from `git write-tree` when the index differs from HEAD. With an unborn HEAD (fresh `git init`) `git stash create` cannot run and `git write-tree` records only the **index** (the empty tree when nothing is staged). A file staged and then edited again before the first commit has worktree bytes that neither captures, so in an unborn repository the checkpoint additionally shadow-copies (as in C6) every tracked path whose worktree contents differ from the index. With that addition every git repository has a complete baseline.
- **C3.** Preserve the pre-run **index tree** and restore index and worktree separately. `git checkout <stash> -- .` updates both and turns pre-existing unstaged edits into staged ones.
- **C4.** Rewind touches only the agent's paths, never the whole tree, and restores the **worktree and the index separately** per C3 — never with `git checkout <snapshot> -- <paths>`, which writes one version into both and collapses a path's distinct staged and unstaged pre-run versions. For each path: (a) the worktree bytes come from the snapshot's worktree tree (the `git stash create` commit itself, or the shadow copy of C2/C5) and are written through the verified handle of P4, after the R2 check against the per-path post-wave contents recorded at wave close (A1–A3); (b) the index entry comes from the recorded pre-run index tree (the stash's index parent `<stash>^2`, or the `git write-tree` / HEAD baseline of C2) via `git restore --staged --source=<index tree> -- <path>`, which removes the entry when the path was not in that tree. A path refused under R2 is left untouched in both the worktree and the index.
- **C5.** `git stash create` does not cover untracked files, and a checkout does not remove files created after the snapshot. The checkpoint therefore also records the set of untracked / new / deleted paths **and** the contents plus mode and mtime of pre-run untracked files, tracks the files the run creates, and restores them under the same R2 guard.
- **C6.** Non-git folders use shadow copies under `~/.openclaw/vscode-checkpoints/`.
- **C6a. Resource bounds.** Every shadow copy (C2 unborn repositories, C5 untracked files, C6 non-git folders) goes into a content-addressed store, so an unchanged file is stored once however many checkpoints reference it, and each checkpoint copies only files whose size, mtime or hash changed since the previous one. The store is bounded by configurable limits — total bytes and file count per checkpoint, a per-file size ceiling, and exclusions (`.gitignore` rules where present, plus build and dependency directories such as `node_modules`, `dist`, `out`) — and by retention: the last N checkpoints per session and a maximum age, with unreferenced blobs garbage-collected when a checkpoint is dropped or its session is closed.
- **C6b. Failure behaviour.** If a checkpoint would exceed a limit, or the disk lacks space, no partial checkpoint is recorded. The run still starts, but the UI marks it as having **no checkpoint** — Rewind is unavailable for it and the user is told why before the run begins, with the option to cancel. An excluded or oversized file is listed as not covered by the checkpoint and is never silently restored or deleted by a rewind.
- **C7.** Repositories on a NAS (see the deployment topologies in the [roadmap](../roadmap.md#5-deployment-topologies)) are checkpointed by the agent at the extension's request, or via node exec when a paired node exists (preferred) — v2.

## Mechanism

0. **Pre-run snapshot.** When a run that can edit files starts, take the checkpoint per C1–C6b before sending the prompt.
1. **Interception.** The event reducer recognises a toolCall with a file effect (the `write` / `edit` / `apply_patch` class). Concrete tool names come from discovery and the agent runtime; the mapping lives in the protocol contract layer.
2. **Location.** Resolve per P1–P4. A file on a NAS that the window cannot reach goes to step 5.
3. **Rendering.** `vscode.diff` with the left side served by an `openclawOriginal:` content provider holding the before-state (B1–B3) and the right side the working file.
4. **Decision.** Accept marks the edit reviewed. Reject restores per R1–R4.
5. **Unobserved edits.** When the file is not reachable through the filesystem, show a textual diff in the chat (from the toolCall details or a `git diff` requested from the agent) with Accept ("ok") and Reject ("revert file X") buttons. An honest fallback, with no pretend editor UX.
6. **Rewind.** A rewind button on a message restores the checkpoint (C1–C7). Forking the conversation (a new Gateway session with the history copied) is v2.

### v2 extensions

- **Pre-apply.** In Manual mode the agent returns the proposed content in the toolCall details and the extension applies it itself — local repos only. This is source (b) of B1.
- **Per-change review.** Accept/Reject buttons under each change in the diff (TextDocumentContentProvider plus decorations, up to 100 changes), and `openclaw.acceptChangeAtCursor` / `openclaw.rejectChangeAtCursor` driven by cursor position.

## Delivery split

| Stage | Ships |
| --- | --- |
| v1 | Diff view with before-state per B1–B3, Accept, the textual fallback, and git checkpoints recorded per C1–C6b |
| v1.x | Reject and Rewind as the explicit conflict/force flow (R2–R3) |
| Blocked on R4 | Automatic, unprompted restore |
| v2 | Pre-apply, per-change review, Accept/Reject at cursor, conversation fork, NAS checkpoints (C7) |

## Open questions

1. **Compare-and-swap (R4).** Is there any conditional-write primitive on Linux, macOS and Windows that can be conditioned on the destination's version? Until there is, automatic restore stays off.
2. **Agent-attributable bytes (A1).** Does the Gateway's toolCall result carry the written bytes or a hash? If not, request it upstream — without it every baseline is ambiguous.
3. **Checkpoint limits.** The default values for C6a (bytes, file count, per-file ceiling, retention N and age).
4. **File-effect tool names.** Which tool names and argument shapes the contract layer must map, per agent runtime.
