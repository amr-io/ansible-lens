# Engineering Standards & Non-Negotiable Rules

1. **Architecture & Clean Code:**
   - Strict TypeScript (`"strict": true`, `noUncheckedIndexedAccess`, `noImplicitOverride`). Zero `any` unless justified with a comment.
   - Clean modular architecture: separate `packages/core` (pure TS parser, metadata loader, type/variable resolver, linter — zero `vscode` runtime imports), `packages/server` (LSP server), `packages/client` (VS Code extension client), and `scripts/metadata-builder` (GitHub Actions metadata generator).
   - Pure functions and dependency injection everywhere so all core logic is unit-testable without launching VS Code.

2. **License & Trademark Hygiene (STRICT):**
   - Our repo is MIT-licensed.
   - You MAY inspect/adapt MIT-licensed code (e.g., TextMate grammars from `ansible/vscode-ansible`) with proper attribution in `THIRD_PARTY_NOTICES.md`.
   - You MUST NEVER copy or port code from GPL-licensed repos (`ansible/ansible-lint`, `ansible/ansible`). Implement all lint rules clean-room in TypeScript from public documentation.
   - **Branding & Trademark:** Project name is **Ansible Lens** (`ansible-lens`). Create an original SVG/PNG lens icon (NEVER reuse Red Hat's Ansible logo). Include this exact disclaimer in `README.md` and `package.json` description: *"Ansible Lens is an independent, community-built extension and is not affiliated with or endorsed by Red Hat, Inc. Ansible® is a registered trademark of Red Hat, Inc."*

3. **Performance Budgets:**
   - Zero Python, zero WSL, zero Docker required at runtime. Must work natively on Windows, macOS, and Linux.
   - Single-file parse + lint + diagnostics must complete in < 20ms on a 300-line playbook.
   - Never spawn external subprocesses during typing.

4. **Testing & Verification Gates (No Claiming Done Without Proof):**
   - Unit tests (Vitest) for: YAML+Jinja tolerant parser, module/param schema validator, `register:` + `loop:` return-value inference, cross-file variable graph + precedence, `site.yml`/role/handler/template integrity checker, and every single lint rule (positive + negative + quick-fix cases).
   - LSP integration tests verifying hover, completion, go-to-definition, document links, diagnostics, and code actions end-to-end over LSP.
   - Real fixture Ansible repo under `test/fixtures/sample-ansible-project/` covering valid playbooks, broken roles, broken handlers, `register:` + `loop:`, `group_vars`, `host_vars`, `requirements.yml`, and `site.yml`.
   - `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npx @vscode/vsce package` must ALL exit 0 with zero errors.

5. **Git & GitHub Senior-Engineer Workflow:**
   - Never dump the whole project into one giant commit on `main`.
   - Use GitHub Issues, Labels, and Milestones (`v0.1.0-mvp`) to plan and track each workstream before coding.
   - Work on clean feature branches (`feat/repo-scaffold`, `feat/core-parser-metadata`, `feat/intelligence-linter`, `feat/lsp-server`, `feat/vscode-client`, `ci/github-workflows`), using atomic Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`).
   - Open structured Pull Requests (linking `Closes #N`, summarizing architecture + test output) and merge them cleanly once local checks pass.
   - Include `.github/workflows/ci.yml` (Ubuntu + Windows matrix), `.github/workflows/build-metadata.yml` (weekly `ansible-doc --metadata-dump`), `.github/workflows/release.yml` (tag-triggered `.vsix` GitHub Release), `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/dependabot.yml`, `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, and `SECURITY.md`.
