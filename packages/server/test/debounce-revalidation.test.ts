import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DidChangeTextDocumentNotification,
  DidChangeWatchedFilesNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidSaveTextDocumentNotification,
  FileChangeType,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  StreamMessageReader,
  StreamMessageWriter,
  createConnection,
  createProtocolConnection,
  type Diagnostic,
} from 'vscode-languageserver/node.js';
import { AnsibleLanguageService, MemoryWorkspaceFs, fsPathToUri } from '../src/index.js';
import { bindLanguageServer, type BoundServer } from '../src/server.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createTestHarness(
  files: Record<string, string>,
  options?: { changeDebounceMs?: number; watchedFilesDebounceMs?: number },
): Promise<{
  readonly fs: MemoryWorkspaceFs;
  readonly service: AnsibleLanguageService;
  readonly bound: BoundServer;
  readonly clientConn: ReturnType<typeof createProtocolConnection>;
  readonly published: Array<{ readonly uri: string; readonly diagnostics: readonly Diagnostic[] }>;
  readonly rootUri: string;
  readonly cleanup: () => void;
}> {
  const root = '/workspace';
  const memFs = new MemoryWorkspaceFs(files);
  const service = new AnsibleLanguageService({ fs: memFs });

  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();

  const serverConn = createConnection(
    new StreamMessageReader(clientToServer),
    new StreamMessageWriter(serverToClient),
  );
  const bound = bindLanguageServer(serverConn, service, {
    changeDebounceMs: options?.changeDebounceMs ?? 60,
    watchedFilesDebounceMs: options?.watchedFilesDebounceMs ?? 80,
  });
  serverConn.listen();

  const clientConn = createProtocolConnection(
    new StreamMessageReader(serverToClient),
    new StreamMessageWriter(clientToServer),
  );

  const published: Array<{ readonly uri: string; readonly diagnostics: readonly Diagnostic[] }> =
    [];
  clientConn.onNotification(PublishDiagnosticsNotification.type, (params) => {
    published.push({ uri: params.uri, diagnostics: params.diagnostics });
  });
  clientConn.listen();

  const rootUri = fsPathToUri(root);
  await clientConn.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri,
    capabilities: {},
    workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
  });
  await clientConn.sendNotification(InitializedNotification.type, {});

  const cleanup = (): void => {
    bound.dispose();
    clientConn.dispose();
    serverConn.dispose();
    clientToServer.end();
    serverToClient.end();
  };

  return { fs: memFs, service, bound, clientConn, published, rootUri, cleanup };
}

