# Ansible Lens — Troubleshooting Guide

This guide covers common real-world setups including **Windows & nested monorepos**, **coexistence with `redhat.vscode-yaml` and `redhat.ansible`**, and **air-gapped / offline metadata packs**.

---

## 1. Copying Diagnostics Info for Support

Before filing an issue, open the VS Code Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

> **`Ansible Lens: Copy Diagnostics Info`**

This copies a structured summary to your clipboard containing your OS version, VS Code version, extension version, detected `ansibleRoot`, configured root paths, loaded collection packs, indexed document/variable counts, and any recent server errors.

---

## 2. Nested Monorepos on Windows, macOS & Linux

### Symptom

You open a repository root (e.g. `C:\repos\mcleaf\` or `/home/user/mcleaf/`) where Ansible lives inside a subfolder (`mcleaf/ansible/`), and previously saw false-positive `missing-role` errors or missing `vars_files:` variables.

### How Ansible Lens Resolves Nested Roots

1. **Automatic `ansible.cfg` Discovery:** For every open YAML or `.j2` file, Ansible Lens walks upward from the file's directory toward the workspace root to find the nearest `ansible.cfg`, parses `roles_path` and `inventory` from `[defaults]`, and resolves all roles, handlers, templates, and `vars_files:` (including relative paths like `../../versions.yml`) against that Ansible root.
2. **Automatic Directory Marker Discovery:** If no `ansible.cfg` is present, Ansible Lens walks upward to find the nearest parent directory containing `roles/`, `inventory/`, `inventories/`, `group_vars/`, or `host_vars/`.
3. **Explicit Root Paths Override:** For custom monorepo layouts without `ansible.cfg`, add `ansibleLens.ansible.rootPaths` to `.vscode/settings.json`:

```json
{
  "ansibleLens.ansible.rootPaths": ["ansible"]
}
```

---

## 3. Coexistence with `redhat.vscode-yaml` & `redhat.ansible`

### `redhat.vscode-yaml` (YAML Extension)

Ansible Lens is specifically engineered to **coexist cleanly** with `redhat.vscode-yaml`:

- Ansible Lens registers on `yaml`, `ansible`, `jinja`, and `*.j2` files using **Smart Hybrid Activation**.
- Kubernetes manifests (`apiVersion:` + `kind:`), Docker Compose files (`services:`), and GitHub Actions workflows (`.github/workflows/*.yml` or `on:` + `jobs:`) are automatically ignored by Ansible Lens so `redhat.vscode-yaml` handles them without duplicate diagnostics or completion noise.

### `redhat.ansible` (Red Hat Ansible Extension)

If you have `redhat.ansible` installed alongside **Ansible Lens**:

- Both extensions attach Language Servers to Ansible files, which can produce duplicate hover tooltips and require Python/WSL from `redhat.ansible`.
- **Recommendation:** Disable `redhat.ansible` for the workspace (_Extensions > Ansible > Disable (Workspace)_) and keep files in standard `yaml` (or `ansible`) mode so **Ansible Lens** provides zero-dependency, sub-20ms completions, `Ctrl+Click` module docs, and linting natively on Windows, macOS, and Linux.

---

## 4. Air-Gapped Environments & Custom `manifestUrl`

### How Collection Metadata Works

- **Bundled Offline Pack:** `ansible.builtin` (`ansible.builtin.json.gz`) is bundled inside the `.vsix` and works 100% offline with zero network calls.
- **90+ Community Collection Packs:** The `metadata-latest` GitHub Release publishes 90+ `.json.gz` collection packs (`community.general`, `ansible.posix`, `community.docker`, `community.crypto`, `amazon.aws`, `kubernetes.core`, etc.) plus a SHA-256 `manifest.json`.
- **Silent Auto-Download:** When `ansibleLens.metadata.autoDownload` is `true` (default), encountering a task like `ansible.posix.sysctl:` automatically downloads and SHA-256-verifies `ansible.posix.json.gz` into `~/.cache/ansible-lens/metadata/` and refreshes diagnostics in place.

### Air-Gapped / Internal Mirror Setup

1. Download `manifest.json` and the `.json.gz` collection packs from the [`metadata-latest` GitHub Release](https://github.com/amr-io/ansible-lens/releases/tag/metadata-latest) and host them on an internal HTTP server or artifact repository.
2. Point `ansibleLens.metadata.manifestUrl` to your internal `manifest.json`:

```json
{
  "ansibleLens.metadata.manifestUrl": "https://mirror.internal.example.com/ansible-lens/manifest.json"
}
```

3. For completely offline workstations with no internal HTTP mirror, copy the `.json.gz` files and `manifest.json` directly into `~/.cache/ansible-lens/metadata/` (or `%USERPROFILE%\.cache\ansible-lens\metadata\` on Windows) and set:

```json
{
  "ansibleLens.metadata.autoDownload": false
}
```
