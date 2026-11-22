# Ansible Lens — System Architecture

> *Ansible Lens is an independent, community-built extension and is not affiliated with or endorsed by Red Hat, Inc. Ansible® is a registered trademark of Red Hat, Inc.*

## 1. Architectural Vision

**Ansible Lens** (`ansible-lens`) is a standalone, cross-platform, static-metadata Ansible Language Server & VS Code Extension written in pure TypeScript. Unlike traditional Ansible extensions that rely on a local Python runtime, `ansible-core`, `ansible-lint`, WSL, or Docker containers, Ansible Lens runs natively on Windows, macOS, and Linux in pure Node.js/TypeScript with **< 20ms** parse + lint latency.

## 2. Monorepo Structure & Unidirectional Dependency Flow

```
ansible-lens/
├── packages/
│   ├── core/                 # Pure TypeScript domain engine (NO vscode imports)
│   │   └── src/
│   │       ├── contracts/    # Shared domain types, AST nodes, metadata & lint schemas
│   │       ├── parser/       # Fault-tolerant YAML CST + Jinja2 tokenizer & AST mapper
│   │       ├── metadata/     # Bundled & cached .json.gz pack loader, SHA-256 verifier, .py extractor
│   │       ├── intelligence/ # Return-value type inference, 22-level variable graph, integrity checker
│   │       └── linter/       # Clean-room MIT static linter & Quick-Fix engine
│   ├── server/               # Language Server Protocol (vscode-languageserver) wrapping @ansible-lens/core
│   └── client/               # Thin VS Code Extension client + Smart Hybrid Activation + Jinja2 injection grammar
└── scripts/
    └── metadata-builder/     # Build-time CLI generating compressed collection metadata packs via ansible-doc
```

### Dependency Rules
- `packages/client` -> `packages/server` -> `packages/core`
- `packages/core` MUST NEVER import `vscode` or `vscode-languageserver*`.
- All external I/O (filesystem, network fetch, clock, cache directory) in `packages/core` is injected via interfaces for deterministic offline unit testing.

## 3. Core Subsystems

### 3.1 Fault-Tolerant YAML + Jinja2 CST Parser (`packages/core/src/parser`)
- Uses `yaml` in Concrete Syntax Tree (CST) + AST mode with `keepSourceTokens: true` and `strict: false` so half-typed documents still produce a rich syntax tree with exact 0-indexed line/column/offset ranges.
- Tokenizes embedded Jinja2 expressions (`{{ ... }}`), statements (`{% ... %}`), comments (`{# ... #}`), and implicit Jinja expressions inside `when:`, `changed_when:`, `failed_when:`, and `until:`.
- Classifies Ansible document kinds (`playbook`, `tasks`, `handlers`, `role-vars`, `group-vars`, `host-vars`, `inventory`, `unknown`) and extracts structured `PlayNode`, `TaskNode`, `BlockNode`, `VariableDeclNode`, and `JinjaExpressionNode` objects.

### 3.2 Static Metadata Pack Engine (`packages/core/src/metadata`)
- Bundles `ansible.builtin.json.gz` out of the box (generated at build time from `ansible-doc -t module --metadata-dump`).
- Lazy-downloads and caches Top 10 Galaxy collection `.json.gz` packs (`ansible.posix`, `community.general`, `community.docker`, `community.crypto`, `ansible.windows`, `amazon.aws`, `kubernetes.core`, `community.mysql`, `community.postgresql`, `ansible.utils`) with SHA-256 verification against `manifest.json`.
- Extracts `DOCUMENTATION` and `RETURN` YAML docstrings directly from local `.py` module files in workspace `collections/` or `library/` directories without executing Python.

### 3.3 Workspace Intelligence (`packages/core/src/intelligence`)
- **Return-Value Type Inference:** Tracks `register: varName` on tasks, binds `varName` to the module's `RETURN` schema plus common task return keys (`failed`, `changed`, `skipped`, `rc`, `stdout`, `stdout_lines`, `stderr`, `stderr_lines`, `msg`), and wraps `loop:` / `with_*:` tasks into `varName.results[].<field>` and `item`.
- **22-Level Variable Precedence Graph:** Indexes variables across role `defaults/main.yml`, `vars/main.yml`, `group_vars/`, `host_vars/`, `inventory`, play `vars:`, `vars_files:`, task/block `vars:`, `set_fact`, and `register`, resolving effective values and precedence rank (1–22).
- **Project Integrity Checker:** Validates role references, `tasks/main.yml` presence, `notify:` handler targets, `template`/`copy` `src:` file existence, and `hosts:` targets against inventory.

### 3.4 Clean-Room Static Linter (`packages/core/src/linter`)
- 100% MIT clean-room implementation (no GPL code).
- Rules: `unknown-module` (with Levenshtein "Did you mean?" Quick-Fix), `unknown-param`, `missing-required-param`, `invalid-choice`, `param-type-mismatch`, `fqcn` (with 1-click FQCN expansion Quick-Fix), `name-missing`, `no-changed-when`, `command-instead-of-module`, `package-latest`, `risky-file-permissions`, `deprecated-module`, `hardcoded-secret` (with `!vault` / `no_log: true` Quick-Fix), `yaml-truthy`, and `duplicate-keys`.

### 3.5 Smart Hybrid Activation (`packages/client`)
- Never hijacks Kubernetes, Docker Compose, or GitHub Actions YAML files.
- Attaches dynamically to `yaml` documents only when Ansible heuristics match (`ansible.cfg` in workspace, `roles/**`, `tasks/`, `handlers/`, `group_vars/`, `host_vars/`, `playbooks/`, `site.yml`, or top-level `- hosts:` + `tasks:`/`roles:`).
- Injects Jinja2 syntax highlighting into `source.yaml` via a lightweight MIT TextMate injection grammar.
