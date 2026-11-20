import { describe, expect, it } from 'vitest';
import type { IWorkspaceFs } from '../../src/contracts/types.js';
import { checkProjectIntegrity } from '../../src/intelligence/index.js';
import { makeAst, makeParam, makePlay, makeRange, makeTask } from './testFixtures.js';

function createMemoryFs(files: Record<string, string>, dirs: readonly string[] = []): IWorkspaceFs {
  const fileMap = new Map<string, string>(Object.entries(files));
  const dirSet = new Set<string>(dirs);

  return {
    exists(filePath: string): boolean {
      const normalized = filePath.replace(/\\/g, '/');
      if (fileMap.has(normalized) || dirSet.has(normalized)) {
        return true;
      }
      const prefix = normalized.endsWith('/') ? normalized : `${normalized}/`;
      for (const key of fileMap.keys()) {
        if (key.startsWith(prefix)) {
          return true;
        }
      }
      return false;
    },
    readFile(filePath: string): string | undefined {
      return fileMap.get(filePath.replace(/\\/g, '/'));
    },
    listFiles(dirPath: string): readonly string[] {
      const normalized = dirPath.replace(/\\/g, '/').replace(/\/+$/, '');
      const prefix = `${normalized}/`;
      const results = new Set<string>();
      for (const key of fileMap.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const firstSegment = rest.split('/')[0];
          if (firstSegment) {
            results.add(`${prefix}${firstSegment}`);
          }
        }
      }
      for (const dir of dirSet) {
        if (dir.startsWith(prefix)) {
          const rest = dir.slice(prefix.length);
          const firstSegment = rest.split('/')[0];
          if (firstSegment) {
            results.add(`${prefix}${firstSegment}`);
          }
        }
      }
      return Array.from(results);
    },
  };
}

