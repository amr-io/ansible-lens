# ADR 0001: Static Compressed Metadata Packs vs. Runtime Python Execution

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

Existing Ansible IDE tools invoke `ansible-doc`, `ansible-playbook --syntax-check`, and `ansible-lint` via a local Python environment (or WSL/Docker on Windows). This architecture fails on native Windows workstations, introduces multi-second startup/linting latency, breaks when virtualenvs shift, and creates a heavy operational barrier for developers editing YAML playbooks.

## Decision

1. We eliminate runtime Python dependencies entirely during editing.
2. We introduce a build-time CLI (`scripts/metadata-builder`) that runs `ansible-doc -t module --metadata-dump` in Linux CI (and local Linux build environments) to extract module options, suboptions, types, choices, required flags, deprecation notices, and `RETURN` schemas.
3. We compress each collection into a deterministic `.json.gz` metadata pack accompanied by a `manifest.json` containing SHA-256 digests and schema version metadata.
4. `ansible.builtin.json.gz` is bundled directly with the extension for instant offline support. Top Galaxy collection packs are lazy-downloaded on demand from GitHub Releases, verified against their SHA-256 digest in `manifest.json`, and cached locally.
5. For workspace-local custom Python modules (`library/*.py` or `collections/ansible_collections/*/*/plugins/modules/*.py`), we parse `DOCUMENTATION = r'''...'''` and `RETURN = r'''...'''` string literals statically using our TypeScript YAML parser—never executing Python code.

## Consequences

- **Positive:** 100% native cross-platform execution on Windows, macOS, and Linux with no Python/WSL/Docker required; sub-20ms startup and linting.
- **Negative:** Newly released upstream Galaxy collections require either a weekly automated metadata release (`build-metadata.yml`) or local workspace extraction.
