import { describe, expect, it } from 'vitest';
import type { LocationLink } from 'vscode-languageserver/node.js';
import { AnsibleLanguageService, MemoryWorkspaceFs, fsPathToUri } from '../src/index.js';

function isLocationLink(value: unknown): value is LocationLink {
  return typeof value === 'object' && value !== null && 'targetUri' in value;
}

describe('notify: Go-to-Definition strict matching and LocationLink multi-word highlight', () => {
  const handlersPath = '/workspace/roles/zram/handlers/main.yml';
  const tasksPath = '/workspace/roles/zram/tasks/main.yml';
  const handlersUri = fsPathToUri(handlersPath);
  const tasksUri = fsPathToUri(tasksPath);

  const handlersYaml = [
    '---',
    '- name: Restart zramswap',
    '  ansible.builtin.systemd_service:',
    '    name: zramswap',
    '    state: restarted',
    '',
    '- name: Reload sysctl',
    '  ansible.builtin.command:',
    '    cmd: sysctl --system',
    '  changed_when: false',
  ].join('\n');

  const tasksYaml = [
    '---',
    '- name: Configure zramswap service',
    '  # Restart zramswap comment should never resolve',
    '  ansible.builtin.template:',
    '    src: zramswap.j2',
    '    dest: /etc/default/zramswap',
    '    mode: "0644"',
    '  notify: Restart zramswap  # trailing comment',
    '',
    '- name: Configure multiple handlers',
    '  ansible.builtin.copy:',
    '    content: "ok"',
    '    dest: /tmp/ok',
    '    mode: "0644"',
    '  notify:',
    '    - Restart zramswap',
    '    - "Reload sysctl"',
    '    # - Reload sysctl',
  ].join('\n');

  function setupService(): AnsibleLanguageService {
    const fs = new MemoryWorkspaceFs({
      '/workspace/ansible.cfg': '[defaults]\nroles_path = roles\n',
      [handlersPath]: handlersYaml,
      [tasksPath]: tasksYaml,
    });
    const service = new AnsibleLanguageService({ fs, workspaceRoots: ['/workspace'] });
    service.indexWorkspace();
    return service;
  }

  it('returns LocationLink with originSelectionRange spanning the entire inline handler name', () => {
    const service = setupService();
    const lines = tasksYaml.split('\n');
    const lineIdx = lines.findIndex((l) => l.includes('notify: Restart zramswap'));
    const line = lines[lineIdx] ?? '';
    const startCol = line.indexOf('Restart zramswap');
    const endCol = startCol + 'Restart zramswap'.length;

    // Cursor inside the second word ("zramswap") still highlights the entire phrase
    const defs = service.getDefinition(
      tasksUri,
      { line: lineIdx, character: startCol + 'Restart zram'.length },
      tasksYaml,
    );
    expect(defs).toHaveLength(1);
    const link = defs[0];
    expect(isLocationLink(link)).toBe(true);
    if (isLocationLink(link)) {
      expect(link.targetUri).toBe(handlersUri);
      expect(link.originSelectionRange).toEqual({
        start: { line: lineIdx, character: startCol },
        end: { line: lineIdx, character: endCol },
      });
      expect(link.targetRange.start.line).toBe(1);
    }
  });

  it('returns LocationLink with full originSelectionRange for multi-line list and quoted handler items', () => {
    const service = setupService();
    const lines = tasksYaml.split('\n');

    const item1Line = lines.findIndex((l) => l.trim() === '- Restart zramswap');
    const item1Start = (lines[item1Line] ?? '').indexOf('Restart zramswap');
    const defs1 = service.getDefinition(
      tasksUri,
      { line: item1Line, character: item1Start + 2 },
      tasksYaml,
    );
    expect(defs1).toHaveLength(1);
    const link1 = defs1[0];
    expect(isLocationLink(link1)).toBe(true);
    if (isLocationLink(link1)) {
      expect(link1.targetUri).toBe(handlersUri);
      expect(link1.originSelectionRange).toEqual({
        start: { line: item1Line, character: item1Start },
        end: { line: item1Line, character: item1Start + 'Restart zramswap'.length },
      });
    }

    const item2Line = lines.findIndex((l) => l.trim() === '- "Reload sysctl"');
    const item2Start = (lines[item2Line] ?? '').indexOf('Reload sysctl');
    const defs2 = service.getDefinition(
      tasksUri,
      { line: item2Line, character: item2Start + 8 },
      tasksYaml,
    );
    expect(defs2).toHaveLength(1);
    const link2 = defs2[0];
    expect(isLocationLink(link2)).toBe(true);
    if (isLocationLink(link2)) {
      expect(link2.targetUri).toBe(handlersUri);
      expect(link2.targetRange.start.line).toBe(6);
      expect(link2.originSelectionRange).toEqual({
        start: { line: item2Line, character: item2Start },
        end: { line: item2Line, character: item2Start + 'Reload sysctl'.length },
      });
    }
  });

  it('never leaks handler definitions onto - name:, notify: key, or # comments', () => {
    const service = setupService();
    const lines = tasksYaml.split('\n');

    // 1. `- name: Configure zramswap service` on a task that has `notify:`
    const nameLine = lines.findIndex((l) => l.includes('- name: Configure zramswap service'));
    expect(service.getDefinition(tasksUri, { line: nameLine, character: 2 }, tasksYaml)).toEqual(
      [],
    );
    expect(service.getDefinition(tasksUri, { line: nameLine, character: 12 }, tasksYaml)).toEqual(
      [],
    );

    // 2. `# Restart zramswap comment` line inside the task
    const commentLine = lines.findIndex((l) => l.includes('# Restart zramswap comment'));
    expect(service.getDefinition(tasksUri, { line: commentLine, character: 8 }, tasksYaml)).toEqual(
      [],
    );

    // 3. `notify:` key itself on inline notify line
    const inlineNotifyLine = lines.findIndex((l) => l.includes('notify: Restart zramswap'));
    const notifyCol = (lines[inlineNotifyLine] ?? '').indexOf('notify');
    expect(
      service.getDefinition(
        tasksUri,
        { line: inlineNotifyLine, character: notifyCol + 2 },
        tasksYaml,
      ),
    ).toEqual([]);

    // 4. Trailing `# trailing comment` on inline notify line
    const trailingCommentCol = (lines[inlineNotifyLine] ?? '').indexOf('# trailing');
    expect(
      service.getDefinition(
        tasksUri,
        { line: inlineNotifyLine, character: trailingCommentCol + 4 },
        tasksYaml,
      ),
    ).toEqual([]);

    // 5. Commented-out `- Reload sysctl` line inside notify list
    const commentedListLine = lines.findIndex((l) => l.includes('# - Reload sysctl'));
    expect(
      service.getDefinition(tasksUri, { line: commentedListLine, character: 10 }, tasksYaml),
    ).toEqual([]);

    // 6. `- name: Configure multiple handlers` on second task
    const nameLine2 = lines.findIndex((l) => l.includes('- name: Configure multiple handlers'));
    expect(service.getDefinition(tasksUri, { line: nameLine2, character: 15 }, tasksYaml)).toEqual(
      [],
    );
  });
});
