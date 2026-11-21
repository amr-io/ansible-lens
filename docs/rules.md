# Ansible Lens — Clean-Room Lint & Project Integrity Rules Reference

All 23 rules in **Ansible Lens** are implemented clean-room in pure TypeScript under the **MIT License** (zero Python, zero `ansible-lint`, zero GPL code). Every rule runs in memory in under 20ms and supports per-rule severity overrides via `ansibleLens.lint.rules`.

---

## Configuring Rule Severities & Profiles

In your VS Code `settings.json`:

```json
{
  "ansibleLens.lint.enabled": true,
  "ansibleLens.lint.profile": "moderate",
  "ansibleLens.lint.rules": {
    "var-naming[no-role-prefix]": "off",
    "package-latest": "error"
  },
  "ansibleLens.lint.extraVars": ["env_name", "ci_build_number"]
}
```

### Profiles (`ansibleLens.lint.profile`)

- **`minimal`**: Syntax and schema correctness only (`yaml-syntax`, `unknown-module`, `unknown-param`, `missing-required-param`, `invalid-choice`, `param-type-mismatch`, `duplicate-keys`).
- **`basic`**: All `minimal` rules plus security, idempotency, and undefined-variable checks (excludes `var-naming[no-role-prefix]`).
- **`moderate` (default)**: All 23 lint and project integrity rules at their default severities.
- **`production`**: All 23 rules enabled, with all `warning`-level diagnostics elevated to `error`.

---

## 1. Syntax & YAML Hygiene Rules

### `yaml-syntax` (`error`)

Reports non-fatal YAML CST or unclosed Jinja2 syntax errors while continuing to analyze the rest of the file.

```yaml
# Bad
- name: Unclosed Jinja expression
  ansible.builtin.debug:
    msg: 'Hello {{ user_name'

# Good
- name: Valid Jinja expression
  ansible.builtin.debug:
    msg: 'Hello {{ user_name }}'
```

### `duplicate-keys` (`error`)

Detects duplicate mapping keys inside the same play, task, or variable dictionary.

```yaml
# Bad
- name: Install package
  ansible.builtin.apt:
    name: nginx
    state: present
    state: latest

# Good
- name: Install package
  ansible.builtin.apt:
    name: nginx
    state: present
```

### `yaml-truthy` (`warning` — 1-Click Quick-Fix)

Flags legacy YAML 1.1 boolean literals (`yes`, `no`, `on`, `off`, `TRUE`, `FALSE`) and normalizes them to YAML 1.2 `true` / `false`.

```yaml
# Bad
- name: Enable service
  ansible.builtin.service:
    name: nginx
    enabled: yes

# Good
- name: Enable service
  ansible.builtin.service:
    name: nginx
    enabled: true
```

---

## 2. Module & Parameter Schema Rules

### `unknown-module` (`error` / `info` — 1-Click Quick-Fix)

Flags unrecognized module names with a Levenshtein _"Replace with `<fqcn>`"_ Quick-Fix. Valid-looking FQCNs from unloaded collections emit a subtle `info` hint and trigger background auto-download when `ansibleLens.metadata.autoDownload` is `true`.

```yaml
# Bad
- name: Copy file
  ansible.builtin.cpy:
    src: app.conf
    dest: /etc/app.conf
    mode: '0644'

# Good
- name: Copy file
  ansible.builtin.copy:
    src: app.conf
    dest: /etc/app.conf
    mode: '0644'
```

### `unknown-param` (`error` — 1-Click Quick-Fix)

Flags unrecognized module options or nested `suboptions` and offers a 1-click replacement with the closest valid option or alias.

```yaml
# Bad
- name: Copy file
  ansible.builtin.copy:
    source_path: app.conf
    dest: /etc/app.conf
    mode: '0644'

# Good
- name: Copy file
  ansible.builtin.copy:
    src: app.conf
    dest: /etc/app.conf
    mode: '0644'
```

