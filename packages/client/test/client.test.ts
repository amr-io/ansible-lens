import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldActivateForDocument, workspaceHasAnsibleCfg } from '../src/activation.js';
import { createClientLogger } from '../src/logger.js';

const CLIENT_ROOT = fs.existsSync(path.resolve(process.cwd(), 'packages/client/package.json'))
  ? path.resolve(process.cwd(), 'packages/client')
  : path.resolve(process.cwd());

describe('Ansible Lens VS Code Client — Smart Hybrid Activation, Grammar, Logger & Assets', () => {
  it('activates dynamically on Ansible YAML files and ansible languageId', () => {
    const playbook = shouldActivateForDocument(
      {
        uri: 'file:///repo/deploy.yml',
        languageId: 'yaml',
        text: '---\n- name: Web\n  hosts: webservers\n  tasks:\n    - name: Ping\n      ansible.builtin.ping:\n',
      },
      false,
    );
    expect(playbook.isAnsible).toBe(true);
    expect(playbook.kind).toBe('playbook');

    const roleTask = shouldActivateForDocument(
      {
        uri: 'file:///repo/roles/webserver/tasks/main.yml',
        languageId: 'yaml',
        text: '---\n- name: Install\n  apt:\n    name: nginx\n',
      },
      false,
    );
    expect(roleTask.isAnsible).toBe(true);
    expect(roleTask.kind).toBe('tasks');

    const explicitAnsible = shouldActivateForDocument(
      {
        uri: 'file:///repo/custom.yml',
        languageId: 'ansible',
        text: '---\n- debug:\n    msg: hi\n',
      },
      false,
    );
    expect(explicitAnsible.isAnsible).toBe(true);
  });

  it('ignores Kubernetes, Docker Compose, GitHub Actions, and non-YAML files', () => {
    const k8s = shouldActivateForDocument(
      {
        uri: 'file:///repo/k8s/deployment.yml',
        languageId: 'yaml',
        text: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n',
      },
      true,
    );
    expect(k8s.isAnsible).toBe(false);

    const compose = shouldActivateForDocument(
      {
        uri: 'file:///repo/docker-compose.yml',
        languageId: 'yaml',
        text: 'services:\n  api:\n    image: node:22\nvolumes:\n  data:\n',
      },
      true,
    );
    expect(compose.isAnsible).toBe(false);

    const gha = shouldActivateForDocument(
      {
        uri: 'file:///repo/.github/workflows/build.yml',
        languageId: 'yaml',
        text: 'on:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n',
      },
      true,
    );
    expect(gha.isAnsible).toBe(false);

    const jsonDoc = shouldActivateForDocument(
      {
        uri: 'file:///repo/package.json',
        languageId: 'json',
        text: '{"name": "demo"}',
      },
      true,
    );
    expect(jsonDoc.isAnsible).toBe(false);
  });

  it('detects ansible.cfg presence in workspace folders', () => {
    const hasCfg = workspaceHasAnsibleCfg(
      ['/workspace/a', '/workspace/b'],
      (p) => p === path.join('/workspace/b', 'ansible.cfg'),
    );
    expect(hasCfg).toBe(true);

    const noCfg = workspaceHasAnsibleCfg(['/workspace/a'], () => false);
    expect(noCfg).toBe(false);
  });

  it('routes structured logs to OutputChannel without console.log', () => {
    const lines: string[] = [];
    const logger = createClientLogger({
      appendLine(value: string) {
        lines.push(value);
      },
    });
    logger.info('Extension started', { collections: 1 });
    logger.warn('Fallback active');
    logger.error('Sync failed', { code: 500 });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('[INFO] [client] Extension started');
    expect(lines[0]).toContain('"collections":1');
    expect(lines[1]).toContain('[WARN] [client] Fallback active');
    expect(lines[2]).toContain('[ERROR] [client] Sync failed');
  });

  it('ships valid Jinja2 TextMate injection grammar, custom lens icon, and required trademark disclaimer', () => {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8')) as {
      description: string;
      icon: string;
      contributes: {
        commands: Array<{ command: string; title: string }>;
        grammars: Array<{ scopeName: string; path: string; injectTo: string[] }>;
      };
    };

    expect(pkgJson.description).toBe(
      'Fast, zero-dependency Ansible IntelliSense, tooltips, and linting — no Python or WSL required.',
    );
    const readmeText = fs.readFileSync(path.join(CLIENT_ROOT, 'README.md'), 'utf8');
    expect(readmeText).toContain('Ansible® is a registered trademark of Red Hat, Inc.');
    expect(pkgJson.icon).toBe('media/icon.png');
    expect(pkgJson.contributes.commands.map((c) => c.command)).toEqual([
      'ansibleLens.openOfficialDocs',
      'ansibleLens.refreshMetadata',
      'ansibleLens.convertFileToFqcn',
      'ansibleLens.copyDiagnosticsInfo',
    ]);

    const grammarEntry = pkgJson.contributes.grammars[0];
    expect(grammarEntry?.scopeName).toBe('text.jinja.ansible-lens.injection');
    expect(grammarEntry?.injectTo).toEqual(['source.yaml', 'source.ansible']);

    const grammar = JSON.parse(
      fs.readFileSync(path.join(CLIENT_ROOT, 'syntaxes/jinja2.injection.tmLanguage.json'), 'utf8'),
    ) as { scopeName: string; injectTo: string[] };
    expect(grammar.scopeName).toBe('text.jinja.ansible-lens.injection');
    expect(grammar.injectTo).toEqual(['source.yaml', 'source.ansible']);

    const pngBytes = fs.readFileSync(path.join(CLIENT_ROOT, 'media/icon.png'));
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    expect(pngBytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(fs.existsSync(path.join(CLIENT_ROOT, 'media/icon.svg'))).toBe(true);
  });
});

