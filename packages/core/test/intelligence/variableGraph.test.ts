import { describe, expect, it } from 'vitest';
import {
  ANSIBLE_PRECEDENCE_LEVELS,
  PRECEDENCE_TABLE,
  WorkspaceVariableGraph,
} from '../../src/intelligence/index.js';
import type { VariableSourceKind } from '../../src/contracts/types.js';
import {
  makeAst,
  makeParam,
  makePlay,
  makeRange,
  makeTask,
  makeVariableDecl,
} from './testFixtures.js';

describe('WorkspaceVariableGraph & 22-level precedence resolver', () => {
  it('defines all 22 official Ansible precedence levels in ascending order', () => {
    expect(ANSIBLE_PRECEDENCE_LEVELS).toHaveLength(22);
    for (let i = 0; i < 22; i++) {
      expect(ANSIBLE_PRECEDENCE_LEVELS[i]?.level).toBe(i + 1);
    }

    const orderedKinds: VariableSourceKind[] = [
      'role-defaults',
      'inventory-file',
      'playbook-group-vars-all',
      'inventory-group-vars',
      'playbook-group-vars',
      'inventory-host-vars',
      'playbook-host-vars',
      'host-facts',
      'play-vars',
      'play-vars-prompt',
      'play-vars-files',
      'role-vars',
      'block-vars',
      'task-vars',
      'include-vars',
      'set-fact',
      'role-params',
      'include-params',
      'extra-vars',
    ];

    for (let i = 1; i < orderedKinds.length; i++) {
      const prev = PRECEDENCE_TABLE[orderedKinds[i - 1]!];
      const curr = PRECEDENCE_TABLE[orderedKinds[i]!];
      expect(curr.level).toBeGreaterThan(prev.level);
    }
  });

  it('classifies document URIs and kinds accurately across all precedence scopes', () => {
    const graph = new WorkspaceVariableGraph();

    expect(
      graph.classifyVariableSource('file:///ws/roles/web/defaults/main.yml', 'role-defaults')
        .precedenceLevel,
    ).toBe(2);
    expect(
      graph.classifyVariableSource('file:///ws/inventory/hosts.ini', 'inventory').precedenceLevel,
    ).toBe(3);
    expect(
      graph.classifyVariableSource('file:///ws/inventories/prod/group_vars/all.yml', 'group-vars')
        .precedenceLevel,
    ).toBe(4);
    expect(
      graph.classifyVariableSource('file:///ws/group_vars/all.yml', 'group-vars').precedenceLevel,
    ).toBe(5);
    expect(
      graph.classifyVariableSource('file:///ws/inventory/prod/group_vars/web.yml', 'group-vars')
        .precedenceLevel,
    ).toBe(6);
    expect(
      graph.classifyVariableSource('file:///ws/group_vars/web.yml', 'group-vars').precedenceLevel,
    ).toBe(7);
    expect(
      graph.classifyVariableSource('file:///ws/inventories/prod/host_vars/db1.yml', 'host-vars')
        .precedenceLevel,
    ).toBe(9);
    expect(
      graph.classifyVariableSource('file:///ws/host_vars/db1.yml', 'host-vars').precedenceLevel,
    ).toBe(10);
    expect(
      graph.classifyVariableSource('file:///ws/vars/secrets.yml', 'unknown').precedenceLevel,
    ).toBe(14);
    expect(
      graph.classifyVariableSource('file:///ws/roles/web/vars/main.yml', 'role-vars')
        .precedenceLevel,
    ).toBe(15);
    expect(graph.classifyVariableSource('file:///ws/site.yml', 'playbook').precedenceLevel).toBe(
      12,
    );
  });

  it('indexes multiple documents, resolves winning vs shadowed definitions, and supports removeDocument', () => {
    const graph = new WorkspaceVariableGraph();

    const defaultsAst = makeAst('file:///ws/roles/web/defaults/main.yml', 'role-defaults', {
      variables: [makeVariableDecl('app_port', 80, 'play-vars')],
    });
    const groupVarsAst = makeAst('file:///ws/group_vars/all.yml', 'group-vars', {
      variables: [makeVariableDecl('app_port', 8080, 'play-vars')],
    });
    const roleVarsAst = makeAst('file:///ws/roles/web/vars/main.yml', 'role-vars', {
      variables: [makeVariableDecl('app_port', 8443, 'play-vars')],
    });
    const playbookAst = makeAst('file:///ws/site.yml', 'playbook', {
      variables: [makeVariableDecl('app_port', 9000, 'play-vars')],
      plays: [
        makePlay({
          vars: { app_port: 9000, play_only_var: 'hello' },
          roles: [
            {
              name: 'web',
              range: makeRange(3, 6, 30),
              vars: { app_port: 9443 },
            },
          ],
          tasks: [
            makeTask('ansible.builtin.set_fact', {
              params: [makeParam('app_port', 9555), makeParam('cacheable', true)],
              range: makeRange(5, 4, 60),
            }),
            makeTask('ansible.builtin.command', {
              register: 'cmd_out',
              vars: { task_scoped: 'local' },
              range: makeRange(7, 4, 90),
            }),
            makeTask('ansible.builtin.include_role', {
              params: [
                makeParam('name', 'db'),
                makeParam(
                  'vars',
                  { db_port: 5432 },
                  {
                    suboptions: [makeParam('db_port', 5432)],
                  },
                ),
              ],
              range: makeRange(9, 4, 120),
            }),
            makeTask('ansible.builtin.include_tasks', {
              params: [
                makeParam('file', 'sub.yml'),
                makeParam(
                  'vars',
                  { include_param: 'yes' },
                  {
                    suboptions: [makeParam('include_param', 'yes')],
                  },
                ),
              ],
              range: makeRange(11, 4, 150),
            }),
          ],
        }),
      ],
    });

    graph.indexDocument(defaultsAst);
    graph.indexDocument(groupVarsAst);
    graph.indexDocument(roleVarsAst);
    graph.indexDocument(playbookAst);

    const resolvedPort = graph.resolveVariable('app_port');
    expect(resolvedPort).toBeDefined();
    // role_params (20) beats set_fact (19), role_vars (15), play_vars (12), group_vars/all (5), role_defaults (2)
    expect(resolvedPort?.winningDefinition.precedenceLevel).toBe(20);
    expect(resolvedPort?.winningDefinition.value).toBe(9443);
    expect(resolvedPort?.shadowedDefinitions.length).toBeGreaterThanOrEqual(4);

    expect(graph.resolveVariable('play_only_var')?.winningDefinition.precedenceLevel).toBe(12);
    expect(graph.resolveVariable('task_scoped')?.winningDefinition.precedenceLevel).toBe(17);
    expect(graph.resolveVariable('cmd_out')?.winningDefinition.precedenceLevel).toBe(19);
    expect(graph.resolveVariable('db_port')?.winningDefinition.precedenceLevel).toBe(20);
    expect(graph.resolveVariable('include_param')?.winningDefinition.precedenceLevel).toBe(21);
    expect(graph.resolveVariable('cacheable')).toBeUndefined();

    expect(graph.listVariables().length).toBeGreaterThanOrEqual(6);

    // Re-indexing or removing playbook drops its definitions cleanly
    graph.removeDocument('file:///ws/site.yml');
    const afterRemove = graph.resolveVariable('app_port');
    expect(afterRemove?.winningDefinition.precedenceLevel).toBe(15);
    expect(afterRemove?.winningDefinition.value).toBe(8443);
    expect(graph.resolveVariable('cmd_out')).toBeUndefined();

    // Removing an unknown URI is a safe no-op
    graph.removeDocument('file:///ws/never_indexed.yml');

    // Explicit inventory group_vars/all resolves to level 4
    expect(
      graph.resolvePrecedenceForSourceKind(
        'inventory-group-vars',
        'file:///ws/inventories/prod/group_vars/all.yml',
      ).level,
    ).toBe(4);
    expect(
      graph.resolvePrecedenceForSourceKind(
        'inventory-group-vars',
        'file:///ws/inventories/prod/group_vars/db.yml',
      ).level,
    ).toBe(6);

    // Re-indexing an existing document replaces previous values
    const updatedDefaults = makeAst('file:///ws/roles/web/defaults/main.yml', 'role-defaults', {
      variables: [makeVariableDecl('new_default_var', { nested: true }, 'role-defaults')],
      tasks: [
        makeTask('ansible.builtin.debug', {
          vars: { obj_var: { nested: true } },
          range: makeRange(2, 2, 15),
        }),
      ],
    });
    graph.indexDocument(updatedDefaults);
    expect(graph.resolveVariable('new_default_var')?.winningDefinition.value).toEqual({
      nested: true,
    });
    expect(graph.resolveVariable('obj_var')?.winningDefinition.rawValue).toBe('{"nested":true}');
  });
});
