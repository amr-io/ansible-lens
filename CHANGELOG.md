# Changelog

All notable changes to **Ansible Lens** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Marketplace & Open VSX Metadata:** Cleaned canonical `repository.url`, routed Marketplace Q&A to GitHub Discussions, added Open VSX install instructions and multi-editor compatibility notes (VS Code, Cursor, Windsurf, VSCodium, and cloud IDEs), and added a top-of-page GitHub link to the extension README.

## [0.1.2] - 2026-11-21

### Added

- **Standard Ansible Special & Connection Variables:** Added autocomplete and hover descriptions for everyday built-in variables (`ansible_user`, `ansible_host`, `ansible_port`, `ansible_connection`, `ansible_become`, `ansible_become_user`, `ansible_become_method`, `ansible_python_interpreter`, `ansible_ssh_private_key_file`, `ansible_ssh_common_args`, `inventory_dir`, `inventory_file`, `role_name`, `ansible_role_name`, `ansible_play_name`, `ansible_play_hosts_all`, `ansible_limit`, `ansible_run_tags`, `ansible_skip_tags`, `ansible_env`, `ansible_os_family`, `ansible_distribution`, `ansible_distribution_version`, `ansible_hostname`, `ansible_fqdn`, `ansible_default_ipv4`, `ansible_architecture`, `omit`, and more).
- **Supply-Chain Verification & Benchmarks:** Releases now include SLSA Build Provenance attestations and a CycloneDX SBOM (`sbom.cdx.json`) alongside `SHA256SUMS.txt`. Added OpenSSF Scorecard analysis and a reproducible benchmark workflow comparing Ansible Lens against `ansible-lint`.
- **Marketplace Demo GIFs & Social Preview:** Added interactive demo GIFs (autocomplete, hover/docs, lint quick-fixes) to the README and Marketplace listing.

### Changed

- **Publisher & Branding:** Moved repository and Marketplace publisher to `amr-io`, refreshed the extension icon with a crisp 512×512 vector render, and polished the VS Code Settings, Features, and Changelog tabs.
- **README Overhaul:** Rewrote the README with a side-by-side comparison against `redhat.ansible`, verified benchmark numbers (~10.7 ms vs. ~2,622 ms `ansible-lint`), and a No Telemetry commitment.

### Fixed

- **Typing Responsiveness:** Debounced live diagnostics while typing and switched file-watcher updates to incremental re-indexing, triggering cross-file revalidation only when shared variable, handler, playbook, or inventory files change.
- **`openInBrowser` on `Ctrl+Hover`:** Prevented `ansibleLens.docs.ctrlClickBehavior: "openInBrowser"` from opening browser tabs during `Ctrl+Hover` previews; links now open only on click while immediately closing the temporary editor tab.
- **Full Module Highlight on `Ctrl+Hover`:** `Ctrl+Hover` on module names now highlights the entire FQCN (such as `ansible.builtin.stat`) instead of only a single dot-delimited segment.

## [0.1.1] - 2026-11-21

### Added

- **Variable Lint Rules & Quick-Fixes:**
  - Added `undefined-variable` detection across playbooks, tasks, and `.j2` templates with smart exclusions (`item`, `ansible_loop`, custom `loop_var`, magic variables, `ansible_*` facts, `{% raw %}...{% endraw %}` blocks, `| default(...)`, `is defined`, and `ansibleLens.lint.extraVars`) plus a 1-click _"Did you mean?"_ Quick-Fix.
  - Added `var-naming[no-role-prefix]` for role `defaults/`, `vars/`, `register:`, and `set_fact:` declarations with a 1-click prefix Quick-Fix.
- **`.j2` Template Intelligence & `vars_files:` Traversal:** Added completions, 22-level variable precedence hover, Go-to-Definition, and linting inside `*.j2` templates, following relative `vars_files:` and `include_vars:` paths. Added `missing-vars-file` validation and live eviction when `vars_files:` entries change.
- **Smart `{{ | }}` Auto-Space:** Pressing `Space` inside `{{|}}` pads to `{{ | }}` with the cursor centered, and pressing `Backspace` collapses empty `{{ | }}` back to `{{|}}` (`ansibleLens.jinja.autoSpaceBraces`).
- **Silent Collection Auto-Download:** Automatically downloads metadata for 90+ Ansible community collections in the background with SHA-256 verification and a status-bar indicator.
- **Configurable `Ctrl+Click` Module Docs & No Permanent Underlines:** Removed permanent link underlines and added `ansibleLens.docs.ctrlClickBehavior` (`renderedPreview`, `openInBrowser`, `disabled`).
- **Settings, Diagnostics Command & Docs:** Exposed live `ansibleLens.lint.*`, `ansibleLens.metadata.*`, and `ansibleLens.ansible.rootPaths` settings, added `Ansible Lens: Copy Diagnostics Info`, and added `docs/rules.md`, `docs/configuration.md`, and `docs/troubleshooting.md`.

### Changed

- **Scoped Completion Ranking:** Ranked variable completions by scope (current role → shared playbook/`vars_files`/`group_vars`/`host_vars` → other roles' public vars → special/magic vars), excluding other roles' private `register:` variables.
- **Smaller Extension Package:** Enabled bundle minification and excluded sourcemaps/declarations from the `.vsix`, reducing package size to under 500 KB.

### Fixed

- **Disk-Backed Workspace Index:** Closing `defaults/main.yml`, `handlers/main.yml`, or `versions.yml` tabs no longer drops their variables or handlers from cross-file intelligence.
- **Windows Path & Nested Monorepo Support:** Normalized Windows drive-letter URIs and added upward `ansible.cfg` discovery (`roles_path`, `inventory`) for nested monorepos.
- **`notify:` Go-to-Definition:** Fixed false matches on `- name:` lines and `# comments`, highlighted full multi-word handler names, and preferred same-role handlers when duplicate names exist across roles.
- **Dotted & Multi-Line `when:` Completions:** Fixed completions immediately after `.` (including nested prefixes like `my_stat.stat.e`) and inside multi-line `when:` / `changed_when:` / `failed_when:` lists.

## [0.1.0] - 2026-11-20

### Added

- Initial MIT-licensed release of **Ansible Lens** — a pure TypeScript Ansible Language Server and VS Code extension requiring no Python, WSL, or Docker.
- Fault-tolerant YAML and Jinja2 parser with sub-20ms linting and 1-click Quick-Fixes (including `Convert File to FQCN`).
- Offline-bundled `ansible.builtin` metadata, lazy-loaded collection packs with SHA-256 verification, and static `.py` module docstring extraction.
- `register:` return-value type inference (`loop:`-aware), 22-level cross-file variable precedence hover, and workspace project integrity checks.
- Smart Hybrid Activation coexisting cleanly with `redhat.vscode-yaml` (ignoring Kubernetes, Docker Compose, and GitHub Actions YAML) plus Jinja2 syntax highlighting.

[Unreleased]: https://github.com/amr-io/ansible-lens/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/amr-io/ansible-lens/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/amr-io/ansible-lens/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/amr-io/ansible-lens/releases/tag/v0.1.0