describe('ansible-lens-docs virtual document helpers', () => {
  it('parses module names from docs URIs and builds offline docs fallbacks', async () => {
    const { parseModuleNameFromDocsPath, buildOfflineDocUrl, formatOfflineDocsMarkdown } =
      await import('../src/docs-uri.js');
    expect(parseModuleNameFromDocsPath('/ansible.builtin.stat.md')).toBe('ansible.builtin.stat');
    expect(parseModuleNameFromDocsPath('community.general.ufw')).toBe('community.general.ufw');
    expect(parseModuleNameFromDocsPath('/bad%E0%A4%A.md')).toBe('bad%E0%A4%A');
    expect(buildOfflineDocUrl('ansible.posix.sysctl')).toBe(
      'https://docs.ansible.com/ansible/latest/collections/ansible/posix/sysctl_module.html',
    );
    expect(buildOfflineDocUrl('copy')).toContain('collections/index.html');
    expect(formatOfflineDocsMarkdown('ansible.posix.sysctl').split('\n')[0]).toContain(
      'docs.ansible.com',
    );
  });

  it('activates on .j2 templates and evaluates Smart {{ | }} Auto-Space on Space and Backspace', async () => {
    const { evaluateJinjaBraceAutoSpace } = await import('../src/jinja-autospace.js');
    const j2Activation = shouldActivateForDocument(
      {
        uri: 'file:///repo/roles/webapp/templates/webapp.rc.j2',
        languageId: 'plaintext',
        text: 'PORT={{ webapp_port }}\n',
      },
      false,
    );
    expect(j2Activation.isAnsible).toBe(true);
    expect(j2Activation.kind).toBe('template');

    // Space inside `msg: "{{|}}"`: after VS Code inserts `' '` at col 8, line is `msg: "{{ }}"`
    const expand = evaluateJinjaBraceAutoSpace('msg: "{{ }}"', 8, 0, ' ');
    expect(expand).toEqual({
      kind: 'space-expand',
      replaceStartCol: 9,
      replaceEndCol: 9,
      newText: ' ',
      cursorCol: 9,
    });

    // Backspace inside `msg: "{{ | }}"`: after VS Code deletes 1 char at col 8, line is `msg: "{{ }}"`
    const collapse = evaluateJinjaBraceAutoSpace('msg: "{{ }}"', 8, 1, '');
    expect(collapse).toEqual({
      kind: 'backspace-collapse',
      replaceStartCol: 8,
      replaceEndCol: 9,
      newText: '',
      cursorCol: 8,
    });

    // Non-matching edits return undefined
    expect(evaluateJinjaBraceAutoSpace('msg: "{{ foo }}"', 12, 0, ' ')).toBeUndefined();
    expect(evaluateJinjaBraceAutoSpace('msg: "{}"', 7, 0, ' ')).toBeUndefined();
  });
});
