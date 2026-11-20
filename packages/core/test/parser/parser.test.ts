import { describe, expect, it } from 'vitest';
import {
  OffsetIndex,
  advancePosition,
  detectAnsibleDocument,
  extractJinjaBlocksFromText,
  parseAnsibleDocument,
  tokenizeJinjaBlock,
} from '../../src/parser/index.js';

describe('OffsetIndex & SourcePosition mapping', () => {
  it('maps LF and CRLF offsets accurately to 0-indexed line, column, and offset', () => {
    const lfText = 'line0\nline1\nline2';
    const lfIndex = new OffsetIndex(lfText);
    expect(lfIndex.positionAt(0)).toEqual({ line: 0, column: 0, offset: 0 });
    expect(lfIndex.positionAt(6)).toEqual({ line: 1, column: 0, offset: 6 });
    expect(lfIndex.positionAt(14)).toEqual({ line: 2, column: 2, offset: 14 });
    expect(lfIndex.positionAt(-5)).toEqual({ line: 0, column: 0, offset: 0 });
    expect(lfIndex.positionAt(999)).toEqual({ line: 2, column: 5, offset: 17 });

    const crlfText = 'first\r\nsecond\r\nthird';
    const crlfIndex = new OffsetIndex(crlfText);
    expect(crlfIndex.positionAt(7)).toEqual({ line: 1, column: 0, offset: 7 });
    expect(crlfIndex.positionAt(15)).toEqual({ line: 2, column: 0, offset: 15 });

    const range = crlfIndex.rangeAt(7, 13);
    expect(range.start).toEqual({ line: 1, column: 0, offset: 7 });
    expect(range.end).toEqual({ line: 1, column: 6, offset: 13 });
  });

  it('advances positions across multiline slices', () => {
    const end = advancePosition({ line: 2, column: 4, offset: 20 }, 'abc\ndef');
    expect(end).toEqual({ line: 3, column: 3, offset: 27 });
  });
});

describe('Jinja2 tokenizer', () => {
  it('tokenizes expression with dotted & bracketed variables, filters, and literals', () => {
    const block = tokenizeJinjaBlock(
      "{{ res.results[0].item['name'] | default('fallback') | upper }}",
      'expression',
      10,
      2,
      4,
    );
    expect(block.kind).toBe('expression');
    expect(block.unclosed).toBe(false);
    expect(block.filters).toEqual(['default', 'upper']);
    expect(block.variables).toHaveLength(1);
    expect(block.variables[0]?.root).toBe('res');
    expect(block.variables[0]?.path).toEqual(['results', '0', 'item', 'name']);
    expect(block.variables[0]?.raw).toBe("res.results[0].item['name']");
    expect(block.tokens.some((t) => t.kind === 'literal' && t.value === "'fallback'")).toBe(true);
    expect(block.tokens.some((t) => t.kind === 'filter' && t.value === 'default')).toBe(true);
    expect(block.range.start).toEqual({ line: 2, column: 4, offset: 10 });
  });

  it('tokenizes implicit conditionals (`when:`) with tests (`is defined`, `is not none`) and numbers', () => {
    const block = tokenizeJinjaBlock(
      "my_var is defined and count >= 3 and flag is not none and lookup('env', 'HOME') != ''",
      'implicit',
      0,
      5,
      8,
    );
    expect(block.kind).toBe('implicit');
    expect(block.unclosed).toBe(false);
    expect(block.tests).toEqual(['defined', 'none']);
    expect(block.variables.map((v) => v.root)).toEqual(['my_var', 'count', 'flag']);
    expect(block.tokens.some((t) => t.kind === 'operator' && t.value === '>=')).toBe(true);
    expect(block.tokens.some((t) => t.kind === 'literal' && t.value === '3')).toBe(true);
  });

  it('handles statement blocks, comment blocks, whitespace trimmers, and unclosed blocks', () => {
    const stmt = tokenizeJinjaBlock('{%- for item in items -%}', 'statement');
    expect(stmt.kind).toBe('statement');
    expect(stmt.unclosed).toBe(false);
    expect(stmt.variables.map((v) => v.root)).toEqual(['item', 'items']);

    const comment = tokenizeJinjaBlock('{# ignore this {{ var }} #}', 'comment');
    expect(comment.kind).toBe('comment');
    expect(comment.tokens).toEqual([]);
    expect(comment.variables).toEqual([]);
    expect(comment.unclosed).toBe(false);

    const unclosed = tokenizeJinjaBlock('{{ res.stdout | ', 'expression');
    expect(unclosed.unclosed).toBe(true);
    expect(unclosed.variables[0]?.raw).toBe('res.stdout');
  });

  it('extracts multiple Jinja blocks from multiline text including unclosed trailing braces', () => {
    const blocks = extractJinjaBlocksFromText(
      'Hello {{ user.name }} {# note #}\nPort: {{ app_port\nDone: {% if ok %}',
      0,
      0,
      0,
    );
    expect(blocks).toHaveLength(4);
    expect(blocks[0]?.kind).toBe('expression');
    expect(blocks[0]?.unclosed).toBe(false);
    expect(blocks[1]?.kind).toBe('comment');
    expect(blocks[2]?.unclosed).toBe(true);
    expect(blocks[2]?.variables[0]?.root).toBe('app_port');
    expect(blocks[3]?.kind).toBe('statement');
  });
});

