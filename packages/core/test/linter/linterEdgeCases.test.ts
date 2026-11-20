import { describe, expect, it } from 'vitest';
import { lintAnsibleDocument } from '../../src/linter/index.js';
import { MetadataRegistry } from '../../src/metadata/index.js';
import {
  createTestMetadataRegistry,
  makeAst,
  makeParam,
  makePlay,
  makeRange,
  makeTask,
  makeVariableDecl,
} from '../intelligence/testFixtures.js';

describe('lintAnsibleDocument — edge cases & resilience', () => {
  it('validates int, float, list, dict type mismatches and complex task locations', () => {
    const registry = createTestMetadataRegistry();
    registry.registerModule({
      fqcn: 'ansible.builtin.wait_for',
      shortName: 'wait_for',
      collection: 'ansible.builtin',
      shortDescription: 'Wait for condition',
      description: 'Wait for condition',
      docUrl: 'https://docs.ansible.com/wait_for_module.html',
      options: {
        port: { name: 'port', type: 'int', description: 'Port' },
        delay: { name: 'delay', type: 'float', description: 'Delay' },
        search_regex: { name: 'search_regex', type: 'str', description: 'Regex' },
        exclude_hosts: { name: 'exclude_hosts', type: 'list', description: 'Hosts' },
        headers: { name: 'headers', type: 'dict', description: 'Headers' },
      },
      returnFields: {},
    });

    const ast = makeAst('file:///ws/tasks.yml', 'tasks', {
      tasks: [
        makeTask('ansible.builtin.wait_for', {
          name: 'Check types',
          params: [
            makeParam('port', 80.5), // float instead of int
            makeParam('delay', 'fast'), // str instead of float
            makeParam('exclude_hosts', 'localhost'), // str instead of list
            makeParam('headers', ['a', 'b']), // list instead of dict
            makeParam('free_form', 'ignored'),
            makeParam('search_regex', null),
          ],
          range: makeRange(1, 2, 10),
        }),
      ],
      handlers: [
        makeTask('service', {
          name: 'Restart nginx',
          isFqcn: false,
          range: makeRange(10, 2, 100),
        }),
      ],
      plays: [
        makePlay({
          preTasks: [
            makeTask('ansible.builtin.file', {
              name: 'Remove absent file without mode',
              params: [makeParam('path', '/tmp/old'), makeParam('state', 'absent')],
              range: makeRange(15, 2, 150),
            }),
          ],
          postTasks: [
            makeTask('ansible.builtin.file', {
              name: 'World writable mode 777',
              params: [makeParam('path', '/tmp/open'), makeParam('mode', 777)],
              range: makeRange(20, 2, 200),
            }),
          ],
        }),
      ],
    });

    const diags = lintAnsibleDocument(ast, registry);
    const mismatches = diags.filter((d) => d.ruleId === 'param-type-mismatch');
    expect(mismatches).toHaveLength(4);
    expect(diags.some((d) => d.ruleId === 'fqcn')).toBe(true);
    expect(
      diags.some((d) => d.ruleId === 'risky-file-permissions' && d.message.includes('777')),
    ).toBe(true);
    // absent file deletion does not require mode
    expect(diags.filter((d) => d.ruleId === 'risky-file-permissions')).toHaveLength(1);
  });

  it('handles unknown modules cleanly when registry is empty and emits Quick-Fix for command replacements', () => {
    const emptyRegistry = new MetadataRegistry();
    const ast = makeAst('file:///ws/site.yml', 'playbook', {
      variables: [
        makeVariableDecl('password_lock', 'true', 'play-vars'),
        makeVariableDecl('api_key', '', 'play-vars'),
        makeVariableDecl('auth_token', 12345 as unknown, 'play-vars'),
      ],
      plays: [
        makePlay({
          tasks: [
            makeTask('command', {
              name: 'Install package via apt',
              isFqcn: false,
              params: [makeParam('cmd', 'apt-get install -y nginx')],
              range: makeRange(2, 2, 20),
            }),
            makeTask('shell', {
              name: 'Restart via systemctl',
              isFqcn: false,
              freeFormArg: 'systemctl restart nginx',
              range: makeRange(6, 2, 60),
            }),
            makeTask('ansible.builtin.command', {
              name: 'Unpack tar archive',
              freeFormArg: '/usr/bin/tar -xzf archive.tar.gz',
              changedWhen: true,
              range: makeRange(10, 2, 100),
            }),
            makeTask('ansible.builtin.custom_unknown', {
              name: 'Custom',
              params: [makeParam('password_lock', 'true'), makeParam('token', '')],
              range: makeRange(14, 2, 140),
            }),
          ],
        }),
      ],
    });

    const diags = lintAnsibleDocument(ast, emptyRegistry);
    expect(diags.some((d) => d.ruleId === 'unknown-module')).toBe(false);
    expect(diags.filter((d) => d.ruleId === 'command-instead-of-module')).toHaveLength(3);
    expect(diags.some((d) => d.ruleId === 'hardcoded-secret')).toBe(false);
  });

  it('handles deduplicated duplicate-keys and rawTruthyValues plus malformed choices/params', () => {
    const registry = createTestMetadataRegistry();
    registry.registerModule({
      fqcn: 'community.general.custom_mod',
      shortName: 'custom_mod',
      collection: 'community.general',
      shortDescription: 'Custom mod',
      description: 'Custom mod',
      docUrl: '',
      deprecated: {
        why: 'Old module',
      },
      options: {
        mode_choice: {
          name: 'mode_choice',
          type: 'str',
          choices: ['fast', 'slow'],
          description: 'Mode choice',
        },
        nested: {
          name: 'nested',
          type: 'dict',
          aliases: ['nest'],
          description: 'Nested',
          suboptions: {
            flag: {
              name: 'flag',
              type: 'bool',
              description: 'Flag',
            },
          },
        },
      },
      returnFields: {},
    });

    const dupRange = makeRange(4, 2, 40);
    const truthyRange = makeRange(5, 8, 55);
    const ast = makeAst('file:///ws/site.yml', 'playbook', {
      duplicateKeys: [{ key: 'msg', range: dupRange }],
      rawTruthyValues: [{ key: 'become', rawValue: 'True', range: truthyRange }],
      plays: [
        makePlay({
          tasks: [
            makeTask('custom_mod', {
              name: 'Test community module',
              isFqcn: false,
              duplicateKeys: [{ key: 'msg', range: dupRange }],
              rawTruthyKeys: [{ key: 'become', rawValue: 'True', range: truthyRange }],
              params: [
                makeParam('mode_choice', 'zzzzzzzzzz'),
                makeParam('completely_unexpected_param_xyz', 'val'),
                makeParam('nest', { flag: true }, { suboptions: [makeParam('flag', true)] }),
              ],
              range: makeRange(3, 2, 30),
            }),
          ],
        }),
      ],
    });

    const diags = lintAnsibleDocument(ast, registry);
    expect(diags.filter((d) => d.ruleId === 'duplicate-keys')).toHaveLength(1);
    expect(diags.filter((d) => d.ruleId === 'yaml-truthy')).toHaveLength(1);
    expect(diags.some((d) => d.ruleId === 'deprecated-module' && d.quickFixes.length === 0)).toBe(
      true,
    );
    expect(
      diags.some(
        (d) =>
          d.ruleId === 'fqcn' &&
          d.quickFixes[0]?.edits[0]?.newText === 'community.general.custom_mod',
      ),
    ).toBe(true);
    expect(diags.some((d) => d.ruleId === 'invalid-choice' && d.quickFixes.length === 0)).toBe(
      true,
    );
    expect(diags.some((d) => d.ruleId === 'unknown-param' && d.quickFixes.length === 0)).toBe(true);
  });
});
