import { describe, expect, it } from 'vitest';
import {
  WorkspaceVariableGraph,
  lintAnsibleDocument,
  parseAnsibleDocument,
} from '../../src/index.js';
import { createTestMetadataRegistry } from '../intelligence/testFixtures.js';

describe('undefined-variable and var-naming[no-role-prefix] rules & Quick-Fixes', () => {
  const registry = createTestMetadataRegistry();

  it('flags undefined Jinja variables with Levenshtein "Did you mean <var>?" Quick-Fix', () => {
    const defaultsAst = parseAnsibleDocument(
      'file:///ws/roles/security/defaults/main.yml',
      ['---', 'security_ufw_allowed_ports:', '  - 22', '  - 443'].join('\n'),
      'role-defaults',
    );
    const graph = new WorkspaceVariableGraph();
    graph.indexDocument(defaultsAst);

    const tasksYaml = [
      '---',
      '- name: Allow firewall ports',
      '  ansible.builtin.debug:',
      '    msg: "Port {{ item }}"',
      '  loop: "{{ securit_ufw_allowed_ports }}"',
    ].join('\n');
    const tasksAst = parseAnsibleDocument(
      'file:///ws/roles/security/tasks/main.yml',
      tasksYaml,
      'tasks',
    );

    const knownVariables = new Set(graph.listVariables().map((v) => v.name));
    const diags = lintAnsibleDocument(tasksAst, registry, { knownVariables });
    const undefDiags = diags.filter((d) => d.ruleId === 'undefined-variable');
    expect(undefDiags).toHaveLength(1);
    const diag = undefDiags[0]!;
    expect(diag.message).toContain("Undefined variable 'securit_ufw_allowed_ports'");
    expect(diag.message).toContain("Did you mean 'security_ufw_allowed_ports'?");
    expect(diag.quickFixes).toHaveLength(1);
    expect(diag.quickFixes[0]?.title).toBe("Did you mean 'security_ufw_allowed_ports'?");
    expect(diag.quickFixes[0]?.edits[0]?.newText).toBe('security_ufw_allowed_ports');
  });

  it('applies smart zero-noise exclusions for item, ansible_loop, custom loop_control.loop_var, magic vars, ansible_* facts, | default(...), is defined / is not defined, and extraVars', () => {
    const tasksYaml = [
      '---',
      '- name: Zero-noise variable expressions',
      '  ansible.builtin.debug:',
      '    msg: >',
      '      {{ item }} {{ ansible_loop.index }} {{ custom_entry.port }}',
      '      {{ inventory_hostname }} {{ hostvars[inventory_hostname] }}',
      '      {{ ansible_facts.os_family }} {{ ansible_os_family }}',
      '      {{ optional_var | default("fallback") }} {{ short_def | upper | d("none") }}',
      '      {{ cli_injected_var }}',
      '  loop:',
      '    - { port: 80 }',
      '  loop_control:',
      '    loop_var: custom_entry',
      '  when:',
      '    - maybe_present is defined',
      '    - maybe_absent is not defined',
    ].join('\n');
    const tasksAst = parseAnsibleDocument(
      'file:///ws/roles/security/tasks/main.yml',
      tasksYaml,
      'tasks',
    );

    const diags = lintAnsibleDocument(tasksAst, registry, {
      knownVariables: new Set(['security_enabled']),
      extraVars: ['cli_injected_var'],
    });
    expect(diags.filter((d) => d.ruleId === 'undefined-variable')).toEqual([]);
  });

  it('warns on var-naming[no-role-prefix] in roles/<role>/defaults/, vars/, and tasks/ register:/set_fact: with 1-click Quick-Fix', () => {
    const defaultsAst = parseAnsibleDocument(
      'file:///ws/roles/webapp/defaults/main.yml',
      ['---', 'webapp_port: 8080', 'listen_address: 0.0.0.0', '_internal_flag: true'].join('\n'),
      'role-defaults',
    );
    const defaultsDiags = lintAnsibleDocument(defaultsAst, registry);
    const prefixDiags = defaultsDiags.filter((d) => d.ruleId === 'var-naming[no-role-prefix]');
    expect(prefixDiags).toHaveLength(1);
    expect(prefixDiags[0]?.message).toContain("Variable 'listen_address' in role 'webapp'");
    expect(prefixDiags[0]?.quickFixes[0]?.title).toBe("Rename to 'webapp_listen_address'");
    expect(prefixDiags[0]?.quickFixes[0]?.edits[0]?.newText).toBe('webapp_listen_address');

    const tasksYaml = [
      '---',
      '- name: Check version file',
      '  ansible.builtin.stat:',
      '    path: /opt/webapp/VERSION',
      '  register: version_stat',
      '',
      '- name: Set computed facts',
      '  ansible.builtin.set_fact:',
      '    webapp_ready: true',
      '    computed_hash: "abc123"',
      '    cacheable: true',
    ].join('\n');
    const tasksAst = parseAnsibleDocument(
      'file:///ws/roles/webapp/tasks/main.yml',
      tasksYaml,
      'tasks',
    );
    const taskPrefixDiags = lintAnsibleDocument(tasksAst, registry).filter(
      (d) => d.ruleId === 'var-naming[no-role-prefix]',
    );
    expect(taskPrefixDiags).toHaveLength(2);
    expect(taskPrefixDiags.map((d) => d.quickFixes[0]?.edits[0]?.newText)).toEqual([
      'webapp_version_stat',
      'webapp_computed_hash',
    ]);
  });

  it('supports profile and per-rule severity overrides via LintOptions', () => {
    const defaultsAst = parseAnsibleDocument(
      'file:///ws/roles/webapp/defaults/main.yml',
      ['---', 'listen_address: 0.0.0.0'].join('\n'),
      'role-defaults',
    );
    expect(
      lintAnsibleDocument(defaultsAst, registry, {
        ruleOverrides: { 'var-naming[no-role-prefix]': 'off' },
      }),
    ).toEqual([]);

    const prodDiags = lintAnsibleDocument(defaultsAst, registry, {
      profile: 'production',
    });
    expect(prodDiags[0]?.severity).toBe('error');

    expect(
      lintAnsibleDocument(defaultsAst, registry, {
        profile: 'basic',
      }),
    ).toEqual([]);

    expect(
      lintAnsibleDocument(defaultsAst, registry, {
        profile: 'minimal',
      }),
    ).toEqual([]);
  });

  it('recognizes play vars, role vars, task vars, include_role vars, filter call args, and {% for %}/{% set %} locals', () => {
    const playYaml = [
      '---',
      '- name: Play with inline and task vars',
      '  hosts: all',
      '  vars:',
      '    play_defined_var: 1',
      '  roles:',
      '    - role: demo',
      '      vars:',
      '        role_param_var: 2',
      '  tasks:',
      '    - name: Task with vars and jinja statements',
      '      ansible.builtin.debug:',
      '        msg: >',
      '          {% set local_computed = play_defined_var %}',
      '          {% for entry in role_param_var %}{{ entry.name }}{% endfor %}',
      '          {{ local_computed }} {{ task_local_var }} {{ inc_var }}',
      '          {{ optional_chain | regex_replace("a", "b") | default("ok") }}',
      '      vars:',
      '        task_local_var: 3',
      '    - name: Include role with vars',
      '      ansible.builtin.include_role:',
      '        name: demo',
      '        vars:',
      '          inc_var: 4',
    ].join('\n');
    const ast = parseAnsibleDocument('file:///ws/site.yml', playYaml, 'playbook');
    const diags = lintAnsibleDocument(ast, registry, {
      knownVariables: new Set(),
    });
    expect(diags.filter((d) => d.ruleId === 'undefined-variable')).toEqual([]);
  });
});