describe('Smart Hybrid Activation (`detectAnsibleDocument`)', () => {
  it('rejects Kubernetes, Docker Compose, and GitHub Actions YAML even when ansible.cfg is present', () => {
    const k8s = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n';
    expect(detectAnsibleDocument('file:///deploy/app.yml', k8s, true)).toEqual({
      isAnsible: false,
      kind: 'unknown',
      reason: 'negative-guard:kubernetes',
    });

    const compose =
      'version: "3.9"\nservices:\n  web:\n    image: nginx:latest\nvolumes:\n  data: {}\n';
    expect(detectAnsibleDocument('file:///docker-compose.yml', compose, true)).toEqual({
      isAnsible: false,
      kind: 'unknown',
      reason: 'negative-guard:docker-compose',
    });

    const gha = 'name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n';
    expect(detectAnsibleDocument('file:///.github/workflows/ci.yml', gha, true)).toEqual({
      isAnsible: false,
      kind: 'unknown',
      reason: 'negative-guard:github-actions',
    });
  });

  it('rejects non-YAML extensions outside Ansible directories', () => {
    expect(detectAnsibleDocument('file:///src/app.ts', '- hosts: all\n', true).isAnsible).toBe(
      false,
    );
  });

  it('classifies role tasks, handlers, defaults, vars, group_vars, host_vars, inventory, and playbooks', () => {
    expect(
      detectAnsibleDocument(
        'file:///roles/nginx/tasks/main.yml',
        '- name: install\n  apt: name=nginx\n',
      ).kind,
    ).toBe('tasks');
    expect(
      detectAnsibleDocument('C:\\repo\\roles\\nginx\\handlers\\main.yaml', '- name: restart\n')
        .kind,
    ).toBe('handlers');
    expect(
      detectAnsibleDocument('file:///roles/nginx/defaults/main.yml', 'http_port: 80\n').kind,
    ).toBe('role-defaults');
    expect(detectAnsibleDocument('file:///roles/nginx/vars/Debian.yml', 'pkg: nginx\n').kind).toBe(
      'role-vars',
    );
    expect(detectAnsibleDocument('file:///group_vars/all.yml', 'env: prod\n').kind).toBe(
      'group-vars',
    );
    expect(detectAnsibleDocument('file:///host_vars/web1.yml', 'ip: 10.0.0.1\n').kind).toBe(
      'host-vars',
    );
    expect(
      detectAnsibleDocument('file:///inventory/hosts.yml', 'all:\n  hosts:\n    web1:\n').kind,
    ).toBe('inventory');
    expect(
      detectAnsibleDocument('file:///site.yml', '- hosts: webservers\n  tasks: []\n').kind,
    ).toBe('playbook');
    expect(detectAnsibleDocument('file:///custom.yml', 'all:\n  children:\n    web:\n').kind).toBe(
      'inventory',
    );
    expect(
      detectAnsibleDocument('file:///custom.yml', '- name: ping\n  ansible.builtin.ping:\n').kind,
    ).toBe('tasks');
    expect(detectAnsibleDocument('file:///random.yml', 'foo: bar\n', false).isAnsible).toBe(false);
    expect(detectAnsibleDocument('file:///random.yml', 'foo: bar\n', true).isAnsible).toBe(true);
  });
});

