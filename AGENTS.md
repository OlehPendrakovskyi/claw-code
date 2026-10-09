# Instructions for coding agents

Claw Code is a VS Code extension for OpenClaw (TypeScript strict, esbuild, Vitest, oxlint, pnpm).

Before changing code or docs, read:

- [docs/development-rules.md](docs/development-rules.md) — binding rules, cited by ID (`R1`–`R70`, `S1`–`S6`). The highest-impact ones: never invent a protocol or API (R24); revalidate after every `await` (R2); never log secrets, prompts or file contents (R10); every fix ships a regression test that fails without it (R7, R49).
- [docs/engineering.md](docs/engineering.md) — stack, code structure, logging, PR policy and CI.
- [docs/roadmap.md](docs/roadmap.md) — what is planned, by ID; [docs/design/](docs/design/) for the design of unbuilt features.

Gates, in CI's order (S6):

```sh
pnpm run typecheck
pnpm run lint
pnpm run check:rules
pnpm run compile
pnpm run test:coverage
pnpm run license:check
```

Run Vitest through `test:coverage` as above, which applies the coverage thresholds CI enforces: `pnpm run test` would repeat compile and lint through `pretest` and skip coverage.

Working rules:

- Verify every claim about the code (file, symbol, behaviour) before writing it in a comment, doc or PR (R47, R58).
- Copilot reviews follow R60: verify each finding against HEAD, reply and resolve every thread, and answer the "Previously missed" section of each review overview in one PR comment.
- English for everything on GitHub and in the repository (R21).
- New dependencies need the owner's approval and must pass the licence allowlist ([engineering.md §6](docs/engineering.md#6-cicd)).
