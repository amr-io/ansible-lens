# Contributing to Ansible Lens

Thank you for contributing to **Ansible Lens**! Please review these engineering, testing, and licensing guidelines before opening a pull request.

> _Ansible Lens is an independent, community-built extension and is not affiliated with or endorsed by Red Hat, Inc. Ansible® is a registered trademark of Red Hat, Inc._

---

## 1. Monorepo Setup

Ansible Lens uses npm workspaces with unidirectional dependency boundaries:

```text
packages/client  ->  packages/server  ->  packages/core
scripts/metadata-builder  ->  packages/core
```

- `packages/core`: Pure TypeScript domain engine (**NO `vscode` or `vscode-languageserver*` imports**). All filesystem, network, clock, and cache I/O must be injected via interfaces so core logic remains 100% deterministic offline.
- `packages/server`: LSP server (`vscode-languageserver`) wrapping `@ansible-lens/core`.
- `packages/client`: Thin VS Code extension client (`Smart Hybrid Activation` + Jinja2 injection grammar).
- `scripts/metadata-builder`: Build-time metadata pack generator (`ansible-doc --metadata-dump`).

### Local Development Commands

```bash
npm ci                 # Install all workspace dependencies
npm run build          # Build packages/core, packages/server, packages/client, scripts/metadata-builder
npm run typecheck      # Run strict tsc --noEmit
npm run lint           # Run flat ESLint with --max-warnings=0
npm run format:check   # Verify Prettier formatting
npm test               # Run Vitest unit, fuzz, performance (<20ms), and LSP integration tests with coverage
npm run package:vsix   # Build ansible-lens-<version>.vsix in packages/client/
```

---

## 2. Branch Naming & Conventional Commits 1.0.0

### Branch Naming

- Features: `feat/<issue-id>-<slug>`
- Bug fixes: `fix/<issue-id>-<slug>`
- CI / DevOps: `ci/<slug>`
- Documentation: `docs/<slug>`

### Commit Message Format (Enforced by `commitlint` + `husky`)

Every commit message and PR title **must** strictly follow **Conventional Commits 1.0.0** with a required non-empty scope:

```text
<type>(<scope>): <subject>
```

- **Allowed types:** `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `ci`, `build`, `chore`
- **Examples:**
  - `feat(core): add register return-value inference for loop tasks`
  - `fix(parser): handle unclosed jinja expressions in mapping values`
  - `test(linter): add fuzz tests for malformed playbook YAML`
  - `ci(workflows): pin github actions to immutable 40-char commit SHAs`
  - `docs(repo): update lint rule catalog in README`

Keep commits **atomic**: each commit should be focused, buildable, and pass `npm run typecheck`, `npm run lint`, and `npm test`.

---

## 3. Code Quality, Coverage & Performance Budgets

- **Strict TypeScript (`tsconfig.base.json`):** `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `noImplicitOverride: true`, `noFallthroughCasesInSwitch: true`, `noUnusedLocals: true`, `noUnusedParameters: true`.
- **No `any` & No Silent Catches:** ESLint enforces `@typescript-eslint/no-explicit-any: error`, `no-empty: error` (no empty `catch {}`), and `--max-warnings=0`. Do not use `@ts-ignore` or `@ts-expect-error` without an explicit inline justification.
- **Line Endings:** LF (`\n`) is enforced via `.editorconfig` and `.gitattributes` (`* text=auto eol=lf`).
- **Test Coverage (`>= 80%`):** `packages/core` must maintain **at least 80% line, branch, function, and statement coverage** under `vitest run --coverage`. Include positive, negative, Windows CRLF path, Unicode, fuzz/resilience, and LSP integration tests where applicable.
- **Performance Budget (`< 20ms`):** No Python, WSL, Docker, or external subprocesses during editing. Parsing and linting a 300-line playbook must complete in **< 20ms** in the automated benchmark suite.

---

## 4. Clean-Room MIT License Purity (STRICT)

Ansible Lens is licensed under the **MIT License**.

- **NEVER** copy, translate, or derive code from GPL-licensed repositories (such as `ansible/ansible` or `ansible/ansible-lint`).
- Implement all lint rules, parsers, and Quick-Fixes **clean-room** from publicly documented Ansible module specifications and YAML 1.2 standards.
- If adapting any MIT-licensed resource (for example, TextMate grammar scopes from `ansible/vscode-ansible`), document the attribution in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
- Never use Red Hat's Ansible logo; use only original Ansible Lens branding.

---

## 5. Pull Request Checklist

Every PR must use `.github/PULL_REQUEST_TEMPLATE.md`, link a GitHub Issue (`Closes #N`), include local verification output, and pass all CI checks:

- [ ] Conventional Commits (`<type>(<scope>): <subject>`) verified by `commitlint`
- [ ] Unidirectional architecture respected (`client -> server -> core`, no `vscode` imports in `packages/core`)
- [ ] `npm run build && npm run typecheck && npm run lint && npm run format:check` pass with no errors/warnings
- [ ] `npm test` passes with `>= 80%` coverage on `packages/core` and `< 20ms` playbook parse+lint benchmark
- [ ] 100% MIT clean-room compliance verified