describe('Fault-tolerant YAML CST + Jinja2 AST parser (`parseAnsibleDocument`)', () => {
  it('parses playbooks with plays, vars_files, roles, pre_tasks, tasks, block/rescue/always, post_tasks, handlers, and set_fact', () => {
    const playbook = [
      '---',
      '- name: Configure web tier',
      '  hosts: webservers',
      '  become: true',
      '  vars:',
      '    app_port: 8080',
      '  vars_files:',
      '    - vars/secrets.yml',
      '  roles:',
      '    - common',
      '    - role: nginx',
      '      vars:',
      '        nginx_port: "{{ app_port }}"',
      '  pre_tasks:',
      '    - name: Gather stat',
      '      ansible.builtin.stat:',
      '        path: /etc/nginx/nginx.conf',
      '      register: conf_stat',
      '  tasks:',
      '    - name: Copy config with suboptions',
      '      ansible.builtin.copy:',
      '        src: nginx.conf',
      '        dest: /etc/nginx/nginx.conf',
      '        force: yes',
      '        backup: FALSE',
      '        attributes:',
      '          mode: "0644"',
      '      when: conf_stat.stat.exists is defined',
      '      changed_when: false',
      '      failed_when: conf_stat.failed | default(false)',
      '      notify:',
      '        - Restart nginx',
      '      no_log: true',
      '      become: false',
      '      tags:',
      '        - config',
      '      vars:',
      '        task_var: ok',
      '    - name: Resilient block',
      '      block:',
      '        - name: Set fact',
      '          ansible.builtin.set_fact:',
      '            deployed_version: "1.2.3"',
      '      rescue:',
      '        - name: Rescue shell',
      '          ansible.builtin.command: echo failed',
      '          loop: "{{ [1, 2] }}"',
      '      always:',
      '        - name: Always debug',
      '          ansible.builtin.debug:',
      '            msg: "done {{ deployed_version }}"',
      '  post_tasks:',
      '    - name: Final check',
      '      ansible.builtin.uri:',
      '        url: http://localhost',
      '  handlers:',
      '    - name: Restart nginx',
      '      ansible.builtin.service:',
      '        name: nginx',
      '        state: restarted',
      '',
    ].join('\n');

    const ast = parseAnsibleDocument('file:///site.yml', playbook);
    expect(ast.kind).toBe('playbook');
    expect(ast.syntaxErrors).toEqual([]);
    expect(ast.plays).toHaveLength(1);

    const play = ast.plays[0]!;
    expect(play.name).toBe('Configure web tier');
    expect(play.hosts).toBe('webservers');
    expect(play.become).toBe(true);
    expect(play.varsFiles.map((v) => v.path)).toEqual(['vars/secrets.yml']);
    expect(play.roles.map((r) => r.name)).toEqual(['common', 'nginx']);
    expect(play.roles[1]?.vars).toEqual({ nginx_port: '{{ app_port }}' });

    expect(play.preTasks).toHaveLength(1);
    expect(play.preTasks[0]?.register).toBe('conf_stat');

    // 1 copy task + 3 tasks flattened from block/rescue/always
    expect(play.tasks).toHaveLength(4);
    const copyTask = play.tasks[0]!;
    expect(copyTask.moduleName).toBe('ansible.builtin.copy');
    expect(copyTask.isFqcn).toBe(true);
    expect(copyTask.when).toBe('conf_stat.stat.exists is defined');
    expect(copyTask.changedWhen).toBe(false);
    expect(copyTask.failedWhen).toBe('conf_stat.failed | default(false)');
    expect(copyTask.notify).toEqual(['Restart nginx']);
    expect(copyTask.noLog).toBe(true);
    expect(copyTask.become).toBe(false);
    expect(copyTask.tags).toEqual(['config']);
    expect(copyTask.vars).toEqual({ task_var: 'ok' });

    const attrsParam = copyTask.params.find((p) => p.name === 'attributes');
    expect(attrsParam?.suboptions?.[0]?.name).toBe('mode');

    const shellTask = play.tasks[2]!;
    expect(shellTask.freeFormArg).toBe('echo failed');
    expect(shellTask.loopKind).toBe('loop');

    expect(play.postTasks).toHaveLength(1);
    expect(play.handlers).toHaveLength(1);
    expect(ast.handlers).toHaveLength(1);

    // Raw truthy detection (`force: yes`, `backup: FALSE`)
    expect(ast.rawTruthyValues.map((t) => `${t.key}=${t.rawValue}`)).toEqual([
      'force=yes',
      'backup=FALSE',
    ]);

    // Variables extracted (play vars, role params, task vars, set_fact)
    expect(ast.variables.some((v) => v.name === 'app_port' && v.sourceKind === 'play-vars')).toBe(
      true,
    );
    expect(
      ast.variables.some((v) => v.name === 'deployed_version' && v.sourceKind === 'set-fact'),
    ).toBe(true);
    expect(ast.variables.some((v) => v.name === 'task_var' && v.sourceKind === 'task-vars')).toBe(
      true,
    );

    // Implicit + explicit Jinja blocks extracted
    expect(ast.jinjaBlocks.some((b) => b.kind === 'implicit' && b.tests.includes('defined'))).toBe(
      true,
    );
    expect(
      ast.jinjaBlocks.some(
        (b) => b.kind === 'expression' && b.variables.some((v) => v.root === 'app_port'),
      ),
    ).toBe(true);
  });

  it('detects duplicate keys, Unicode identifiers, CRLF line endings, and preserves partial AST on syntax errors', () => {
    const broken = [
      '- name: Deploy café 🚀',
      '  copy:',
      '    src: a.txt',
      '    src: b.txt',
      '    dest: /tmp/{{ item_name',
      '  with_items:',
      '    - one',
      '  broken_flow: [1, 2',
    ].join('\r\n');

    const ast = parseAnsibleDocument('file:///roles/web/tasks/main.yml', broken);
    expect(ast.kind).toBe('tasks');
    expect(ast.tasks).toHaveLength(1);
    expect(ast.tasks[0]?.name).toBe('Deploy café 🚀');
    expect(ast.tasks[0]?.moduleName).toBe('copy');
    expect(ast.tasks[0]?.isFqcn).toBe(false);
    expect(ast.tasks[0]?.loopKind).toBe('with_items');
    expect(ast.duplicateKeys.map((d) => d.key)).toEqual(['src']);
    expect(ast.syntaxErrors.length).toBeGreaterThan(0);
    expect(
      ast.jinjaBlocks.some((b) => b.unclosed && b.variables.some((v) => v.root === 'item_name')),
    ).toBe(true);
  });

  it('extracts variable declarations from role-defaults, role-vars, group-vars, host-vars, inventory, and standalone handlers', () => {
    const varsYaml = 'http_port: 8080\nenabled: yes\napp_url: "http://{{ host }}"\n';
    const defaultsAst = parseAnsibleDocument('file:///roles/web/defaults/main.yml', varsYaml);
    expect(defaultsAst.kind).toBe('role-defaults');
    expect(defaultsAst.variables).toHaveLength(3);
    expect(defaultsAst.variables[0]?.sourceKind).toBe('role-defaults');
    expect(defaultsAst.rawTruthyValues.map((r) => r.rawValue)).toEqual(['yes']);
    expect(defaultsAst.jinjaBlocks.some((b) => b.variables.some((v) => v.root === 'host'))).toBe(
      true,
    );

    expect(
      parseAnsibleDocument('file:///roles/web/vars/main.yml', 'x: 1\n').variables[0]?.sourceKind,
    ).toBe('role-vars');
    expect(
      parseAnsibleDocument('file:///group_vars/all.yml', 'x: 1\n').variables[0]?.sourceKind,
    ).toBe('playbook-group-vars');
    expect(
      parseAnsibleDocument('file:///host_vars/db1.yml', 'x: 1\n').variables[0]?.sourceKind,
    ).toBe('playbook-host-vars');
    expect(
      parseAnsibleDocument('file:///inventory/hosts.yml', 'all: {}\n').variables[0]?.sourceKind,
    ).toBe('inventory-file');

    const handlersYaml = [
      '- name: Reload systemd',
      '  ansible.builtin.systemd:',
      '    daemon_reload: true',
      '  args:',
      '    no_block: false',
      '  when:',
      '    - ansible_os_family == "Debian"',
      '    - reload_ok is defined',
      '  notify: Second handler',
      '  tags: system',
      '  until: true',
    ].join('\n');
    const handlersAst = parseAnsibleDocument('file:///roles/web/handlers/main.yml', handlersYaml);
    expect(handlersAst.kind).toBe('handlers');
    expect(handlersAst.handlers).toHaveLength(1);
    expect(handlersAst.handlers[0]?.notify).toEqual(['Second handler']);
    expect(handlersAst.handlers[0]?.tags).toEqual(['system']);
    expect(handlersAst.handlers[0]?.when).toBe(
      'ansible_os_family == "Debian" and reload_ok is defined',
    );
    expect(handlersAst.handlers[0]?.params.some((p) => p.name === 'no_block')).toBe(true);
  });

  it('handles block vars, block conditionals, role dict with name key, nested vars_files, and incomplete tasks', () => {
    const yaml = [
      '- hosts: all',
      '  vars_files:',
      '    - [a.yml, b.yml]',
      '  roles:',
      '    - name: base_role',
      '      custom_param: 42',
      '  tasks:',
      '    - block:',
      '        - name: Incomplete task while typing',
      '      vars:',
      '        blk_var: hello',
      '      when: blk_var is defined',
    ].join('\n');

    const ast = parseAnsibleDocument('file:///site.yml', yaml);
    expect(ast.plays[0]?.varsFiles.map((f) => f.path)).toEqual(['a.yml', 'b.yml']);
    expect(ast.plays[0]?.roles[0]?.name).toBe('base_role');
    expect(ast.plays[0]?.roles[0]?.vars).toEqual({ custom_param: 42 });
    expect(ast.tasks[0]?.moduleName).toBe('');
    expect(ast.variables.some((v) => v.name === 'blk_var' && v.sourceKind === 'block-vars')).toBe(
      true,
    );
  });

  it('handles play-level boolean strings, duplicate keys in nested dicts, non-FQCN tasks, and playbooks with non-map items', () => {
    const yaml = [
      '- hosts: "{{ target_hosts }}"',
      '  become: no',
      '  gather_facts: false',
      '  custom_play_extra: "{{ extra }}"',
      '  tasks:',
      '    - name: Task with string truthy become and nested dup key',
      '      ping:',
      '        data: pong',
      '        data: pong2',
      '      become: "off"',
      '      no_log: "no"',
      '      changed_when: "rc != 0"',
      '      failed_when: "false"',
      '      notify:',
      '        - notify_one',
      '      delegate_to: "{{ jump_host }}"',
      '    - name: Task with string become yes',
      '      debug:',
      '        msg: hi',
      '      become: "yes"',
      '      no_log: "on"',
    ].join('\n');

    const ast = parseAnsibleDocument('file:///playbook.yml', yaml);
    expect(ast.plays[0]?.become).toBe(false);
    expect(ast.tasks[0]?.become).toBe(false);
    expect(ast.tasks[0]?.noLog).toBe(false);
    expect(ast.tasks[0]?.duplicateKeys.map((d) => d.key)).toEqual(['data']);
    expect(ast.tasks[1]?.become).toBe(true);
    expect(ast.tasks[1]?.noLog).toBe(true);
    expect(ast.rawTruthyValues.some((r) => r.rawValue === 'no')).toBe(true);
  });
});
