## Summary

<!-- What changes and why. Link the roadmap item or issue. -->

## Checklist

Rules are in `docs/development-rules.md`; tick what applies, strike out what does not.

- [ ] CI gates pass locally, in CI's order: `pnpm run typecheck`, `pnpm run lint`, `pnpm run lint:types`, `pnpm run check:rules`, `pnpm run compile`, `pnpm exec vitest run`, `pnpm run license:check` (S6)
- [ ] Every fix ships a regression test that fails without it; a behaviour change has a test for its new boundary (R7, R34, R49)
- [ ] Async code revalidates after every `await`, with a generation or ownership check (R2, R3)
- [ ] Teardown retires only the owner's own registration (R1, R16, R17, R23)
- [ ] No secrets, prompts or file contents reach a log or any other egress surface (R10, R35)
- [ ] Paths are canonicalised and contained on resolve and on read (R6)
- [ ] External contracts come from documentation or source, not guesses (R24)
- [ ] Comments and docs claim only what the code does; status claims cite the code (R47, R58)
- [ ] A removed tool or dependency is no longer named anywhere (R55)
- [ ] A new rule learned in this PR is added to the rules file (R20)
