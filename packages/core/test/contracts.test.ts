import { describe, expect, it } from 'vitest';
import {
  MetadataRegistry,
  WorkspaceVariableGraph,
  checkProjectIntegrity,
  createDefaultMetadataRegistry,
  detectAnsibleDocument,
  inferRegisteredVariables,
  lintAnsibleDocument,
  parseAnsibleDocument,
  tokenizeJinjaBlock,
} from '../src/index.js';
import type { CollectionMetadataPack, IWorkspaceFs, ModuleMetadataSpec } from '../src/index.js';

describe('@ansible-lens/core contracts scaffold', () => {
  it('tokenizes a Jinja2 block and parses an Ansible document contract', () => {
    const tokenBlock = tokenizeJinjaBlock('{{ app_port }}', 'expression', 0, 0, 0);
    expect(tokenBlock.kind).toBe('expression');
    expect(tokenBlock.unclosed).toBe(false);

    const heuristic = detectAnsibleDocument('file:///site.yml', '- hosts: all\n', true);
    expect(heuristic.isAnsible).toBe(true);

    const ast = parseAnsibleDocument('file:///site.yml', '- hosts: all\n', 'playbook');
    expect(ast.kind).toBe('playbook');
  });

  it('registers and resolves module metadata by FQCN and short name', () => {
    const defaultRegistry = createDefaultMetadataRegistry();
    expect(defaultRegistry).toBeInstanceOf(MetadataRegistry);
    const registry = new MetadataRegistry();

    const copyMod: ModuleMetadataSpec = {
      fqcn: 'ansible.builtin.copy',
      shortName: 'copy',
      collection: 'ansible.builtin',
      shortDescription: 'Copy files to remote locations',
      description: 'Copies a file from the local box to remote locations.',
      docUrl:
        'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/copy_module.html',
      options: {},
      returnFields: {},
    };
    const customCopyMod: ModuleMetadataSpec = {
      fqcn: 'community.general.copy',
      shortName: 'copy',
      collection: 'community.general',
      shortDescription: 'Custom copy',
      description: 'Custom copy module.',
      docUrl: 'https://docs.ansible.com/',
      options: {},
      returnFields: {},
    };

    const pack: CollectionMetadataPack = {
      schemaVersion: 1,
      collection: 'ansible.builtin',
      version: '2.16.3',
      generatedAt: '2026-11-20T00:00:00Z',
      modules: {
        'ansible.builtin.copy': copyMod,
      },
    };

    registry.loadPack(pack);
    registry.registerModule(customCopyMod);

    expect(registry.getModule('ansible.builtin.copy')?.fqcn).toBe('ansible.builtin.copy');
    expect(registry.getModule('copy')?.fqcn).toBe('ansible.builtin.copy');
    expect(registry.getModule('nonexistent')).toBeUndefined();
    expect(registry.resolveFqcn('ansible.builtin.copy')).toHaveLength(1);
    expect(registry.resolveFqcn('copy')).toHaveLength(2);
    expect(registry.resolveFqcn('missing')).toHaveLength(0);
    expect(registry.listModules()).toHaveLength(2);
    expect(registry.listCollections()).toContain('ansible.builtin');
  });

  it('resolves variables in WorkspaceVariableGraph and runs intelligence/linter contracts', () => {
    const graph = new WorkspaceVariableGraph();
    expect(graph.resolveVariable('missing')).toBeUndefined();

    const range = {
      start: { line: 0, column: 0, offset: 0 },
      end: { line: 0, column: 10, offset: 10 },
    };
    graph.addDefinition({
      name: 'http_port',
      value: 80,
      rawValue: '80',
      precedenceLevel: 2,
      precedenceLabel: 'role defaults',
      sourceKind: 'role-defaults',
      uri: 'file:///roles/web/defaults/main.yml',
      range,
    });
    graph.addDefinition({
      name: 'http_port',
      value: 8080,
      rawValue: '8080',
      precedenceLevel: 12,
      precedenceLabel: 'play vars',
      sourceKind: 'play-vars',
      uri: 'file:///site.yml',
      range,
    });

    const resolved = graph.resolveVariable('http_port');
    expect(resolved?.winningDefinition.value).toBe(8080);
    expect(resolved?.shadowedDefinitions).toHaveLength(1);
    expect(graph.listVariables()).toHaveLength(1);

    const ast = parseAnsibleDocument('file:///site.yml', '');
    graph.indexDocument(ast);

    const registry = createDefaultMetadataRegistry();
    expect(inferRegisteredVariables(ast, registry).size).toBe(0);
    expect(lintAnsibleDocument(ast, registry)).toEqual([]);

    const mockFs: IWorkspaceFs = {
      exists: () => false,
      readFile: () => undefined,
      listFiles: () => [],
    };
    expect(checkProjectIntegrity(ast, '/workspace', mockFs)).toEqual([]);
  });
});
