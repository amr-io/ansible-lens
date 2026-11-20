# Ansible Lens — Senior Software Engineering Standards

Every agent (coordinator and all `/teamwork` workers) MUST strictly follow these standards. No PR may be merged if any rule below is violated.

## 1. Git, Branching, Commits & Releases
- **Conventional Commits 1.0.0 (STRICT):** Every commit message and PR title MUST follow `<type>(<scope>): <subject>` (e.g., `feat(core): add register return-value inference`, `fix(parser): handle unquoted jinja in mapping values`, `test(linter): add edge cases for fqcn quick-fix`, `ci(actions): add ubuntu/windows test matrix`). Allowed types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `ci`, `build`, `chore`. Enforce automatically with `commitlint` + `husky` (and in CI).
- **Atomic Commits:** Each commit must be focused, buildable, and pass tests on its own. Never commit WIP dumps or giant all-in-one commits directly to `main`.
- **Branch Naming:** `feat/<issue-id>-<slug>`, `fix/<issue-id>-<slug>`, `ci/<slug>`, `docs/<slug>`.
- **GitHub Flow & Traceability:** Every piece of work starts from a GitHub Issue (with Labels + `v0.1.0-mvp` Milestone). Every PR must use `.github/PULL_REQUEST_TEMPLATE.md`, link its issue (`Closes #N`), include test/verification output, and pass independent `qa-reviewer` review before merging.
- **Versioning & Changelog:** Follow **SemVer 2.0.0** and **Keep a Changelog** (`CHANGELOG.md`).
- **Line Endings & Formatting:** Enforce `.editorconfig` and `.gitattributes` (`* text=auto eol=lf`) so Windows and Linux contributors never hit CRLF diff noise.

## 2. Architecture, SOLID & TypeScript Discipline
- **Clean Architecture & Unidirectional Dependencies:**
  - `packages/core`: Pure TypeScript domain engine — **ZERO `vscode` imports**.
  - `packages/server`: LSP server wrapping `packages/core`.
  - `packages/client`: Thin VS Code extension client.
  - `scripts/metadata-builder`: Build-time metadata pack generator.
  - Dependency flow is strictly `client -> server -> core`. Never invert it.
- **SOLID & Clean Code:**
  - Small, cohesive, single-responsibility modules and pure functions.
  - Dependency injection for filesystem, network/fetch, clock, and cache so all core logic is 100% deterministic and testable offline.
  - Discriminated unions and explicit domain types. **Zero `any`**, **zero `@ts-ignore` / `@ts-expect-error`** (unless justified with an inline explanation), **zero silent empty `catch {}` blocks**.
- **Strict Compiler & Linting:**
  - `tsconfig.base.json`: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"noImplicitOverride": true`, `"noFallthroughCasesInSwitch": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`.
  - Flat ESLint (`typescript-eslint` strict) + Prettier, enforced with `--max-warnings=0`.
- **Observability & Graceful Degradation:**
  - Use a structured logger routed to VS Code's OutputChannel (never leave raw `console.log` in production code).
  - Malformed/incomplete YAML, broken Jinja2, missing `ansible.cfg`, or offline networks must **never** crash the LSP server.

## 3. Testing Pyramid & Performance Budgets
- **Unit Tests (Vitest):** Comprehensive positive, negative, and edge-case tests (Windows CRLF paths, Unicode, nested `suboptions`, `register:` + `loop:`, 22-level variable precedence, circular role deps, every lint rule + quick-fix). Enforce **>= 80% line & branch coverage** on `packages/core`.
- **Resilience / Fuzz Tests:** Feed malformed, half-typed, and adversarial YAML+Jinja strings to the parser and linter and assert zero unhandled exceptions.
- **LSP Integration Tests:** Spin up the compiled LSP server against `test/fixtures/sample-ansible-project/` and assert real protocol responses (Hover, Completion, Definition, References, DocumentLink, Diagnostics, CodeAction).
- **Performance Budget:** Zero Python, zero WSL, zero Docker, zero external subprocesses during editing. Include an automated benchmark test asserting parse + lint on a 300-line playbook completes in **< 20ms**.

## 4. Security, Supply Chain, Licensing & Trademark Hygiene
- **MIT License Purity (STRICT):** Our repo is MIT-licensed. You MAY study/adapt MIT-licensed code (e.g., TextMate grammars from `ansible/vscode-ansible`) with attribution in `THIRD_PARTY_NOTICES.md`. You MUST **NEVER** copy or port code from GPL-licensed repos (`ansible/ansible-lint`, `ansible/ansible`). Implement all lint rules clean-room from public docs.
- **Security & DevOps Supply-Chain Hardening:**
  - Verify SHA-256 hashes of downloaded metadata packs against `manifest.json`; validate parsed JSON schemas; never `eval()` or execute untrusted YAML/Jinja/Python.
  - **GitHub Actions Latest SHA Pinning (STRICT):** Look up the **latest released version** of every third-party GitHub Action (`actions/checkout`, `actions/setup-node`, `actions/setup-python`, `actions/upload-artifact`, `github/codeql-action`, `softprops/action-gh-release`, etc.) and pin EVERY `uses:` to its **full 40-character commit SHA** with an inline version comment (e.g., `uses: actions/checkout@<40-char-sha> # v4.x.x`).
  - Set explicit least-privilege `permissions:` at workflow/job level, configure `concurrency:` groups with `cancel-in-progress: true` on PRs, include **CodeQL** (`codeql.yml`), **Dependabot** (`npm` + `github-actions` weekly), **Commitlint CI** check, and `npm audit --audit-level=high`.
  - **Releases (`release.yml`):** GitHub Releases ONLY (do NOT auto-publish to VS Code Marketplace or Open VSX — the repo owner publishes manually). On `v*` tags, build `.vsix` + generate `SHA256SUMS.txt` and attach both to the GitHub Release using built-in `GITHUB_TOKEN` (zero external secrets required).
- **Branding & Trademark:** Project name is **Ansible Lens** (`ansible-lens`). Create an original custom lens SVG/PNG icon (NEVER reuse Red Hat's Ansible logo). Include this exact disclaimer in `README.md` and `package.json`:
  *"Ansible Lens is an independent, community-built extension and is not affiliated with or endorsed by Red Hat, Inc. Ansible® is a registered trademark of Red Hat, Inc."*

## 5. Documentation & Open-Source Governance
- Write **Architecture Decision Records** (`docs/adr/0001-*.md`, `0002-*.md`, ...) for major design choices (static metadata packs, fault-tolerant YAML+Jinja CST parsing, YAML coexistence strategy).
- Add **TSDoc/JSDoc** comments on all exported APIs, interfaces, and non-obvious algorithms.
- Maintain `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `SECURITY.md`, `LICENSE` (MIT), `THIRD_PARTY_NOTICES.md`, `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`, and `.github/dependabot.yml`.
