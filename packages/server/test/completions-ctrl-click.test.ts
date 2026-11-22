import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CompletionItemKind,
  type CompletionItem,
  type Location,
  type Position,
  type TextEdit,
} from 'vscode-languageserver/node.js';
import {
  AnsibleLanguageService,
  MODULE_DOCS_SCHEME,
  NodeWorkspaceFs,
  buildModuleDocsUri,
  fsPathToUri,
} from '../src/index.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const NESTED_ROOT = path.join(REPO_ROOT, 'test/fixtures/nested-monorepo-project');
const ROLE_TASKS = path.join(NESTED_ROOT, 'ansible/roles/webapp/tasks/main.yml');
const ROLE_URI = fsPathToUri(ROLE_TASKS);

function createService(): AnsibleLanguageService {
  const service = new AnsibleLanguageService({
    fs: new NodeWorkspaceFs(),
    workspaceRoots: [NESTED_ROOT],
  });
  service.indexWorkspace();
  return service;
}

/** Appends `suffixLines` to the role tasks file and returns the cursor at the end. */
function withAppended(suffixLines: readonly string[]): { text: string; position: Position } {
  const base = fs.readFileSync(ROLE_TASKS, 'utf8').trimEnd();
  const text = [base, '', ...suffixLines].join('\n');
  const lines = text.split('\n');
  const last = lines[lines.length - 1] ?? '';
  return { text, position: { line: lines.length - 1, character: last.length } };
}

function labels(items: readonly CompletionItem[]): string[] {
  return items.map((i) => i.label);
}

function editOf(item: CompletionItem | undefined): TextEdit {
  expect(item?.textEdit).toBeDefined();
  return item?.textEdit as TextEdit;
}

describe('completions with explicit textEdit ranges (YAML word-pattern safe)', () => {
  it('suggests `stat` after `when: webapp_version_file.` with an empty replace range', () => {
    const service = createService();
    const { text, position } = withAppended([
      '- name: New task',
      '  ansible.builtin.debug:',
      '    msg: hi',
      '  when: webapp_version_file.',
    ]);
    const items = service.getCompletions(ROLE_URI, position, text);
    expect(labels(items)).toContain('stat');
    const edit = editOf(items.find((i) => i.label === 'stat'));
    expect(edit.newText).toBe('stat');
    expect(edit.range.start).toEqual(position);
    expect(edit.range.end).toEqual(position);
  });

  it('resolves nested partial prefixes like `webapp_version_file.stat.e`', () => {
    const service = createService();
    const { text, position } = withAppended([
      '- name: New task',
      '  ansible.builtin.debug:',
      '    msg: hi',
      '  when: webapp_version_file.stat.e',
    ]);
    const items = service.getCompletions(ROLE_URI, position, text);
    expect(labels(items)).toContain('exists');
    expect(labels(items)).not.toContain('isdir');
    const edit = editOf(items.find((i) => i.label === 'exists'));
    expect(edit.range.start).toEqual({ line: position.line, character: position.character - 1 });
    expect(edit.range.end).toEqual(position);
  });

  it('lists `stat` children after a trailing dot (`webapp_version_file.stat.`)', () => {
    const service = createService();
    const { text, position } = withAppended([
      '- name: New task',
      '  ansible.builtin.debug:',
      '    msg: hi',
      '  when: webapp_version_file.stat.',
    ]);
    const items = service.getCompletions(ROLE_URI, position, text);
    expect(labels(items)).toEqual(expect.arrayContaining(['exists', 'isdir', 'mode']));
  });

  it('completes inside multi-line `when:` / `failed_when:` / `changed_when:` lists', () => {
    const service = createService();
    for (const key of ['when', 'failed_when', 'changed_when']) {
      const { text, position } = withAppended([
        '- name: New task',
        '  ansible.builtin.debug:',
        '    msg: hi',
        `  ${key}:`,
        '    - webapp_version_file.stat.exists',
        '    # a comment between items',
        '    - webapp_version_file.stat.',
      ]);
      const items = service.getCompletions(ROLE_URI, position, text);
      expect(labels(items), key).toEqual(expect.arrayContaining(['exists', 'isdir']));
      expect(editOf(items[0]).range.end).toEqual(position);
    }
  });

  it('completes in zero-indented sequences under `when:` and folded continuation lines', () => {
    const service = createService();
    const seq = withAppended([
      '- name: New task',
      '  ansible.builtin.debug:',
      '    msg: hi',
      '  when:',
      '  - webapp_version_file.st',
    ]);
    expect(labels(service.getCompletions(ROLE_URI, seq.position, seq.text))).toContain('stat');

    const folded = withAppended([
      '- name: New task',
      '  ansible.builtin.debug:',
      '    msg: hi',
      '  when: >',
      '    webapp_version_file.stat.exists and',
      '    webapp_version_file.',
    ]);
    expect(labels(service.getCompletions(ROLE_URI, folded.position, folded.text))).toContain(
      'stat',
    );
  });

  it('does not treat module parameters below a task as a condition context', () => {
    const service = createService();
    const { text, position } = withAppended([
      '- name: New task',
      '  ansible.builtin.copy:',
      '    src: webapp_version_file.',
    ]);
    const items = service.getCompletions(ROLE_URI, position, text);
    expect(items.some((i) => i.label === 'stat' && i.kind === CompletionItemKind.Field)).toBe(
      false,
    );
  });

  it('attaches textEdit ranges to variable, filter, and Jinja2 test completions', () => {
    const service = createService();
    const vars = withAppended([
      '- name: New task',
      '  ansible.builtin.debug:',
      '    msg: hi',
      '  when:',
      '    - webapp_ver',
    ]);
    const varItems = service.getCompletions(ROLE_URI, vars.position, vars.text);
    const reg = varItems.find((i) => i.label === 'webapp_version_file');
    expect(editOf(reg).range.start.character).toBe(vars.position.character - 'webapp_ver'.length);

    const filters = withAppended([
      '- name: New task',
      '  ansible.builtin.debug:',
      '    msg: hi',
      '  when:',
      '    - webapp_version_file.stat.mode | def',
    ]);
    const filterItems = service.getCompletions(ROLE_URI, filters.position, filters.text);
    expect(labels(filterItems)).toContain('default');
    expect(editOf(filterItems[0]).range.start.character).toBe(filters.position.character - 3);

    const tests = withAppended([
      '- name: New task',
      '  ansible.builtin.debug:',
      '    msg: hi',
      '  when: webapp_version_file is not ',
    ]);
    expect(labels(service.getCompletions(ROLE_URI, tests.position, tests.text))).toContain(
      'succeeded',
    );
  });
});

