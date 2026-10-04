# Design: Terminal Bridge

Covers roadmap item **P1-0**. Status: design, not implemented. Back to the [roadmap](../roadmap.md).

## Problem

The agent runs on the Gateway, but the project often lives on the user's machine. Without a way to run commands there — tests, project scripts, `rg`, builds — and read their output, the agent cannot close the edit → test → fix loop for a local project. The Terminal Bridge lets the agent request a command, the user approve it, and the extension run it in a VS Code terminal and stream the output back.

Every component exists in the Gateway already: the node-host role and the exec-approvals mechanism used by the OpenClaw desktop nodes.

## Invariants

### Connection

- **T1.** The bridge uses a **second WebSocket** to the Gateway with `role=node`, separate from the chat socket. The handshake negotiates exactly one role per connection; the chat socket is `role=operator` and needs operator scopes (for example `operator.approvals`) that switching to `role=node` would drop.
- **T2.** The node-role socket has its own pairing/auth, device identity and reconnect lifecycle. It follows the same transport-security rule as the chat socket (see [roadmap §2](../roadmap.md#2-community-requirements), requirement 1).

### Approval

- **T3.** No command runs without an explicit user authorisation: **Run once** (this request only), **Always allow**, or **Deny**. An *Always allow* grant is itself that authorisation for later requests: a later request runs without a new prompt **only while its full immutable identity (T6) still matches the grant exactly** and T7 holds. Any difference, or an identity that cannot be established (T8), means the user is prompted again. Deny returns a refusal to the agent, which adapts. Every command, including one run under a standing grant, is shown in the visible terminal (T9), so nothing executes silently, and standing grants can be listed and revoked.
- **T4.** **Always allow is never a name-based allowlist.** `pytest`, `npm test` or `tsc` execute workspace-controlled scripts and so can run arbitrary code.
- **T5.** Nor is the tuple *command + arguments + working directory + workspace* enough: the same approved `npm test` runs different code once `package.json` or the referenced script changes.
- **T6.** A persistent approval binds the **immutable code identity**: the tuple of T5; the resolved executable path **and a digest of the executable's bytes** (and of the interpreter, for a script); content digests of every script/config file the command loads; and the environment that changes what runs (`PATH` and runtime variables such as `NODE_OPTIONS` or `PYTHONPATH`). A path alone is not an identity — the binary at that path can be replaced after approval. Any change to any part invalidates the approval.
- **T7.** Digests are checked before the run, but a file can still change between that check and the moment it is read or executed. A persistent approval therefore **executes from an immutable snapshot** — the validated workspace files, and the validated executable where it is copyable, placed in a content-addressed, non-writable location and run from there — or binds atomically to the validated bytes by some equivalent means. This applies to the executable and the runtime as much as to workspace code.
- **T8.** Where the code identity cannot be established or pinned — shells and package runners that resolve their payload at run time, executables or runtime dependencies that cannot be snapshotted or atomically validated, or an environment that cannot be fixed — or T7 cannot be met, **Always allow is disabled** and the request is escalated to **Run once**.

### Execution and output

- **T9.** Commands run in a visible VS Code terminal. The user sees the command and its output in real time.
- **T10.** stdout/stderr stream back to the agent as the tool result. Long output is truncated with the **tail** kept.
- **T11.** Output capture must be implementable without relying on shell integration, because VS Code exposes a terminal's output (`TerminalShellExecution.read()`) only through it. The bridge therefore runs each command as an **extension-owned process** and mirrors its output into a visible terminal through a `Pseudoterminal` (`window.createTerminal({ pty })`); the process's own stdout/stderr feed T10. Shell integration may add structure (exit codes, command boundaries) where it is available, but is never required. Windows (PowerShell) is tested separately before P1-0 ships.

## Mechanism

1. **Executor registration.** On connect, the extension opens the node-role socket (T1) and declares exec capability (caps/commands/permissions, per the protocol's handshake docs).
2. **Agent request.** The agent calls exec through the Gateway's standard exec-approvals; the Gateway routes it to the extension's node.
3. **Approval UX.** A prompt or indicator "the agent wants to run: …" with Run once / Always allow / Deny, applying T3–T8.
4. **Execution** in an extension-owned process mirrored into a pseudoterminal, per T9–T11, with output returned per T10.

## Stages

| Stage | Contents |
| --- | --- |
| MVP+ (optional) | Manual mode: the chat shows the command request, the user runs it themselves, a button sends the output to the agent |
| v1 (full P1-0) | Automatic exec with approvals per T3–T8, and output streaming |
| v2 | Background tasks (dev servers) in `/tasks`, several parallel terminals, multiple workspaces |

## Relation to deployment topologies

The bridge serves the "repo on the local machine" case. When the repo sits next to the Gateway (topology B in the [roadmap](../roadmap.md#5-deployment-topologies)) the agent runs commands there itself and no bridge is needed. Remote-SSH (topology A) remains the preferred path where available.

## Open questions

1. Which files a command "loads" (T6) — how far to follow `package.json` scripts, config files and imports before declaring the identity unresolvable (T8).
2. Where the immutable snapshots of T7 live, and how they are garbage-collected.
3. How a node-role pairing request is presented to the user alongside the existing operator pairing flow.