### `missing-required-param` (`error` — 1-Click Quick-Fix)

Flags tasks that omit a required module parameter (such as `path` on `ansible.builtin.stat` or `dest` on `ansible.builtin.copy`).

```yaml
# Bad
- name: Check file status
  ansible.builtin.stat: {}

# Good
- name: Check file status
  ansible.builtin.stat:
    path: /etc/nginx/nginx.conf
```

### `invalid-choice` (`error` — 1-Click Quick-Fix)

Validates static scalar values against the option's allowed `choices` list.

```yaml
# Bad
- name: Start nginx
  ansible.builtin.service:
    name: nginx
    state: running

# Good
- name: Start nginx
  ansible.builtin.service:
    name: nginx
    state: started
```

### `param-type-mismatch` (`warning` — 1-Click Quick-Fix)

Checks static YAML scalar/collection types against the module option's declared type (`bool`, `int`, `float`, `list`, `dict`, `str`). Skips values containing Jinja2 `{{ ... }}` expressions.

```yaml
# Bad
- name: Wait for port
  ansible.builtin.wait_for:
    port: 80
    timeout: 'five'

# Good
- name: Wait for port
  ansible.builtin.wait_for:
    port: 80
    timeout: 5
```

### `deprecated-module` (`warning` — 1-Click Quick-Fix)

Warns when a task invokes a deprecated module and offers a 1-click Quick-Fix to replace it with its documented alternative.

---

## 3. Best-Practice, Idempotency & Security Rules

### `fqcn` (`warning` — 1-Click Quick-Fix & File-Wide Fix-All)

Encourages Fully Qualified Collection Names (`ansible.builtin.copy` instead of `copy`). Supports both per-task Quick-Fix and the file-wide `Ansible Lens: Convert File to FQCN` command.

```yaml
# Bad
- name: Ping host
  ping:

# Good
- name: Ping host
  ansible.builtin.ping:
```

### `name-missing` (`warning` — 1-Click Quick-Fix)

Warns when a task omits a descriptive `name:` attribute.

```yaml
# Bad
- ansible.builtin.ping:

# Good
- name: Verify host connectivity
  ansible.builtin.ping:
```

### `no-changed-when` (`warning` — 1-Click Quick-Fix)

Warns when `command`, `shell`, or `raw` tasks omit `changed_when:` (and do not set `creates:` or `removes:`).

```yaml
# Bad
- name: Check service status
  ansible.builtin.command:
    cmd: systemctl status nginx

# Good
- name: Check service status
  ansible.builtin.command:
    cmd: systemctl status nginx
  changed_when: false
```

### `command-instead-of-module` (`warning` — 1-Click Quick-Fix)

Flags `command`/`shell` tasks that invoke tools covered by dedicated idempotent modules (`git`, `curl`/`wget`, `apt`/`apt-get`, `yum`/`dnf`, `systemctl`/`service`, `mkdir`/`chmod`/`chown`, `tar`/`unzip`).

```yaml
# Bad
- name: Restart nginx via shell
  ansible.builtin.shell:
    cmd: systemctl restart nginx
  changed_when: true

# Good
- name: Restart nginx declaratively
  ansible.builtin.service:
    name: nginx
    state: restarted
```

### `package-latest` (`warning` — 1-Click Quick-Fix)

Warns when package managers (`apt`, `dnf`, `yum`, `package`, `pip`, `apk`) use `state: latest` instead of `state: present`.

```yaml
# Bad
- name: Install curl
  ansible.builtin.apt:
    name: curl
    state: latest

# Good
- name: Install curl
  ansible.builtin.apt:
    name: curl
    state: present
```

### `risky-file-permissions` (`warning` — 1-Click Quick-Fix)

Warns when `file`, `copy`, `template`, or `lineinfile` tasks omit `mode:` or grant world-writable `0777` / `777` / `a+rwx` permissions.