describe('Pylance-style Ctrl+Click module docs and zero permanent underlines', () => {
  it('supports docsCtrlClickBehavior: renderedPreview, openInBrowser, and disabled with full-module LocationLink', () => {
    const service = createService();
    const text = fs.readFileSync(ROLE_TASKS, 'utf8');
    const lines = text.split('\n');
    const line = lines.findIndex((l) => l.includes('ansible.builtin.stat:'));
    const moduleStart = (lines[line] ?? '').indexOf('ansible.builtin.stat');
    const character = moduleStart + 5;

    // Default (`renderedPreview`): resolves to `LocationLink` with `originSelectionRange` covering full FQCN
    expect(service.getDocsCtrlClickBehavior()).toBe('renderedPreview');
    const locs = service.getDefinition(ROLE_URI, { line, character }, text);
    expect(locs).toHaveLength(1);
    const link = locs[0];
    expect(link && 'targetUri' in link).toBe(true);
    if (link && 'targetUri' in link) {
      expect(link.targetUri).toBe(buildModuleDocsUri('ansible.builtin.stat'));
      expect(link.targetUri.startsWith(`${MODULE_DOCS_SCHEME}:`)).toBe(true);
      expect(link.originSelectionRange).toEqual({
        start: { line, character: moduleStart },
        end: { line, character: moduleStart + 'ansible.builtin.stat'.length },
      });
    }

    // `openInBrowser`: still resolves side-effect-free to `LocationLink` so Ctrl+Hover highlights full FQCN
    service.setDocsCtrlClickBehavior('openInBrowser');
    const browserLocs = service.getDefinition(ROLE_URI, { line, character }, text);
    expect(browserLocs).toHaveLength(1);
    expect(browserLocs[0] && 'targetUri' in browserLocs[0]).toBe(true);

    // `disabled`: Ctrl+Click on module names does nothing
    service.setDocsCtrlClickBehavior('disabled');
    expect(service.getDefinition(ROLE_URI, { line, character }, text)).toEqual([]);

    const md = service.getModuleDocsMarkdown('ansible.builtin.stat');
    const firstLine = md.split('\n')[0] ?? '';
    expect(firstLine).toContain('https://docs.ansible.com/');
    expect(md).toContain('## Parameters');
    expect(md).toContain('#parameter-path');
    expect(md).toContain('#return-stat/exists');
  });

  it('suggests standard Ansible special, connection, become, and fact variables with 3_ sortText', () => {
    const service = createService();
    const probe = withAppended([
      '- name: Special vars probe',
      '  ansible.builtin.debug:',
      '    msg: "{{ ',
    ]);
    const items = service.getCompletions(ROLE_URI, probe.position, probe.text);
    const byLabel = new Map(items.map((item) => [item.label, item]));

    const expectedSpecialVars = [
      'ansible_user',
      'ansible_host',
      'ansible_port',
      'ansible_connection',
      'ansible_become',
      'ansible_become_user',
      'ansible_become_method',
      'ansible_python_interpreter',
      'ansible_ssh_private_key_file',
      'ansible_ssh_common_args',
      'inventory_hostname',
      'inventory_hostname_short',
      'inventory_dir',
      'inventory_file',
      'playbook_dir',
      'role_path',
      'role_name',
      'ansible_role_name',
      'ansible_play_name',
      'ansible_play_hosts_all',
      'ansible_limit',
      'ansible_run_tags',
      'ansible_skip_tags',
      'ansible_env',
      'ansible_os_family',
      'ansible_distribution',
      'ansible_distribution_version',
      'ansible_hostname',
      'ansible_fqdn',
      'ansible_default_ipv4',
      'ansible_architecture',
      'hostvars',
      'groups',
      'group_names',
      'omit',
    ];

    for (const varName of expectedSpecialVars) {
      const item = byLabel.get(varName);
      expect(item, `Expected completion for special variable '${varName}'`).toBeDefined();
      expect(item?.sortText).toBe(`3_${varName}`);
    }
  });

  it('renders an offline docs page with a docs.ansible.com link for unloaded collections', () => {
    const service = createService();
    const md = service.getModuleDocsMarkdown('community.general.ufw');
    expect(md.split('\n')[0]).toContain(
      'https://docs.ansible.com/ansible/latest/collections/community/general/ufw_module.html',
    );
  });

  it('jumps from a registered variable in a multi-line `when:` to its `register:` line', () => {
    const service = createService();
    const text = fs.readFileSync(ROLE_TASKS, 'utf8');
    const lines = text.split('\n');
    const line = lines.findIndex((l) => l.includes('- not webapp_version_file.stat.isdir'));
    const character = (lines[line] ?? '').indexOf('webapp_version_file') + 3;
    const locs = service.getDefinition(ROLE_URI, { line, character }, text) as Location[];
    const registerLine = lines.findIndex((l) => l.includes('register: webapp_version_file'));
    expect(locs[0]?.uri).toBe(ROLE_URI);
    expect(locs[0]?.range.start.line).toBe(registerLine);
  });
});

