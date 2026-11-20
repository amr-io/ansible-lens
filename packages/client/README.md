# Ansible Lens

Zero-dependency, cross-platform, static-metadata Ansible Language Server & Linter for Visual Studio Code.

> _Ansible Lens is an independent, community-built extension and is not affiliated with or endorsed by Red Hat, Inc. Ansible® is a registered trademark of Red Hat, Inc._

## Features

- **Zero External Dependencies:** Pure TypeScript/Node.js — no local Python, `ansible-core`, `ansible-lint`, WSL, or Docker required.
- **Smart Hybrid Activation:** Automatically activates on Ansible playbooks, roles, tasks, handlers, `group_vars/`, and `host_vars/`, while never hijacking Kubernetes, Docker Compose, or GitHub Actions YAML files.
- **Rich Completions & Hovers:** Module FQCNs and short names, parameters, choices, `register:` return fields (including `loop:` `.results`), 22-level variable precedence hover cards, Jinja2 filters/tests, magic variables, `ansible_facts`, and inventory hosts/groups.
- **Go to Definition, References & Deep Doc Links:** Navigate to handlers, roles, `vars_files`, `copy`/`template` assets, and open deep `docs.ansible.com` links.
- **Clean-Room Static Linter & Quick-Fixes:** FQCN expansion (`Convert File to FQCN`), parameter validation, idempotency hints, and project integrity checks.
- **Jinja2 TextMate Injection Grammar:** Highlights `{{ ... }}`, `{% ... %}`, and `{# ... #}` directly inside YAML files.

## License

MIT License. See [LICENSE](./LICENSE).
