# Changelog

All notable changes to **Ansible Lens** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-11-21

### Added

- **Variable Intelligence Lint Rules & Quick-Fixes (`@ansible-lens/core`, `@ansible-lens/server`):**
  - Added `undefined-variable` rule detecting typos in Jinja2 variables across playbooks, tasks, and `.j2` templates against the 22-level workspace variable graph, with smart zero-noise exclusions (`item`, `ansible_loop`, custom `loop_control.loop_var`, Ansible magic variables, `ansible_*` facts, Jinja2 keywords/builtins, `{% for %}` / `{% set %}` locals, `| default(...)` / `| d(...)`, `is defined` / `is not defined`, and `ansibleLens.lint.extraVars`) and a 1-click Levenshtein _"Did you mean `<var>`?"_ Quick-Fix.
  - Added `var-naming[no-role-prefix]` rule warning when variables in `roles/<role>/defaults/`, `roles/<role>/vars/`, or `register:` / `set_fact:` inside `roles/<role>/tasks/` lack the `<role>_` prefix, with a 1-click Quick-Fix to prepend `<role>_`.
- **`.j2` Template Intelligence, `vars_files:` Traversal & Smart `{{ | }}` Auto-Space (`@ansible-lens/core`, `@ansible-lens/server`, `ansible-lens`):**
  - Followed relative paths in `vars_files:` (e.g. `../../versions.yml` in `playbooks/site.yml`) and `include_vars:` during workspace indexing so shared external YAML variable files feed into role defaults, tasks, and `.j2` templates.
  - Activated LSP completions, 22-level variable precedence hover, registered return-field completions, Go-to-Definition, and `undefined-variable` linting inside `*.j2` template files.
  - Added Smart `{{ | }}` Auto-Space (`ansibleLens.jinja.autoSpaceBraces`, default `true`): pressing `Space` inside `{{|}}` pads both sides to `{{ | }}` keeping the cursor centered; pressing `Backspace` inside empty `{{ | }}` deletes both spaces back to `{{|}}`.
- **Silent Collection Auto-Download, Expanded Settings & Diagnostics Helper (`ansible-lens`, `@ansible-lens/server`):**
  - Added background auto-download of unloaded collection metadata packs (e.g. `ansible.posix.json.gz`) on first FQCN encounter (`ansibleLens.metadata.autoDownload`, default `true`) with SHA-256 verification, status-bar spinner, and automatic diagnostic refresh.
  - Expanded `contributes.configuration` with `ansibleLens.lint.enabled`, `ansibleLens.lint.profile` (`minimal`/`basic`/`moderate`/`production`), `ansibleLens.lint.rules`, `ansibleLens.lint.extraVars`, `ansibleLens.metadata.autoDownload`, `ansibleLens.metadata.manifestUrl`, `ansibleLens.jinja.autoSpaceBraces`, and `ansibleLens.ansible.rootPaths`, wired live via `workspace/didChangeConfiguration`.
  - Added `Ansible Lens: Copy Diagnostics Info` (`ansibleLens.copyDiagnosticsInfo`) command and ignored `node_modules/`, `.git/`, `.venv/`, `__pycache__/`, and `dist/` during workspace scanning.
- **Pylance-Style `Ctrl+Click` Module Docs & Nested Monorepo Support:**
  - Added read-only `ansible-lens-docs:` `TextDocumentContentProvider` and module `DefinitionProvider` so `Ctrl+Click` on any module name opens rendered Markdown documentation with a clickable `docs.ansible.com` link and zero permanent underlines (`ansibleLens.documentLinks.enabled` defaults to `false`).
  - Added upward `ansible.cfg` (`roles_path`, `inventory`) and directory-marker discovery for nested monorepos, full 90+ collection metadata release dumping, and headless VS Code E2E tests (`@vscode/test-electron`) in CI on Ubuntu and Windows.
- **Documentation & Release Automation:**
  - Added `docs/rules.md`, `docs/configuration.md`, `docs/troubleshooting.md`, `.github/release.yml`, `galleryBanner` in `packages/client/package.json`, and a tag/version-sync guard in `.github/workflows/release.yml`.

### Fixed

- **`notify:` Go-to-Definition Leak & Multi-Word Highlight (`@ansible-lens/server`):**
  - Stopped matching `- name:` lines or falling back to `notifyNames[0]`; handler definitions now resolve strictly when the cursor is inside a `notify:` handler value (excluding `notify:` key, `- name:`, and `# comments`) and return LSP `LocationLink[]` with `originSelectionRange` spanning the entire multi-word handler name.
- **Completions After `.` & Multi-Line `when:` Lists (`@ansible-lens/server`):**
  - Attached explicit `textEdit` replacement ranges after `.`, fixed nested partial prefix completion (`webapp_version_file.stat.e`), and walked upward through multi-line `when:` / `changed_when:` / `failed_when:` YAML sequence items.

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

[Unreleased]: https://github.com/amr-vibe/ansible-lens/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/amr-vibe/ansible-lens/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/amr-vibe/ansible-lens/releases/tag/v0.1.0
