import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { IWorkspaceFs, TaskNode } from '../../src/contracts/types.js';
import {
  WorkspaceVariableGraph,
  checkProjectIntegrity,
  inferRegisteredVariables,
} from '../../src/intelligence/index.js';
import { lintAnsibleDocument } from '../../src/linter/index.js';
import {
  createTestMetadataRegistry,
  makeAst,
  makeParam,
  makePlay,
  makeRange,
  makeTask,
  makeVariableDecl,
} from '../intelligence/testFixtures.js';

describe('Intelligence & Linter Performance Budget (< 20ms)', () => {
  it('processes variable indexing, return-value inference, project integrity, and all lint rules on a 50+ task (300+ line) playbook AST in < 20ms', () => {
    const registry = createTestMetadataRegistry();
    const tasks: TaskNode[] = [];
    const lines: string[] = [
      '- name: Large production playbook',
      '  hosts: webservers',
      '  tasks:',
    ];

    for (let i = 0; i < 60; i++) {
      const startLine = 3 + i * 5;
      lines.push(
        `    - name: Task ${i}`,
        `      ansible.builtin.copy:`,
        `        src: app.conf`,
        `        dest: /etc/app-${i}.conf`,
        `        mode: '0644'`,
      );
      tasks.push(
        makeTask('ansible.builtin.copy', {
          name: `Task ${i}`,
          register: `copy_res_${i}`,
          ...(i % 3 === 0 ? { loop: ['a', 'b'], loopKind: 'loop' as const } : {}),
          params: [
            makeParam('src', 'app.conf', {
              keyRange: makeRange(startLine + 2, 8, startLine * 40 + 10),
              valueRange: makeRange(startLine + 2, 13, startLine * 40 + 15),
            }),
            makeParam('dest', `/etc/app-${i}.conf`, {
              keyRange: makeRange(startLine + 3, 8, startLine * 40 + 20),
              valueRange: makeRange(startLine + 3, 14, startLine * 40 + 26),
            }),
            makeParam('mode', '0644', {
              keyRange: makeRange(startLine + 4, 8, startLine * 40 + 30),
              valueRange: makeRange(startLine + 4, 14, startLine * 40 + 36),
            }),
          ],
          range: makeRange(startLine, 4, startLine * 40, startLine + 4, 20, startLine * 40 + 38),
          moduleRange: makeRange(startLine + 1, 6, startLine * 40 + 4),
        }),
      );
    }

    expect(lines.length).toBeGreaterThanOrEqual(300);

    const ast = makeAst('file:///ws/site.yml', 'playbook', {
      text: lines.join('\n'),
      variables: [
        makeVariableDecl('http_port', 8080, 'play-vars'),
        makeVariableDecl('app_env', 'production', 'play-vars'),
      ],
      plays: [
        makePlay({
          name: 'Large production playbook',
          hosts: 'webservers',
          roles: [{ name: 'common', range: makeRange(1, 4, 20) }],
          tasks,
        }),
      ],
    });

    const mockFs: IWorkspaceFs = {
      exists: (p) =>
        p === '/ws/hosts.ini' ||
        p === '/ws/roles/common/tasks/main.yml' ||
        p === '/ws/files/app.conf',
      readFile: (p) => (p === '/ws/hosts.ini' ? '[webservers]\nweb1\n' : undefined),
      listFiles: () => [],
    };

    const graph = new WorkspaceVariableGraph();

    // Warmup pass for JIT stability
    graph.indexDocument(ast);
    inferRegisteredVariables(ast, registry);
    checkProjectIntegrity(ast, '/ws', mockFs);
    lintAnsibleDocument(ast, registry);

    const start = performance.now();
    graph.indexDocument(ast);
    const inferred = inferRegisteredVariables(ast, registry);
    const integrityDiags = checkProjectIntegrity(ast, '/ws', mockFs);
    const lintDiags = lintAnsibleDocument(ast, registry);
    const elapsedMs = performance.now() - start;

    expect(inferred.size).toBe(60);
    expect(integrityDiags).toEqual([]);
    expect(lintDiags).toEqual([]);
    expect(elapsedMs).toBeLessThan(20);
  });
});
