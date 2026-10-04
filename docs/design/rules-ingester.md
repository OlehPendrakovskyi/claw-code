# Design: Project Rules Ingester

Covers roadmap item **A-11**. Status: design, not implemented; scheduled after v2 as a separate track because it depends on the Gateway's memory-wiki. Back to the [roadmap](../roadmap.md).

## Problem

Projects carry their conventions in standard files — `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.github/copilot-instructions.md`, `CONTRIBUTING.md`, `docs/adr`. The ingester scans a repository for them and publishes the rules to the user's memory-wiki, with provenance and a project binding, so every Gateway agent recalls them when a session for that project starts. It is part of the extension, not a separate product, and it adds the `/conventions` slash command.

## Project binding

The project key is resolved in this order:

1. **Git remote URL** (normalised `origin`) — the primary key; it survives renames and works when the repo is cloned elsewhere.
2. **Explicit alias** (`project: <name>`) — a manual override, required for non-git projects (proprietary configurations, legacy repos).
3. **Path / folder name** — the fallback when there is no git.

**Recall:** at session start, or when an agent is selected, the extension resolves the key (git remote → alias from settings → path) and adds the matching rules to the context.

## Format catalogue

Configurable, not hard-coded: `AGENTS.md`, `CLAUDE.md` / `.claude/*.md`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `.windsurfrules`, `.clinerules`, `CONTRIBUTING.md`, `docs/adr/*.md`, `README#Architecture`, plus custom globs.

Extraction is a faithful copy of the text with provenance (file + lines). LLM compression is optional; the raw text is always stored.

Domain-specific formats (for example `.bsl` files or proprietary LSP servers) belong in user profiles (A-10), not in the core. The core is format-agnostic.

## Lifecycle

1. Ingest on request (`/conventions ingest`), or on first contact with the repository when the Gateway is local (see *Privacy*).
2. Wiki synthesis with project metadata.
3. A fingerprint (a hash of the source files).
4. On change: a proposed update diff — **never a silent update**.
5. Export back (opt-in): write rules from the wiki into the repository's `AGENTS.md`, which makes the project useful to any agent.

## Privacy

Rules are stored in the user's memory-wiki vault, which lives **on the configured Gateway**. With a local Gateway they stay on the machine; with a Gateway on a NAS or server (roadmap §5) the raw rule text is sent to that host. The extension sends them nowhere else and has no telemetry. The ingest prompt names the Gateway host as the destination before anything is uploaded, and ingest is always explicit (never automatic) for a non-loopback Gateway.

## Slash commands

| Command | Effect |
| --- | --- |
| `/conventions` | Show or update the project's rules |
| `/conventions ingest` | Scan the current workspace |

## Open questions

1. The memory-wiki API the extension calls, and whether it is reachable with operator scopes.
2. Multi-root workspaces: one project key per folder, or one per window.
