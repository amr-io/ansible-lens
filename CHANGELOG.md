# Changelog

All notable changes to **Ansible Lens** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-20

### Added

- **Monorepo & OSS Governance:**
  - Initialized npm workspace monorepo (`packages/core`, `packages/server`, `packages/client`, `scripts/metadata-builder`) with strict TypeScript, flat ESLint (`--max-warnings=0`), Prettier, Vitest (`>= 80%` coverage thresholds), `commitlint`, and `husky`.
  - Added `LICENSE` (MIT), `CODE_OF_CONDUCT.md`, `SECURITY.md`, `ARCHITECTURE.md`, and Architecture Decision Records (`docs/adr/0001` through `0004`).
- **Core Fault-Tolerant Parser (`@ansible-lens/core`):**
  - Implemented YAML Concrete Syntax Tree (CST) + AST parser (`yaml` with `keepSourceTokens: true`) preserving 0-indexed source ranges on half-typed documents.
  - Added fault-tolerant Jinja2 lexical scanner supporting `{{ ... }}`, `{% ... %}`, `{# ... #}`, and implicit conditional expressions (`when`, `changed_when`, `failed_when`, `until`).
  - Added Ansible document classifier (`playbook`, `tasks`, `handlers`, `role-vars`, `role-defaults`, `group-vars`, `host-vars`, `inventory`).
- **Static Metadata Pack Engine (`@ansible-lens/core` & `@ansible-lens/metadata-builder`):**
  - Defined `.json.gz` collection metadata pack format, SHA-256 `manifest.json` verification, and offline-bundled `ansible.builtin` pack support.
  - Added lazy-download support for Top 10 Galaxy collections (`ansible.posix`, `community.general`, `community.docker`, `community.crypto`, `ansible.windows`, `amazon.aws`, `kubernetes.core`, `community.mysql`, `community.postgresql`, `ansible.utils`) and static `.py` `DOCUMENTATION`/`RETURN` docstring extraction.
- **Workspace Intelligence (`@ansible-lens/core`):**
  - Added `register:` return-value type inference with `loop:` / `with_*:` `.results[]` and `item` wrapping.
  - Added 22-level cross-file variable precedence graph indexing role defaults/vars, `group_vars`, `host_vars`, inventory, play/block/task vars, `set_fact`, and `register`.
  - Added workspace project integrity checker (`missing-role`, `missing-role-tasks`, `missing-handler`, `missing-src-file`, `unknown-inventory-host`).
- **Clean-Room MIT Linter & Quick-Fixes (`@ansible-lens/core`):**
  - Implemented static lint rules (`unknown-module`, `unknown-param`, `missing-required-param`, `invalid-choice`, `param-type-mismatch`, `fqcn`, `name-missing`, `no-changed-when`, `command-instead-of-module`, `package-latest`, `risky-file-permissions`, `deprecated-module`, `hardcoded-secret`, `yaml-truthy`, `duplicate-keys`) with 1-click Quick-Fix code actions under a `< 20ms` 300-line playbook latency budget.
- **LSP Server & VS Code Extension (`@ansible-lens/server`, `ansible-lens`):**
  - Implemented LSP server supporting Hover, Completion, Go-to-Definition, Find References, DocumentLink, Diagnostics, and CodeAction.
  - Implemented thin VS Code client with Smart Hybrid Activation (coexisting cleanly with `redhat.vscode-yaml`), MIT Jinja2 TextMate injection grammar, custom lens icon, and `.vsix` packaging.
- **CI/CD & Documentation:**
  - Added SHA-pinned GitHub Actions workflows (`ci.yml`, `codeql.yml`, `build-metadata.yml`, `release.yml`), `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, and `THIRD_PARTY_NOTICES.md`.

[Unreleased]: https://github.com/amr-vibe/ansible-lens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/amr-vibe/ansible-lens/releases/tag/v0.1.0
