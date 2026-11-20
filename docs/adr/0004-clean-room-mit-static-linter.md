# ADR 0004: Clean-Room MIT Static Linter & Supply-Chain Hardening

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

`ansible/ansible` and `ansible/ansible-lint` are licensed under GPLv3. Because Ansible Lens is published under the permissive **MIT License**, we must guarantee strict license purity while also meeting modern software supply-chain security standards.

## Decision

1. **Clean-Room MIT Linter:** All lint rules (`unknown-module`, `unknown-param`, `missing-required-param`, `invalid-choice`, `param-type-mismatch`, `fqcn`, `name-missing`, `no-changed-when`, `command-instead-of-module`, `package-latest`, `risky-file-permissions`, `deprecated-module`, `hardcoded-secret`, `yaml-truthy`, `duplicate-keys`) and Quick-Fix code actions are designed and implemented from scratch in pure TypeScript using only publicly documented Ansible module specifications and YAML 1.2 rules. No GPL source code is copied, translated, or derived.
2. **Third-Party Attribution:** Any MIT-licensed reference material (such as TextMate grammar patterns from MIT-licensed repositories) is explicitly documented in `THIRD_PARTY_NOTICES.md`.
3. **CI/CD Supply-Chain Security:** Every third-party GitHub Action in `.github/workflows/*.yml` is pinned to a full 40-character commit SHA with an inline version comment, least-privilege `permissions:` blocks are declared on every workflow, CodeQL and Dependabot are enabled, and `release.yml` uses only the built-in `GITHUB_TOKEN` to publish `.vsix` + `SHA256SUMS.txt` to GitHub Releases.

## Consequences

- **Positive:** Complete MIT license compliance suitable for commercial and open-source adoption, auditable supply chain, and deterministic sub-20ms in-process linting with instant Quick-Fixes.
- **Negative:** Lint rules must be maintained independently in TypeScript rather than delegating to an external Python linter.
