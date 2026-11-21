# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Security Architecture Guarantees

1. **Zero Untrusted Code Execution:** Ansible Lens parses YAML, Jinja2, and Python module `DOCUMENTATION`/`RETURN` docstrings statically. It never calls `eval()`, never executes workspace Python scripts, and never invokes untrusted binaries.
2. **Cryptographic Verification of Metadata Packs:** Every lazy-downloaded collection metadata pack (`.json.gz`) is verified against its expected SHA-256 digest in `manifest.json` before decompression and schema validation.
3. **Supply-Chain Hardening:** All GitHub Actions are pinned to immutable 40-character commit SHAs with least-privilege `permissions:` blocks, CodeQL static analysis, and automated Dependabot updates.

## Reporting a Vulnerability

Please report security vulnerabilities privately via [GitHub Security Advisories](https://github.com/amr-io/ansible-lens/security/advisories/new) rather than opening a public issue. We will acknowledge receipt within 48 hours and coordinate a fix and disclosure timeline.