```yaml
# Bad
- name: Deploy config
  ansible.builtin.template:
    src: app.conf.j2
    dest: /etc/app.conf

# Good
- name: Deploy config
  ansible.builtin.template:
    src: app.conf.j2
    dest: /etc/app.conf
    mode: '0644'
```

### `hardcoded-secret` (`warning` — 1-Click Quick-Fix)

Detects plaintext credentials assigned to secret-like keys (`password`, `passwd`, `secret`, `token`, `api_key`, `private_key`, `passphrase`) without Jinja2 `{{ ... }}` or `!vault` encryption.

```yaml
# Bad
- name: Configure database user
  ansible.builtin.debug:
    msg: 'ok'
  vars:
    db_password: 'SuperSecretPlaintext123!'

# Good
- name: Configure database user
  ansible.builtin.debug:
    msg: 'ok'
  vars:
    db_password: '{{ vault_db_password }}'
```

---

## 4. Variable Intelligence Rules

### `undefined-variable` (`warning` — 1-Click Levenshtein Quick-Fix)

Flags Jinja2 variables in playbooks, tasks, and `.j2` templates that are not defined anywhere in the 22-level workspace variable graph (`defaults/`, `vars/`, `group_vars/`, `host_vars/`, `vars_files:`, `include_vars:`, inventory, play/block/task `vars:`, `set_fact:`, `register:`).

**Smart Zero-Noise Exclusions:**

- `item`, `ansible_loop`, and custom `loop_control.loop_var` identifiers
- Ansible magic variables (`hostvars`, `groups`, `group_names`, `inventory_hostname`, `playbook_dir`, `role_path`, `omit`, etc.) and `ansible_*` facts
- Jinja2 keywords, builtins (`range`, `dict`, `lookup`, `query`, `now`), and template-local `{% for x in ... %}` / `{% set x = ... %}` bindings
- Variables guarded by `| default(...)` / `| d(...)` or `is defined` / `is not defined`
- User-configured `ansibleLens.lint.extraVars`

```yaml
# Bad (typo in variable name)
- name: Open firewall ports
  ansible.builtin.debug:
    msg: 'Allow {{ item }}'
  loop: '{{ securit_ufw_allowed_ports }}'

# Good
- name: Open firewall ports
  ansible.builtin.debug:
    msg: 'Allow {{ item }}'
  loop: '{{ security_ufw_allowed_ports }}'
```

### `var-naming[no-role-prefix]` (`warning` — 1-Click Quick-Fix)

Warns when variables declared in `roles/<role>/defaults/`, `roles/<role>/vars/`, or `register:` / `set_fact:` inside `roles/<role>/tasks/` lack the `<role>_` prefix (hyphenated role names normalize to underscores; leading `_` private variables are exempt).

```yaml
# Bad (in roles/webapp/defaults/main.yml)
---
http_port: 8080

# Good (in roles/webapp/defaults/main.yml)
---
webapp_http_port: 8080
```

---

## 5. Workspace Project Integrity Rules

### `missing-role` (`error`)

Flags role references in `roles:` or `include_role` / `import_role` that cannot be found in `ansible.cfg` `roles_path`, `<ansibleRoot>/roles/`, or `<workspaceRoot>/roles/`.

### `missing-role-tasks` (`error`)

Flags roles whose directory exists on disk but lacks `tasks/main.yml` (or `tasks/main.yaml`).

### `missing-handler` (`error`)

Flags `notify:` handler names that do not match any handler `name:` or `listen:` topic across the play, referenced roles, or workspace handler files.

### `missing-src-file` (`warning`)

Flags static `src:` file references in `copy` or `template` tasks (without `remote_src: true`) that do not exist in role `files/` / `templates/` or playbook directories.

### `unknown-inventory-host` (`warning`)

Flags static play `hosts:` targets (other than `all` and `localhost`) that do not match any host or group in the workspace inventory when an inventory file is present.