describe('checkProjectIntegrity', () => {
  it('flags missing roles, missing role tasks/main.yml, missing handlers, missing src files, and unknown inventory hosts', () => {
    const fs = createMemoryFs(
      {
        '/ws/inventory.yml': [
          'all:',
          '  children:',
          '    webservers:',
          '      hosts:',
          '        web01:',
          '    databases:',
          '      hosts:',
          '        db01:',
        ].join('\n'),
        '/ws/roles/empty_role/README.md': '# empty role',
        '/ws/roles/nginx/tasks/main.yml':
          '- name: install\n  ansible.builtin.debug:\n    msg: ok\n',
        '/ws/roles/nginx/handlers/main.yml':
          '- name: Restart nginx\n  ansible.builtin.service:\n    name: nginx\n    state: restarted\n',
        '/ws/files/present.conf': 'ok',
      },
      ['/ws/roles/empty_role', '/ws/roles/nginx'],
    );

    const ast = makeAst('file:///ws/site.yml', 'playbook', {
      plays: [
        makePlay({
          hosts: 'webserverz',
          hostsRange: makeRange(1, 9, 12, 1, 19, 22),
          roles: [
            { name: 'nonexistent_role', range: makeRange(3, 6, 35) },
            { name: 'empty_role', range: makeRange(4, 6, 60) },
            { name: '../bad_role', range: makeRange(5, 6, 80) },
            { name: 'nginx', range: makeRange(6, 6, 100) },
          ],
          tasks: [
            makeTask('ansible.builtin.include_role', {
              params: [makeParam('name', 'missing_dynamic_role')],
              range: makeRange(8, 4, 120),
            }),
            makeTask('ansible.builtin.copy', {
              params: [makeParam('src', 'missing.conf'), makeParam('dest', '/etc/missing.conf')],
              notify: ['Restrt nginx'],
              notifyRange: makeRange(12, 6, 180),
              range: makeRange(10, 4, 150),
            }),
            makeTask('ansible.builtin.template', {
              params: [makeParam('src', 'app.j2'), makeParam('dest', '/etc/app.conf')],
              range: makeRange(14, 4, 210),
            }),
            makeTask('ansible.builtin.copy', {
              params: [makeParam('src', '{{ dynamic_src }}'), makeParam('dest', '/etc/dyn.conf')],
              range: makeRange(16, 4, 240),
            }),
          ],
        }),
      ],
    });

    const diagnostics = checkProjectIntegrity(ast, '/ws', fs);
    const ruleIds = diagnostics.map((d) => d.ruleId);

    expect(ruleIds).toContain('unknown-inventory-host');
    const hostDiag = diagnostics.find((d) => d.ruleId === 'unknown-inventory-host');
    expect(hostDiag?.message).toContain("Did you mean 'webservers'?");

    const missingRoles = diagnostics.filter((d) => d.ruleId === 'missing-role');
    expect(missingRoles.length).toBe(3);

    expect(ruleIds).toContain('missing-role-tasks');

    const handlerDiag = diagnostics.find((d) => d.ruleId === 'missing-handler');
    expect(handlerDiag?.message).toContain("Did you mean 'Restart nginx'?");

    const srcDiags = diagnostics.filter((d) => d.ruleId === 'missing-src-file');
    expect(srcDiags.length).toBe(2);
  });

  it('passes cleanly when roles, handlers, src files, and INI inventory targets exist', () => {
    const fs = createMemoryFs({
      '/ws/hosts.ini': '[web]\nweb1 ansible_host=10.0.0.1\n\n[web:vars]\nhttp_port=80\n',
      '/ws/roles/common/tasks/main.yml': '- name: noop\n  ansible.builtin.debug:\n    msg: hi\n',
      '/ws/roles/common/files/motd.txt': 'Welcome',
      '/ws/templates/nginx.conf.j2': 'server {}',
    });

    const ast = makeAst('file:///ws/roles/common/tasks/sub.yml', 'tasks', {
      plays: [
        makePlay({
          hosts: 'web:localhost',
          roles: [{ name: 'common', range: makeRange(2, 6, 20) }],
          handlers: [
            makeTask('ansible.builtin.debug', {
              name: 'Reload app',
              params: [makeParam('listen', 'reload-topic')],
              range: makeRange(20, 4, 200),
            }),
          ],
          tasks: [
            makeTask('ansible.builtin.template', {
              params: [
                makeParam('src', 'nginx.conf.j2'),
                makeParam('dest', '/etc/nginx/nginx.conf'),
              ],
              notify: ['reload-topic'],
            }),
          ],
        }),
      ],
      tasks: [
        makeTask('ansible.builtin.copy', {
          params: [makeParam('src', 'motd.txt'), makeParam('dest', '/etc/motd')],
          range: makeRange(30, 2, 300),
        }),
      ],
    });

    const diagnostics = checkProjectIntegrity(ast, '/ws', fs);
    expect(diagnostics).toEqual([]);
  });

  it('handles Windows file URIs, malformed YAML files gracefully, and handlers with no close suggestion', () => {
    const fs = createMemoryFs({
      '/ws/inventory.yml': [
        'all:',
        '  vars:',
        '    ansible_python_interpreter: /usr/bin/python3',
        '  children:',
        '    app:',
        '      hosts:',
        '        app01:',
      ].join('\n'),
      '/ws/inventory': '; comment line\n# another comment\n\n[db]\ndb01\n',
      '/ws/handlers/main.yaml':
        '- name: Completely Different Handler\n  listen:\n    - diff-topic\n  ansible.builtin.debug:\n    msg: ok\n',
      '/ws/roles/web/handlers/main.yml': ':::not valid yaml:::',
    });

    const ast = makeAst('file:///C:/ws/playbooks/site.yml', 'playbook', {
      plays: [
        makePlay({
          hosts: 'all',
          tasks: [
            makeTask('ansible.builtin.copy', {
              params: [
                makeParam('src', '/abs/missing.conf'),
                makeParam('dest', '/etc/missing.conf'),
              ],
              notify: ['zzzz_nonexistent_handler'],
            }),
          ],
        }),
      ],
    });

    const diagnostics = checkProjectIntegrity(ast, '/ws', fs);
    expect(diagnostics.some((d) => d.ruleId === 'missing-handler')).toBe(true);
    expect(diagnostics.some((d) => d.ruleId === 'missing-src-file')).toBe(true);
  });
});
