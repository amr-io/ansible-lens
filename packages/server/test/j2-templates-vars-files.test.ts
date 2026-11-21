import { describe, expect, it } from 'vitest';
import type { Location } from 'vscode-languageserver/node.js';
import { AnsibleLanguageService, MemoryWorkspaceFs, fsPathToUri } from '../src/index.js';

describe('.j2 template intelligence and vars_files / include_vars relative path traversal', () => {
  const versionsPath = '/repo/versions.yml';
  const sitePath = '/repo/ansible/playbooks/site.yml';
  const roleDefaultsPath = '/repo/ansible/roles/overleaf/defaults/main.yml';
  const roleVarsPath = '/repo/ansible/roles/overleaf/vars/main.yml';
  const extraVarsPath = '/repo/ansible/roles/overleaf/vars/extra.yml';
  const roleTasksPath = '/repo/ansible/roles/overleaf/tasks/main.yml';
  const templatePath = '/repo/ansible/roles/overleaf/templates/overleaf.rc.j2';
  const groupVarsPath = '/repo/ansible/group_vars/all.yml';

  const templateUri = fsPathToUri(templatePath);
  const versionsUri = fsPathToUri(versionsPath);

  function createService(): AnsibleLanguageService {
    const fs = new MemoryWorkspaceFs({
      '/repo/ansible/ansible.cfg':
        '[defaults]\nroles_path = ./roles\ninventory = ./inventory/hosts.ini\n',
      '/repo/ansible/inventory/hosts.ini': '[overleaf_servers]\noverleaf1 ansible_host=10.0.0.10\n',
      [versionsPath]: ['---', 'overleaf_release_tag: "5.1.2"', 'mongo_image_version: "7.0"'].join(
        '\n',
      ),
      [groupVarsPath]: ['---', 'global_domain: "overleaf.example.com"'].join('\n'),
      [sitePath]: [
        '---',
        '- name: Deploy Overleaf',
        '  hosts: overleaf_servers',
        '  vars_files:',
        '    - ../../versions.yml',
        '  roles:',
        '    - overleaf',
      ].join('\n'),
      [roleDefaultsPath]: ['---', 'overleaf_http_port: 8080'].join('\n'),
      [roleVarsPath]: ['---', 'overleaf_container_name: "sharelatex"'].join('\n'),
      [extraVarsPath]: ['---', 'overleaf_included_secret_path: "/run/secrets/overleaf"'].join('\n'),
      [roleTasksPath]: [
        '---',
        '- name: Load extra role variables',
        '  ansible.builtin.include_vars:',
        '    file: extra.yml',
        '',
        '- name: Check version file',
        '  ansible.builtin.stat:',
        '    path: /opt/overleaf/VERSION',
        '  register: overleaf_version_file',
        '',
        '- name: Render overleaf.rc',
        '  ansible.builtin.template:',
        '    src: overleaf.rc.j2',
        '    dest: /etc/overleaf.rc',
        '    mode: "0644"',
      ].join('\n'),
      [templatePath]: [
        '# Managed by Ansible',
        'OVERLEAF_IMAGE_TAG="{{ overleaf_release_tag }}"',
        'OVERLEAF_PORT={{ overleaf_http_port }}',
        'OVERLEAF_DOMAIN={{ global_domain }}',
        'OVERLEAF_EXISTS={{ overleaf_version_file.stat.exists }}',
      ].join('\n'),
    });

    const service = new AnsibleLanguageService({
      fs,
      workspaceRoots: ['/repo'],
    });
    service.indexWorkspace();
    return service;
  }

  it('indexes ../../versions.yml from vars_files: and extra.yml from include_vars: and offers them in .j2 completions', () => {
    const service = createService();
    const doc = ['# Managed by Ansible', 'OVERLEAF_TAG="{{ '].join('\n');
    const items = service.getCompletions(
      templateUri,
      { line: 1, character: 'OVERLEAF_TAG="{{ '.length },
      doc,
    );
    const labels = items.map((i) => i.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'overleaf_release_tag',
        'mongo_image_version',
        'overleaf_http_port',
        'overleaf_container_name',
        'overleaf_included_secret_path',
        'global_domain',
        'overleaf_version_file',
      ]),
    );
  });

  it('completes registered variable return fields inside .j2 templates', () => {
    const service = createService();
    const doc = 'EXISTS={{ overleaf_version_file.stat.';
    const items = service.getCompletions(templateUri, { line: 0, character: doc.length }, doc);
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['exists', 'isdir', 'mode']));
  });

  it('provides hover with 22-level precedence and Go-to-Definition inside .j2 templates jumping to ../../versions.yml', () => {
    const service = createService();
    const text = ['# Managed by Ansible', 'OVERLEAF_IMAGE_TAG="{{ overleaf_release_tag }}"'].join(
      '\n',
    );
    const col = text.split('\n')[1]!.indexOf('overleaf_release_tag') + 4;

    const hover = service.getHover(templateUri, { line: 1, character: col }, text);
    const hoverMd =
      hover && typeof hover.contents === 'object' && 'value' in hover.contents
        ? hover.contents.value
        : '';
    expect(hoverMd).toContain('overleaf_release_tag');
    expect(hoverMd).toContain('5.1.2');
    expect(hoverMd).toContain('14 / 22');

    const defs = service.getDefinition(
      templateUri,
      { line: 1, character: col },
      text,
    ) as Location[];
    expect(defs).toHaveLength(1);
    expect(defs[0]?.uri).toBe(versionsUri);
    expect(defs[0]?.range.start.line).toBe(1);
  });

  it('flags undefined variables inside .j2 templates with Levenshtein Quick-Fix while emitting zero YAML task diagnostics', () => {
    const service = createService();
    const cleanText = [
      '# Managed by Ansible',
      'OVERLEAF_IMAGE_TAG="{{ overleaf_release_tag }}"',
      'OVERLEAF_PORT={{ overleaf_http_port }}',
    ].join('\n');
    expect(service.getDiagnostics(templateUri, cleanText)).toEqual([]);

    const typoText = 'OVERLEAF_IMAGE_TAG="{{ overleaf_releas_tag }}"';
    const diags = service.getDiagnostics(templateUri, typoText);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.code).toBe('undefined-variable');
    expect(diags[0]?.message).toContain("Did you mean 'overleaf_release_tag'?");
  });
});
