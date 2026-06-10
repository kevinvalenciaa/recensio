## What & why

<!-- One or two sentences: what this PR does and the problem it solves. -->

## Code quality standards

All boxes must be checked (or explained) before merge:

- [ ] New or changed behavior is covered by tests (`npm test` passes)
- [ ] `npm run typecheck` and `npm run lint` pass
- [ ] `dist/` was rebuilt (`npm run build`) and committed if any `src/` or `prompts/` file changed
- [ ] No debug logging, commented-out code, or TODOs without an issue link
- [ ] Errors are handled — no swallowed exceptions or bare `catch {}`
- [ ] README/docs updated for any user-facing change (inputs, CLI flags, behavior)

## How was this verified?

<!-- Commands run, test names, or a CLI dry-run transcript. -->