describe('Debounced Revalidation & Incremental Watched-File Indexing', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    vi.restoreAllMocks();
  });

  it('classifies shared provider documents accurately', () => {
    const memFs = new MemoryWorkspaceFs({
      '/workspace/ansible.cfg': '[defaults]\nroles_path = roles\n',
      '/workspace/versions.yml': 'app_version: "1.0.0"\n',
      '/workspace/site.yml':
        '---\n- name: Main\n  hosts: all\n  vars_files:\n    - versions.yml\n  roles:\n    - web\n',
      '/workspace/roles/web/tasks/main.yml': '---\n- name: Ping\n  ansible.builtin.ping:\n',
    });
    const service = new AnsibleLanguageService({ fs: memFs });
    service.addWorkspaceRoot('/workspace');
    service.indexWorkspace();

    expect(
      service.isSharedProviderDocument(fsPathToUri('/workspace/roles/web/defaults/main.yml')),
    ).toBe(true);
    expect(
      service.isSharedProviderDocument(fsPathToUri('/workspace/roles/web/vars/main.yml')),
    ).toBe(true);
    expect(service.isSharedProviderDocument(fsPathToUri('/workspace/group_vars/all.yml'))).toBe(
      true,
    );
    expect(service.isSharedProviderDocument(fsPathToUri('/workspace/host_vars/web1.yml'))).toBe(
      true,
    );
    expect(
      service.isSharedProviderDocument(fsPathToUri('/workspace/roles/web/handlers/main.yml')),
    ).toBe(true);
    expect(service.isSharedProviderDocument(fsPathToUri('/workspace/inventory/hosts.ini'))).toBe(
      true,
    );
    expect(service.isSharedProviderDocument(fsPathToUri('/workspace/site.yml'))).toBe(true);
    expect(service.isSharedProviderDocument(fsPathToUri('/workspace/ansible.cfg'))).toBe(true);
    // Tracked external vars_files (versions.yml) is detected as a shared provider
    expect(service.isSharedProviderDocument(fsPathToUri('/workspace/versions.yml'))).toBe(true);
    // Content with vars_files: or include_vars is detected as a shared provider
    expect(
      service.isSharedProviderDocument(
        fsPathToUri('/workspace/playbooks/deploy.yml'),
        '---\n- hosts: all\n  vars_files:\n    - extra.yml\n',
      ),
    ).toBe(true);
    expect(
      service.isSharedProviderDocument(
        fsPathToUri('/workspace/roles/web/tasks/load.yml'),
        '---\n- name: Load\n  ansible.builtin.include_vars:\n    file: extra.yml\n',
      ),
    ).toBe(true);
    // Non-shared leaf task file is NOT a shared provider
    expect(
      service.isSharedProviderDocument(
        fsPathToUri('/workspace/roles/web/tasks/main.yml'),
        '---\n- name: Ping\n  ansible.builtin.ping:\n',
      ),
    ).toBe(false);
  });

  it('validates once on DidOpen without duplicating diagnostics or revalidating other open tabs', async () => {
    const sitePath = '/workspace/site.yml';
    const taskPath = '/workspace/roles/web/tasks/main.yml';
    const siteText =
      '---\n- name: Main\n  hosts: all\n  tasks:\n    - name: Ping\n      ansible.builtin.ping:\n';
    const taskText = '---\n- name: Hello\n  ansible.builtin.debug:\n    msg: hi\n';

    const harness = await createTestHarness({
      '/workspace/ansible.cfg': '[defaults]\nroles_path = roles\n',
      [sitePath]: siteText,
      [taskPath]: taskText,
    });
    cleanups.push(harness.cleanup);

    const siteUri = fsPathToUri(sitePath);
    const taskUri = fsPathToUri(taskPath);

    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: siteUri, languageId: 'yaml', version: 1, text: siteText },
    });
    await delay(40);
    expect(harness.published.filter((p) => p.uri === siteUri)).toHaveLength(1);

    harness.published.length = 0;

    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: taskUri, languageId: 'yaml', version: 1, text: taskText },
    });
    await delay(40);

    // Newly opened task file validated once; already-open site.yml is NOT revalidated
    expect(harness.published.filter((p) => p.uri === taskUri)).toHaveLength(1);
    expect(harness.published.filter((p) => p.uri === siteUri)).toHaveLength(0);
  });

  it('debounces rapid DidChange bursts on a non-shared task file and never revalidates other open tabs', async () => {
    const sitePath = '/workspace/site.yml';
    const taskPath = '/workspace/roles/web/tasks/main.yml';
    const siteText =
      '---\n- name: Main\n  hosts: all\n  tasks:\n    - name: Ping\n      ansible.builtin.ping:\n';
    const taskBase = '---\n- name: Echo\n  ansible.builtin.debug:\n    msg: ';

    const harness = await createTestHarness(
      {
        '/workspace/ansible.cfg': '[defaults]\nroles_path = roles\n',
        [sitePath]: siteText,
        [taskPath]: `${taskBase}"v0"\n`,
      },
      { changeDebounceMs: 80 },
    );
    cleanups.push(harness.cleanup);

    const siteUri = fsPathToUri(sitePath);
    const taskUri = fsPathToUri(taskPath);

    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: siteUri, languageId: 'yaml', version: 1, text: siteText },
    });
    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: taskUri, languageId: 'yaml', version: 1, text: `${taskBase}"v0"\n` },
    });
    await delay(40);
    harness.published.length = 0;

    // Simulate 10 rapid keystrokes in a non-shared task file
    for (let version = 2; version <= 11; version++) {
      await harness.clientConn.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri: taskUri, version },
        contentChanges: [{ text: `${taskBase}"v${version}"\n` }],
      });
    }

    // Immediately after burst, debounce timer has not fired yet
    await delay(20);
    expect(harness.published).toHaveLength(0);

    // After debounce window elapses, exactly 1 publish for taskUri and 0 for siteUri
    await delay(120);
    expect(harness.published.filter((p) => p.uri === taskUri)).toHaveLength(1);
    expect(harness.published.filter((p) => p.uri === siteUri)).toHaveLength(0);
  });

  it('revalidates other open documents when a shared provider file changes (defaults/main.yml & versions.yml)', async () => {
    const defaultsPath = '/workspace/roles/web/defaults/main.yml';
    const versionsPath = '/workspace/versions.yml';
    const sitePath = '/workspace/site.yml';
    const templatePath = '/workspace/roles/web/templates/app.conf.j2';

    const defaultsText = '---\nweb_port: 8080\n';
    const versionsText = '---\napp_release: "2.0.0"\n';
    const siteText =
      '---\n- name: Main\n  hosts: all\n  vars_files:\n    - versions.yml\n  roles:\n    - web\n';
    const templateText = 'PORT={{ web_port }}\nRELEASE={{ app_release }}\n';

    const harness = await createTestHarness(
      {
        '/workspace/ansible.cfg': '[defaults]\nroles_path = roles\n',
        [defaultsPath]: defaultsText,
        [versionsPath]: versionsText,
        [sitePath]: siteText,
        [templatePath]: templateText,
      },
      { changeDebounceMs: 50 },
    );
    cleanups.push(harness.cleanup);

    const defaultsUri = fsPathToUri(defaultsPath);
    const versionsUri = fsPathToUri(versionsPath);
    const templateUri = fsPathToUri(templatePath);

    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: templateUri, languageId: 'jinja', version: 1, text: templateText },
    });
    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: defaultsUri, languageId: 'yaml', version: 1, text: defaultsText },
    });
    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: versionsUri, languageId: 'yaml', version: 1, text: versionsText },
    });
    await delay(40);
    harness.published.length = 0;

    // Rename variable in defaults/main.yml -> open .j2 template must be revalidated
    await harness.clientConn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: defaultsUri, version: 2 },
      contentChanges: [{ text: '---\nweb_http_port: 8080\n' }],
    });
    await delay(120);

    const templateAfterDefaults = harness.published.filter((p) => p.uri === templateUri);
    expect(templateAfterDefaults.length).toBeGreaterThanOrEqual(1);
    expect(
      templateAfterDefaults.at(-1)?.diagnostics.some((d) => d.code === 'undefined-variable'),
    ).toBe(true);

    // Restore defaults/main.yml and test tracked external vars_files (versions.yml)
    await harness.clientConn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: defaultsUri, version: 3 },
      contentChanges: [{ text: defaultsText }],
    });
    await delay(120);
    harness.published.length = 0;

    await harness.clientConn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: versionsUri, version: 2 },
      contentChanges: [{ text: '---\napp_tag: "2.0.0"\n' }],
    });
    await delay(120);

    const templateAfterVersions = harness.published.filter((p) => p.uri === templateUri);
    expect(templateAfterVersions.length).toBeGreaterThanOrEqual(1);
    expect(
      templateAfterVersions
        .at(-1)
        ?.diagnostics.some(
          (d) => d.code === 'undefined-variable' && d.message.includes('app_release'),
        ),
    ).toBe(true);
  });

  it('cancels pending change timer on DidSave and DidClose', async () => {
    const taskPath = '/workspace/roles/web/tasks/main.yml';
    const sitePath = '/workspace/site.yml';
    const taskText = '---\n- name: Ping\n  ansible.builtin.ping:\n';
    const siteText =
      '---\n- name: Main\n  hosts: all\n  tasks:\n    - name: Ping\n      ansible.builtin.ping:\n';

    const harness = await createTestHarness(
      {
        '/workspace/ansible.cfg': '[defaults]\nroles_path = roles\n',
        [taskPath]: taskText,
        [sitePath]: siteText,
      },
      { changeDebounceMs: 120 },
    );
    cleanups.push(harness.cleanup);

    const taskUri = fsPathToUri(taskPath);
    const siteUri = fsPathToUri(sitePath);

    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: siteUri, languageId: 'yaml', version: 1, text: siteText },
    });
    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: taskUri, languageId: 'yaml', version: 1, text: taskText },
    });
    await delay(40);
    harness.published.length = 0;

    // Trigger change, then immediately save before debounce elapses
    await harness.clientConn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: taskUri, version: 2 },
      contentChanges: [{ text: `${taskText}\n` }],
    });
    await harness.clientConn.sendNotification(DidSaveTextDocumentNotification.type, {
      textDocument: { uri: taskUri },
    });
    await delay(180);

    // Validated exactly once on save (pending change timer was cancelled), 0 for siteUri
    expect(harness.published.filter((p) => p.uri === taskUri)).toHaveLength(1);
    expect(harness.published.filter((p) => p.uri === siteUri)).toHaveLength(0);

    harness.published.length = 0;

    // Trigger change, then immediately close before debounce elapses
    await harness.clientConn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: taskUri, version: 3 },
      contentChanges: [{ text: `${taskText}\n\n` }],
    });
    await harness.clientConn.sendNotification(DidCloseTextDocumentNotification.type, {
      textDocument: { uri: taskUri },
    });
    await delay(180);

    // Only the empty diagnostics clear on close; debounced change did NOT fire after close
    const taskPublishes = harness.published.filter((p) => p.uri === taskUri);
    expect(taskPublishes).toHaveLength(1);
    expect(taskPublishes[0]?.diagnostics).toEqual([]);
    expect(harness.published.filter((p) => p.uri === siteUri)).toHaveLength(0);
  });

  it('debounces rapid DidChangeWatchedFiles bursts and incrementally re-indexes without calling indexWorkspace()', async () => {
    const taskPath = '/workspace/roles/web/tasks/main.yml';
    const defaultsPath = '/workspace/roles/web/defaults/main.yml';
    const templatePath = '/workspace/roles/web/templates/app.conf.j2';

    const harness = await createTestHarness(
      {
        '/workspace/ansible.cfg': '[defaults]\nroles_path = roles\n',
        [taskPath]: '---\n- name: Ping\n  ansible.builtin.ping:\n',
        [defaultsPath]: '---\nweb_port: 8080\n',
        [templatePath]: 'PORT={{ web_port }}\n',
      },
      { watchedFilesDebounceMs: 80 },
    );
    cleanups.push(harness.cleanup);

    const templateUri = fsPathToUri(templatePath);
    const defaultsUri = fsPathToUri(defaultsPath);
    const taskUri = fsPathToUri(taskPath);

    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: templateUri,
        languageId: 'jinja',
        version: 1,
        text: 'PORT={{ web_port }}\n',
      },
    });
    await delay(40);
    harness.published.length = 0;

    const indexWorkspaceSpy = vi.spyOn(harness.service, 'indexWorkspace');
    const applyBatchSpy = vi.spyOn(harness.service, 'applyWatchedFileChanges');

    // Update defaults/main.yml on disk and emit a rapid burst of watched-file events
    harness.fs.setFile(defaultsPath, '---\nweb_renamed_port: 8080\n');
    for (let i = 0; i < 5; i++) {
      await harness.clientConn.sendNotification(DidChangeWatchedFilesNotification.type, {
        changes: [
          { uri: taskUri, type: FileChangeType.Changed },
          { uri: defaultsUri, type: FileChangeType.Changed },
        ],
      });
    }

    await delay(150);

    // Batched into a single incremental update with ZERO full indexWorkspace() calls
    expect(indexWorkspaceSpy).toHaveBeenCalledTimes(0);
    expect(applyBatchSpy).toHaveBeenCalledTimes(1);

    // Open template was revalidated because defaults/main.yml (shared provider) changed
    const templatePublishes = harness.published.filter((p) => p.uri === templateUri);
    expect(templatePublishes).toHaveLength(1);
    expect(
      templatePublishes[0]?.diagnostics.some(
        (d) => d.code === 'undefined-variable' && d.message.includes('web_port'),
      ),
    ).toBe(true);

    // Changing ansible.cfg DOES fall back to indexWorkspace()
    await harness.clientConn.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: fsPathToUri('/workspace/ansible.cfg'), type: FileChangeType.Changed }],
    });
    await delay(150);
    expect(indexWorkspaceSpy).toHaveBeenCalledTimes(1);
  });
});