describe('nested monorepo diagnostics', () => {
  it('emits zero missing-role diagnostics for roles under ansible/roles via ansible.cfg', () => {
    const service = createService();
    const sitePath = path.join(NESTED_ROOT, 'ansible/playbooks/site.yml');
    const siteUri = fsPathToUri(sitePath);
    const diags = service.getDiagnostics(siteUri, fs.readFileSync(sitePath, 'utf8'));
    expect(diags.filter((d) => d.code === 'missing-role')).toEqual([]);
  });

  it('emits exactly one missing-role diagnostic for a genuinely missing role', () => {
    const service = createService();
    const sitePath = path.join(NESTED_ROOT, 'ansible/playbooks/site.yml');
    const siteUri = fsPathToUri(sitePath);
    const text = `${fs.readFileSync(sitePath, 'utf8').trimEnd()}\n    - does_not_exist\n`;
    const diags = service.getDiagnostics(siteUri, text);
    expect(diags.filter((d) => d.code === 'missing-role')).toHaveLength(1);
  });

  it('emits zero diagnostics for the role tasks file and GitHub Actions workflows', () => {
    const service = createService();
    expect(service.getDiagnostics(ROLE_URI, fs.readFileSync(ROLE_TASKS, 'utf8'))).toEqual([]);
    const ciPath = path.join(NESTED_ROOT, '.github/workflows/ci.yml');
    expect(service.getDiagnostics(fsPathToUri(ciPath), fs.readFileSync(ciPath, 'utf8'))).toEqual(
      [],
    );
  });
});
