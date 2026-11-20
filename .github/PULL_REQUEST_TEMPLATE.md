## Summary

<!-- Briefly describe what this PR implements or fixes. -->

Closes #

## Architectural & Engineering Checklist

- [ ] Follows **Conventional Commits 1.0.0** (`<type>(<scope>): <subject>`)
- [ ] Respects unidirectional dependency flow (`client -> server -> core`, zero `vscode` imports in `packages/core`)
- [ ] Zero `any`, zero silent `catch {}`, strict TypeScript (`npm run typecheck` exits 0)
- [ ] Flat ESLint passes with `--max-warnings=0` (`npm run lint` exits 0)
- [ ] Unit, resilience/fuzz, performance (`< 20ms`), and/or integration tests added (`npm test` passes with >= 80% coverage on `packages/core`)
- [ ] 100% MIT license purity (zero GPL-derived code)

## Verification Output

```text
<!-- Paste test, typecheck, and lint output here -->
```
