# Ansible Lens — Configuration Reference

All **Ansible Lens** settings live under the `ansibleLens.*` namespace in VS Code (`File > Preferences > Settings` or `.vscode/settings.json`). Changes take effect live without restarting VS Code.

---

## Settings Overview

| Setting                                | Type                                                      | Default                                                                                      | Description                                                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ansibleLens.lint.enabled`             | `boolean`                                                 | `true`                                                                                       | Enable or disable static Ansible linting and project integrity checks.                                                                                                       |
| `ansibleLens.lint.profile`             | `"minimal" \| "basic" \| "moderate" \| "production"`      | `"moderate"`                                                                                 | Lint strictness profile. In `"production"` mode, all warnings are elevated to errors.                                                                                        |
| `ansibleLens.lint.rules`               | `Record<string, "error" \| "warning" \| "info" \| "off">` | `{}`                                                                                         | Per-rule severity overrides keyed by Rule ID.                                                                                                                                |
| `ansibleLens.lint.extraVars`           | `string[]`                                                | `[]`                                                                                         | Extra variable names (injected via `-e` / `--extra-vars` or CI) exempted from `undefined-variable`.                                                                          |
| `ansibleLens.metadata.autoDownload`    | `boolean`                                                 | `true`                                                                                       | Automatically lazy-download unloaded collection metadata packs (`.json.gz`) in the background on first FQCN encounter with SHA-256 verification.                             |
| `ansibleLens.metadata.manifestUrl`     | `string`                                                  | `"https://github.com/amr-vibe/ansible-lens/releases/download/metadata-latest/manifest.json"` | Remote or internal mirror URL for `manifest.json` and `.json.gz` collection metadata packs.                                                                                  |
| `ansibleLens.jinja.autoSpaceBraces`    | `boolean`                                                 | `true`                                                                                       | Automatically pad `{{                                                                                                                                                        | }}`to`{{ | }}`on`Space`(keeping the cursor centered) and collapse empty`{{ | }}`back to`{{ | }}`on`Backspace`. |
| `ansibleLens.ansible.rootPaths`       | `string[]`                                                | `[]`                                                                                         | Explicit Ansible project root directories (relative to workspace root or absolute) for monorepos without an `ansible.cfg`.                                                                                     |
| `ansibleLens.docs.ctrlClickBehavior`  | `"renderedPreview" \| "openInBrowser" \| "disabled"`      | `"renderedPreview"`                                                                          | Controls `Ctrl+Click` (Go to Definition) on module names (with zero permanent underlines): `"renderedPreview"` opens rendered Markdown in VS Code, `"openInBrowser"` opens `docs.ansible.com`, `"disabled"` does nothing. |

---

## Example `.vscode/settings.json`

### Standard Project

```json
{
  "ansibleLens.lint.enabled": true,
  "ansibleLens.lint.profile": "moderate",
  "ansibleLens.lint.extraVars": ["deploy_release_sha", "vault_master_token"],
  "ansibleLens.lint.rules": {
    "package-latest": "error",
    "var-naming[no-role-prefix]": "warning"
  },
  "ansibleLens.jinja.autoSpaceBraces": true
}
```

### Nested Monorepo (e.g. `repo-root/infra/ansible/`)

Ansible Lens automatically walks upward from each open file toward the workspace root to locate the nearest `ansible.cfg` (parsing `roles_path` and `inventory`) or nearest parent containing `roles/`, `inventory/`, or `group_vars/`. If your nested monorepo does not use `ansible.cfg` or standard directory markers, specify `ansibleLens.ansible.rootPaths`:

```json
{
  "ansibleLens.ansible.rootPaths": ["infra/ansible", "services/webapp/deploy"]
}
```

### Air-Gapped / Corporate Mirror Environment

```json
{
  "ansibleLens.metadata.autoDownload": true,
  "ansibleLens.metadata.manifestUrl": "https://artifacts.internal.example.com/ansible-lens/metadata-latest/manifest.json"
}
```

---

## Commands

Open the VS Code Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command ID                        | Title                                         | Description                                                                                                                                         |
| --------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ansibleLens.openOfficialDocs`    | **Ansible Lens: Open Official Docs**          | Opens `https://docs.ansible.com` in your browser.                                                                                                   |
| `ansibleLens.refreshMetadata`     | **Ansible Lens: Refresh Collection Metadata** | Re-indexes workspace playbooks, roles, `vars_files`, `.j2` templates, and metadata packs.                                                           |
| `ansibleLens.convertFileToFqcn`   | **Ansible Lens: Convert File to FQCN**        | Converts all short module names in the active file to their canonical `ansible.builtin.*` FQCNs in one click.                                       |
| `ansibleLens.copyDiagnosticsInfo` | **Ansible Lens: Copy Diagnostics Info**       | Copies OS, VS Code version, extension version, detected `ansibleRoot`, loaded collection packs, and recent errors to the clipboard for bug reports. |
