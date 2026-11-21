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

async function waitFor(predicate: () => boolean, timeoutMs = 1000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await delay(intervalMs);
  }
}

async function createTestHarness(
  files: Record<string, string>,
  options?: { changeDebounceMs?: number; watchedFilesDebounceMs?: number; root?: string },
): Promise<{
  readonly fs: MemoryWorkspaceFs;
  readonly service: AnsibleLanguageService;
  readonly bound: BoundServer;
  readonly clientConn: ReturnType<typeof createProtocolConnection>;
  readonly published: Array<{ readonly uri: string; readonly diagnostics: readonly Diagnostic[] }>;
  readonly rootUri: string;
  readonly cleanup: () => Promise<void>;
}> {
  const root = options?.root ?? '/workspace';
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

  const cleanup = async (): Promise<void> => {
    bound.dispose();
    await delay(10);
    clientConn.dispose();
    serverConn.dispose();
    clientToServer.end();
    serverToClient.end();
  };

  return { fs: memFs, service, bound, clientConn, published, rootUri, cleanup };
}

describe('Debounced Revalidation & Incremental Watched-File Indexing', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
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
    await waitFor(() => harness.published.some((p) => p.uri === siteUri));
    expect(harness.published.filter((p) => p.uri === siteUri)).toHaveLength(1);

    harness.published.length = 0;

    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: taskUri, languageId: 'yaml', version: 1, text: taskText },
    });
    await waitFor(() => harness.published.some((p) => p.uri === taskUri));

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
    await waitFor(
      () =>
        harness.published.some((p) => p.uri === siteUri) &&
        harness.published.some((p) => p.uri === taskUri),
    );
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
    await waitFor(() => harness.published.some((p) => p.uri === taskUri));
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
    await waitFor(
      () =>
        harness.published.some((p) => p.uri === templateUri) &&
        harness.published.some((p) => p.uri === defaultsUri) &&
        harness.published.some((p) => p.uri === versionsUri),
    );
    harness.published.length = 0;

    // Rename variable in defaults/main.yml -> open .j2 template must be revalidated
    await harness.clientConn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: defaultsUri, version: 2 },
      contentChanges: [{ text: '---\nweb_http_port: 8080\n' }],
    });
    await waitFor(() => harness.published.some((p) => p.uri === templateUri));

    const templateAfterDefaults = harness.published.filter((p) => p.uri === templateUri);
    expect(templateAfterDefaults.length).toBeGreaterThanOrEqual(1);
    expect(
      templateAfterDefaults.at(-1)?.diagnostics.some((d) => d.code === 'undefined-variable'),
    ).toBe(true);

    // Restore defaults/main.yml and test tracked external vars_files (versions.yml)
    harness.published.length = 0;
    await harness.clientConn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: defaultsUri, version: 3 },
      contentChanges: [{ text: defaultsText }],
    });
    await waitFor(() =>
      harness.published.some((p) => p.uri === templateUri && p.diagnostics.length === 0),
    );
    harness.published.length = 0;

    await harness.clientConn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: versionsUri, version: 2 },
      contentChanges: [{ text: '---\napp_tag: "2.0.0"\n' }],
    });
    await waitFor(() => harness.published.some((p) => p.uri === templateUri));

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
    await waitFor(
      () =>
        harness.published.some((p) => p.uri === siteUri) &&
        harness.published.some((p) => p.uri === taskUri),
    );
    harness.published.length = 0;

    // Trigger change, then immediately save before debounce elapses
    await harness.clientConn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: taskUri, version: 2 },
      contentChanges: [{ text: `${taskText}\n` }],
    });
    await harness.clientConn.sendNotification(DidSaveTextDocumentNotification.type, {
      textDocument: { uri: taskUri },
    });
    await waitFor(() => harness.published.some((p) => p.uri === taskUri));
    // Wait past debounce window to confirm pending change timer was cancelled
    await delay(160);

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
    await waitFor(() => harness.published.some((p) => p.uri === taskUri));
    // Wait past debounce window to confirm debounced change did NOT fire after close
    await delay(160);

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
    await waitFor(() => harness.published.some((p) => p.uri === templateUri));
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

    await waitFor(
      () =>
        applyBatchSpy.mock.calls.length >= 1 &&
        harness.published.some((p) => p.uri === templateUri),
    );

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
    harness.published.length = 0;
    await harness.clientConn.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: fsPathToUri('/workspace/ansible.cfg'), type: FileChangeType.Changed }],
    });
    await waitFor(
      () =>
        indexWorkspaceSpy.mock.calls.length >= 1 &&
        harness.published.some((p) => p.uri === templateUri),
    );
    expect(indexWorkspaceSpy).toHaveBeenCalledTimes(1);
  });

  it('applies incremental updates and deletions for other files in a mixed watched-file batch with ansible.cfg', async () => {
    const cfgPath = '/workspace/ansible.cfg';
    const defaultsPath = '/workspace/roles/web/defaults/main.yml';
    const templatePath = '/workspace/roles/web/templates/app.conf.j2';

    const harness = await createTestHarness(
      {
        [cfgPath]: '[defaults]\nroles_path = roles\n',
        [defaultsPath]: '---\nweb_port: 8080\n',
        [templatePath]: 'PORT={{ web_port }}\n',
      },
      { watchedFilesDebounceMs: 60 },
    );
    cleanups.push(harness.cleanup);

    const cfgUri = fsPathToUri(cfgPath);
    const defaultsUri = fsPathToUri(defaultsPath);
    const templateUri = fsPathToUri(templatePath);

    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: templateUri,
        languageId: 'jinja',
        version: 1,
        text: 'PORT={{ web_port }}\n',
      },
    });
    await waitFor(() => harness.published.some((p) => p.uri === templateUri));
    expect(harness.published.at(-1)?.diagnostics).toEqual([]);
    harness.published.length = 0;

    // 1) Mixed batch: ansible.cfg (Changed) + already-indexed defaults/main.yml (Changed)
    harness.fs.setFile(defaultsPath, '---\nweb_port_renamed: 8080\n');
    await harness.clientConn.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [
        { uri: defaultsUri, type: FileChangeType.Changed },
        { uri: cfgUri, type: FileChangeType.Changed },
      ],
    });
    await waitFor(() => harness.published.some((p) => p.uri === templateUri));

    expect(
      harness.published
        .filter((p) => p.uri === templateUri)
        .at(-1)
        ?.diagnostics.some(
          (d) => d.code === 'undefined-variable' && d.message.includes('web_port'),
        ),
    ).toBe(true);

    // Restore web_port so template is clean again
    harness.published.length = 0;
    harness.fs.setFile(defaultsPath, '---\nweb_port: 8080\n');
    await harness.clientConn.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: defaultsUri, type: FileChangeType.Changed }],
    });
    await waitFor(() =>
      harness.published.some((p) => p.uri === templateUri && p.diagnostics.length === 0),
    );
    harness.published.length = 0;

    // 2) Mixed batch: ansible.cfg (Changed) + already-indexed defaults/main.yml (Deleted)
    harness.fs.deleteFile(defaultsPath);
    await harness.clientConn.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [
        { uri: defaultsUri, type: FileChangeType.Deleted },
        { uri: cfgUri, type: FileChangeType.Changed },
      ],
    });
    await waitFor(() => harness.published.some((p) => p.uri === templateUri));

    expect(
      harness.published
        .filter((p) => p.uri === templateUri)
        .at(-1)
        ?.diagnostics.some(
          (d) => d.code === 'undefined-variable' && d.message.includes('web_port'),
        ),
    ).toBe(true);
  });

  it('canonicalizes Windows URI aliases in onDidChangeWatchedFiles without spurious clears and preserves openDocumentText', async () => {
    const defaultsFsPath = 'c:/repo/roles/web/defaults/main.yml';
    const templateFsPath = 'c:/repo/roles/web/templates/app.conf.j2';
    const upperDriveDefaultsUri = 'file:///C:/repo/roles/web/defaults/main.yml';
    const encodedDriveDefaultsUri = 'file:///c%3A/repo/roles/web/defaults/main.yml';
    const templateUri = 'file:///c%3A/repo/roles/web/templates/app.conf.j2';

    const harness = await createTestHarness(
      {
        'c:/repo/ansible.cfg': '[defaults]\nroles_path = roles\n',
        [defaultsFsPath]: '---\ndisk_only_var: 1\n',
        [templateFsPath]: 'VAL={{ unsaved_open_var }}\n',
      },
      { watchedFilesDebounceMs: 60, root: 'c:/repo' },
    );
    cleanups.push(harness.cleanup);

    // Open defaults/main.yml under uppercase-drive URI with unsaved in-memory variable
    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: upperDriveDefaultsUri,
        languageId: 'yaml',
        version: 1,
        text: '---\nunsaved_open_var: 42\n',
      },
    });
    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: templateUri,
        languageId: 'jinja',
        version: 1,
        text: 'VAL={{ unsaved_open_var }}\n',
      },
    });
    await waitFor(
      () =>
        harness.published.some((p) => p.uri === upperDriveDefaultsUri) &&
        harness.published.some((p) => p.uri === templateUri),
    );
    expect(harness.published.filter((p) => p.uri === templateUri).at(-1)?.diagnostics).toEqual([]);
    harness.published.length = 0;

    const applyBatchSpy = vi.spyOn(harness.service, 'applyWatchedFileChanges');

    // Emit Deleted under raw C:/ alias followed by Created under encoded c%3A alias in one window
    await harness.clientConn.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [
        { uri: upperDriveDefaultsUri, type: FileChangeType.Deleted },
        { uri: encodedDriveDefaultsUri, type: FileChangeType.Created },
      ],
    });
    await waitFor(() => harness.published.some((p) => p.uri === templateUri));

    // Last event (Created) wins: canonical deduplication collapses both aliases into 1 non-deleted change
    // and preserves openDocumentText from the open upperDriveDefaultsUri tab
    expect(applyBatchSpy).toHaveBeenCalledTimes(1);
    expect(applyBatchSpy).toHaveBeenCalledWith([
      {
        uri: encodedDriveDefaultsUri,
        deleted: false,
        openDocumentText: '---\nunsaved_open_var: 42\n',
      },
    ]);

    // Open template still resolves `unsaved_open_var` with 0 undefined-variable diagnostics
    expect(
      harness.published
        .filter((p) => p.uri === templateUri)
        .at(-1)
        ?.diagnostics.some((d) => d.code === 'undefined-variable'),
    ).toBe(false);
    // Exactly 1 publish for upperDriveDefaultsUri (from revalidateAllOpenDocuments, 0 spurious delete clears)
    expect(harness.published.filter((p) => p.uri === upperDriveDefaultsUri)).toHaveLength(1);
  });

  it('revalidates open tabs when a previously missing vars_files target is created externally', async () => {
    const sitePath = '/workspace/site.yml';
    const versionsPath = '/workspace/versions.yml';
    const templatePath = '/workspace/roles/web/templates/app.conf.j2';
    const siteText =
      '---\n- name: Main\n  hosts: all\n  vars_files:\n    - versions.yml\n  roles:\n    - web\n';

    const harness = await createTestHarness(
      {
        '/workspace/ansible.cfg': '[defaults]\nroles_path = roles\n',
        [sitePath]: siteText,
        [templatePath]: 'VER={{ app_ver }}\n',
      },
      { watchedFilesDebounceMs: 60 },
    );
    cleanups.push(harness.cleanup);

    const templateUri = fsPathToUri(templatePath);
    const versionsUri = fsPathToUri(versionsPath);

    await harness.clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: templateUri,
        languageId: 'jinja',
        version: 1,
        text: 'VER={{ app_ver }}\n',
      },
    });
    await waitFor(() => harness.published.some((p) => p.uri === templateUri));
    expect(
      harness.published
        .filter((p) => p.uri === templateUri)
        .at(-1)
        ?.diagnostics.some((d) => d.code === 'undefined-variable' && d.message.includes('app_ver')),
    ).toBe(true);
    harness.published.length = 0;

    // Externally create versions.yml on disk and emit watched-file Created event
    harness.fs.setFile(versionsPath, '---\napp_ver: "1.2.3"\n');
    await harness.clientConn.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: versionsUri, type: FileChangeType.Created }],
    });
    await waitFor(() =>
      harness.published.some((p) => p.uri === templateUri && p.diagnostics.length === 0),
    );
    expect(harness.published.filter((p) => p.uri === templateUri).at(-1)?.diagnostics).toEqual([]);
  });
});
