# Design: Project Rules Ingester

Covers roadmap item **A-11**. Status: design, not implemented; scheduled after v2 as a separate track because it depends on the Gateway's memory-wiki. Back to the [roadmap](../roadmap.md).

## Problem

Projects carry their conventions in standard files — `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.github/copilot-instructions.md`, `CONTRIBUTING.md`, `docs/adr`. The ingester scans a repository for them and publishes the rules to the user's memory-wiki, with provenance and a project binding, so every Gateway agent recalls them when a session for that project starts. It is part of the extension, not a separate product, and it adds the `/conventions` slash command.

## Project binding

The project key is resolved in this order:

1. **Explicit alias** (`project: <name>`) — a manual override that takes precedence over everything else when set. Alias bindings live only in **extension-managed user state** (`globalState`), keyed by the workspace's own identity (its canonical remote key or canonical path key, below) — never in workspace settings, which an untrusted repository controls. A repository that asks for an alias (for example through a file it ships) is honoured only after the user confirms the binding once, and only in a trusted workspace. Recommended for non-git projects (proprietary configurations, legacy repos), because it is the only key that follows such a project across folders and machines.
2. **Git remote, as a credential-free canonical key** — the default key when no alias is set; it works when the repository is cloned to another folder or machine. The raw remote URL is never stored or sent, because it can carry credentials (`https://user:token@host/repo.git`). The key is derived as: drop the userinfo, query and fragment; reduce `ssh://` and scp-style (`git@host:owner/repo`) forms to the same `host/owner/repo` shape; lower-case the host; strip a trailing `.git`. The result is, for example, `github.com/owner/repo`. A URL-derived key does **not** survive a repository rename or transfer; where rename stability matters, the user can opt in to an immutable repository ID provided by the host (for example GitHub's repository node ID), and the alias above remains the manual way to re-attach rules to a renamed repository.
3. **Canonical path key** — the fallback for a project with neither an alias nor a git remote. It is `path:<install-id>:<hash>`, where `<hash>` is the SHA-256 of the workspace folder's canonical path (`realpath`, with case folded on case-insensitive filesystems) and `<install-id>` is a random identifier generated once per VS Code installation and kept in the extension's storage. That makes the key collision-resistant across folders and machines, and keeps the raw path out of the key. It is deliberately local: the same folder on another machine gets a different key, and an alias is the way to share rules between them.

**Recall:** at session start, or when an agent is selected, the extension resolves the key (alias bound in user state → git remote → path) and adds the matching rules to the context — subject to the trust rule below.

**Trust rule for recall.** The git remote is repository-controlled metadata: a malicious workspace can set its `origin` to another project's URL, and an alias can be requested by repository content. So a remote-derived key (and a repository-requested alias) is only a *candidate*. Rules are recalled automatically only when (a) the workspace is trusted (VS Code Workspace Trust) and (b) the user has approved the binding *this workspace → this project key* once; the approval is stored in extension-managed user state (`globalState`), keyed by the workspace's canonical path key. Otherwise the extension shows which project's rules would apply and asks before recalling them. The canonical path key needs no approval: it is derived from where the user put the folder, not from anything the repository declares. An authenticated immutable repository ID from the host (key 2) may replace the one-time approval once the extension can verify it.

## Format catalogue

Configurable, not hard-coded: `AGENTS.md`, `CLAUDE.md` / `.claude/*.md`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `.windsurfrules`, `.clinerules`, `CONTRIBUTING.md`, `docs/adr/*.md`, `README#Architecture`, plus custom globs.

Extraction is a faithful copy of the text with provenance (file + lines). LLM compression is optional; the raw text is always stored.

Domain-specific formats (for example `.bsl` files or proprietary LSP servers) belong in user profiles (A-10), not in the core. The core is format-agnostic.

## Lifecycle

1. Ingest on request (`/conventions ingest`). On first contact with a repository the extension may **offer** to ingest, but never ingests without the user's confirmation (see *Privacy*).
2. Wiki synthesis with project metadata.
3. A fingerprint (a hash of the source files).
4. On change: a proposed update diff — **never a silent update**.
5. Export back (opt-in): write rules from the wiki into the repository's `AGENTS.md`, which makes the project useful to any agent.

## Privacy

Rules are stored in the user's memory-wiki vault, which lives **on the configured Gateway**. With a local Gateway they stay on the machine; with a Gateway on a NAS or server (roadmap §5) the raw rule text is sent to that host. The extension sends them nowhere else and has no telemetry. Every ingest asks for confirmation and names the Gateway as the destination. A loopback URL is **not** treated as proof that the Gateway is local — an SSH port forward or tunnel exposes a remote Gateway as `127.0.0.1` — so the confirmation can be skipped only if the Gateway itself provides a trustworthy locality signal, which it does not today.

## Slash commands

| Command | Effect |
| --- | --- |
| `/conventions` | Show or update the project's rules |
| `/conventions ingest` | Scan the current workspace |

## Open questions

1. The memory-wiki API the extension calls, and whether it is reachable with operator scopes.
2. Multi-root workspaces: one project key per folder, or one per window.
