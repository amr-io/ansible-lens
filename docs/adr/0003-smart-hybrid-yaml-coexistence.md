# ADR 0003: Smart Hybrid Activation & Coexistence with `redhat.vscode-yaml`

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

Developers regularly work in polyglot repositories containing Kubernetes manifests, Helm charts, Docker Compose files, GitHub Actions workflows, and Ansible playbooks—all sharing the `.yml` / `.yaml` extension. Forcing users to manually change the VS Code language mode to `ansible` creates friction, while indiscriminately attaching an Ansible linter to every `.yml` file breaks non-Ansible YAML files and conflicts with `redhat.vscode-yaml`.

## Decision

1. **Smart Hybrid Activation:** The client and server evaluate fast, deterministic file-path and content heuristics on any `yaml` or `ansible` document:
   - Path matches Ansible directory conventions (`roles/**/tasks/*.yml`, `roles/**/handlers/*.yml`, `roles/**/defaults/*.yml`, `roles/**/vars/*.yml`, `group_vars/**`, `host_vars/**`, `playbooks/**`, `site.yml`, `playbook.yml`, or sibling `ansible.cfg`).
   - Or content matches Ansible playbook/task structure (top-level sequence of mappings containing `hosts:` + `tasks:`/`roles:`/`pre_tasks:`/`post_tasks:`, or task lists containing `name:` + module keys / `block:`).
   - Explicit negative guards immediately exclude Kubernetes manifests (`apiVersion:` + `kind:`), Docker Compose (`services:` + `volumes:`/`networks:`), and GitHub Actions (`on:` + `jobs:`).
2. **TextMate Injection Grammar:** Instead of replacing `source.yaml`, we contribute a non-invasive TextMate grammar with `"injectTo": ["source.yaml", "source.ansible"]` that highlights `{{ ... }}`, `{% ... %}`, `{# ... #}`, Jinja filters, and keywords inside standard YAML files.

## Consequences

- **Positive:** Zero manual language switching required; zero false-positive diagnostics on Kubernetes, Docker Compose, or GitHub Actions YAML files; seamless coexistence with `redhat.vscode-yaml`.
- **Negative:** Heuristic classification must be fast (< 1ms) and well-tested against diverse YAML formats.
