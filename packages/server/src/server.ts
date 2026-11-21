import {
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection,
} from 'vscode-languageserver/node.js';
import type {
  CodeAction,
  CompletionItem,
  Connection,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  LocationLink,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  AnsibleLanguageService,
  type DocsCtrlClickBehavior,
  type ServerSettings,
  type WatchedFileChange,
} from './language-service.js';
import { createServerLogger } from './logger.js';
import { normalizeDocumentUri } from './workspace-fs.js';

/** Default debounce delay (ms) for active-document content changes. */
export const DEFAULT_CHANGE_DEBOUNCE_MS = 200;

/** Default debounce delay (ms) for watched workspace file events. */
export const DEFAULT_WATCHED_FILES_DEBOUNCE_MS = 400;

/** Optional tuning knobs for `bindLanguageServer`. */
export interface BindServerOptions {
  /** Debounce delay in milliseconds for `documents.onDidChangeContent`. Defaults to `200`. */
  readonly changeDebounceMs?: number;
  /** Debounce delay in milliseconds for `connection.onDidChangeWatchedFiles`. Defaults to `400`. */
  readonly watchedFilesDebounceMs?: number;
}

export interface BoundServer {
  readonly connection: Connection;
  readonly documents: TextDocuments<TextDocument>;
  readonly service: AnsibleLanguageService;
  /** Cancels any pending debounce timers owned by this server binding. */
  dispose(): void;
}

function parseDocsCtrlClickBehavior(raw: unknown): DocsCtrlClickBehavior | undefined {
  if (raw === 'renderedPreview' || raw === 'openInBrowser' || raw === 'disabled') {
    return raw;
  }
  return undefined;
}

function extractServerSettings(raw: unknown): ServerSettings | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const root =
    typeof obj['ansibleLens'] === 'object' && obj['ansibleLens'] !== null
      ? (obj['ansibleLens'] as Record<string, unknown>)
      : obj;

  const docsObj =
    typeof root['docs'] === 'object' && root['docs'] !== null
      ? (root['docs'] as Record<string, unknown>)
      : undefined;
  const docsCtrlClickBehavior =
    parseDocsCtrlClickBehavior(root['docsCtrlClickBehavior']) ??
    parseDocsCtrlClickBehavior(docsObj?.['ctrlClickBehavior']);

  const lintObj =
    typeof root['lint'] === 'object' && root['lint'] !== null
      ? (root['lint'] as Record<string, unknown>)
      : undefined;
  const metadataObj =
    typeof root['metadata'] === 'object' && root['metadata'] !== null
      ? (root['metadata'] as Record<string, unknown>)
      : undefined;
  const ansibleObj =
    typeof root['ansible'] === 'object' && root['ansible'] !== null
      ? (root['ansible'] as Record<string, unknown>)
      : undefined;

  const ansibleRootPaths = Array.isArray(root['ansibleRootPaths'])
    ? (root['ansibleRootPaths'] as string[])
    : Array.isArray(ansibleObj?.['rootPaths'])
      ? (ansibleObj['rootPaths'] as string[])
      : undefined;

  return {
    ...(docsCtrlClickBehavior !== undefined ? { docsCtrlClickBehavior } : {}),
    ...(lintObj
      ? {
          lint: {
            ...(typeof lintObj['enabled'] === 'boolean' ? { enabled: lintObj['enabled'] } : {}),
            ...(typeof lintObj['profile'] === 'string'
              ? {
                  profile: lintObj['profile'] as 'minimal' | 'basic' | 'moderate' | 'production',
                }
              : {}),
            ...(typeof lintObj['rules'] === 'object' && lintObj['rules'] !== null
              ? {
                  rules: lintObj['rules'] as Readonly<
                    Record<string, 'error' | 'warning' | 'info' | 'off'>
                  >,
                }
              : {}),
            ...(Array.isArray(lintObj['extraVars'])
              ? { extraVars: lintObj['extraVars'] as string[] }
              : {}),
          },
        }
      : {}),
    ...(metadataObj
      ? {
          metadata: {
            ...(typeof metadataObj['autoDownload'] === 'boolean'
              ? { autoDownload: metadataObj['autoDownload'] }
              : {}),
            ...(typeof metadataObj['manifestUrl'] === 'string'
              ? { manifestUrl: metadataObj['manifestUrl'] }
              : {}),
          },
        }
      : {}),
    ...(ansibleRootPaths !== undefined ? { ansibleRootPaths } : {}),
  };
}

/**
 * Binds an `AnsibleLanguageService` instance to an LSP `Connection` and
 * `TextDocuments` manager. Used both by the standalone stdio/IPC server
 * binary and by in-process protocol integration tests.
 */
export function bindLanguageServer(
  connection: Connection,
  service?: AnsibleLanguageService,
  options?: BindServerOptions,
): BoundServer {
  const logger = createServerLogger('server', connection.console);
  const documents = new TextDocuments(TextDocument);
  const engine =
    service ??
    new AnsibleLanguageService({
      logger,
    });

  const changeDebounceMs = Math.max(0, options?.changeDebounceMs ?? DEFAULT_CHANGE_DEBOUNCE_MS);
  const watchedFilesDebounceMs = Math.max(
    0,
    options?.watchedFilesDebounceMs ?? DEFAULT_WATCHED_FILES_DEBOUNCE_MS,
  );

  const pendingChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingWatchedChanges = new Map<string, number>();
  const lastOpenedVersion = new Map<string, number>();
  let watchedFilesTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearPendingChangeTimer = (uri: string): void => {
    const existing = pendingChangeTimers.get(uri);
    if (existing !== undefined) {
      clearTimeout(existing);
      pendingChangeTimers.delete(uri);
    }
  };

  const dispose = (): void => {
    disposed = true;
    for (const timer of pendingChangeTimers.values()) {
      clearTimeout(timer);
    }
    pendingChangeTimers.clear();
    if (watchedFilesTimer !== undefined) {
      clearTimeout(watchedFilesTimer);
      watchedFilesTimer = undefined;
    }
    pendingWatchedChanges.clear();
    lastOpenedVersion.clear();
  };

  const revalidateAllOpenDocuments = (excludeUri?: string): void => {
    if (disposed) {
      return;
    }
    const canonicalExclude = excludeUri ? normalizeDocumentUri(excludeUri) : undefined;
    for (const openDoc of documents.all()) {
      if (
        canonicalExclude !== undefined &&
        normalizeDocumentUri(openDoc.uri) === canonicalExclude
      ) {
        continue;
      }
      try {
        const diagnostics = engine.getDiagnostics(openDoc.uri, openDoc.getText());
        connection.sendDiagnostics({ uri: openDoc.uri, diagnostics });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        engine.recordError(msg);
      }
    }
  };

  const triggerSilentAutoDownload = (uri: string, text: string): void => {
    if (disposed || !engine.isAutoDownloadEnabled()) {
      return;
    }
    const unloaded = engine.findUnloadedCollectionsInDocument(uri, text);
    if (unloaded.length === 0) {
      return;
    }
    void connection.sendNotification('ansibleLens/collectionDownloadProgress', {
      state: 'downloading',
      collections: unloaded,
      collectionsCount: engine.getLoadedCollectionsCount(),
    });
    void engine.downloadCollections(unloaded).then((loaded) => {
      if (disposed) {
        return;
      }
      void connection.sendNotification('ansibleLens/collectionDownloadProgress', {
        state: 'idle',
        collections: loaded,
        collectionsCount: engine.getLoadedCollectionsCount(),
      });
      if (loaded.length > 0) {
        revalidateAllOpenDocuments();
      }
    });
  };

  const validateDocument = (doc: TextDocument): void => {
    if (disposed) {
      return;
    }
    try {
      const text = doc.getText();
      engine.updateDocument(doc.uri, text);
      const diagnostics = engine.getDiagnostics(doc.uri, text);
      connection.sendDiagnostics({ uri: doc.uri, diagnostics });
      triggerSilentAutoDownload(doc.uri, text);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      engine.recordError(msg);
      if (!disposed) {
        logger.error('Failed to validate document', {
          uri: doc.uri,
          error: msg,
        });
      }
    }
  };

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    if (params.workspaceFolders) {
      for (const folder of params.workspaceFolders) {
        engine.addWorkspaceRoot(folder.uri);
      }
    } else if (params.rootUri) {
      engine.addWorkspaceRoot(params.rootUri);
    } else if (params.rootPath) {
      engine.addWorkspaceRoot(params.rootPath);
    }

    const initialSettings = extractServerSettings(params.initializationOptions);
    if (initialSettings) {
      engine.applySettings(initialSettings);
    }

    engine.indexWorkspace();

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: {
          resolveProvider: false,
          triggerCharacters: ['.', ':', '|', ' '],
        },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        codeActionProvider: {
          codeActionKinds: ['quickfix', 'source.fixAll.ansible-lens.fqcn'],
        },
      },
    };
  });

  connection.onShutdown(() => {
    dispose();
  });

  connection.onExit(() => {
    dispose();
  });

  connection.onDidChangeConfiguration((change) => {
    const parsed = extractServerSettings(change.settings);
    if (parsed) {
      engine.applySettings(parsed);
      engine.indexWorkspace();
      revalidateAllOpenDocuments();
    }
  });

  documents.onDidOpen((event) => {
    lastOpenedVersion.set(event.document.uri, event.document.version);
    validateDocument(event.document);
  });

  documents.onDidChangeContent((change) => {
    const uri = change.document.uri;
    if (lastOpenedVersion.get(uri) === change.document.version) {
      lastOpenedVersion.delete(uri);
      return;
    }
    lastOpenedVersion.delete(uri);
    clearPendingChangeTimer(uri);
    const timer = setTimeout(() => {
      pendingChangeTimers.delete(uri);
      if (disposed) {
        return;
      }
      const latestDoc = documents.get(uri);
      if (!latestDoc) {
        return;
      }
      const latestText = latestDoc.getText();
      const wasShared = engine.isSharedProviderDocument(latestDoc.uri, latestText);
      validateDocument(latestDoc);
      if (wasShared || engine.isSharedProviderDocument(latestDoc.uri, latestText)) {
        revalidateAllOpenDocuments(latestDoc.uri);
      }
    }, changeDebounceMs);
    pendingChangeTimers.set(uri, timer);
  });

  documents.onDidSave((event) => {
    const uri = event.document.uri;
    clearPendingChangeTimer(uri);
    const text = event.document.getText();
    const wasShared = engine.isSharedProviderDocument(uri, text);
    validateDocument(event.document);
    if (wasShared || engine.isSharedProviderDocument(uri, text)) {
      revalidateAllOpenDocuments(uri);
    }
  });

  documents.onDidClose((event) => {
    const uri = event.document.uri;
    lastOpenedVersion.delete(uri);
    clearPendingChangeTimer(uri);
    const wasShared = engine.isSharedProviderDocument(uri);
    engine.closeDocument(uri);
    connection.sendDiagnostics({ uri, diagnostics: [] });
    if (wasShared) {
      revalidateAllOpenDocuments(uri);
    }
  });

  connection.onDidChangeWatchedFiles((params) => {
    for (const change of params.changes) {
      // FileChangeType: 1 = Created, 2 = Changed, 3 = Deleted
      pendingWatchedChanges.set(change.uri, change.type);
    }
    if (watchedFilesTimer !== undefined) {
      clearTimeout(watchedFilesTimer);
    }
    watchedFilesTimer = setTimeout(() => {
      watchedFilesTimer = undefined;
      if (disposed) {
        return;
      }
      const batch: WatchedFileChange[] = [];
      const deletedUris: string[] = [];
      const batchedCanonicalUris = new Set<string>();

      for (const [uri, changeType] of pendingWatchedChanges.entries()) {
        batchedCanonicalUris.add(normalizeDocumentUri(uri));
        if (changeType === 3) {
          deletedUris.push(uri);
          batch.push({ uri, deleted: true });
        } else {
          const openDoc = documents.get(uri);
          batch.push({
            uri,
            deleted: false,
            ...(openDoc ? { openDocumentText: openDoc.getText() } : {}),
          });
        }
      }
      pendingWatchedChanges.clear();

      for (const uri of deletedUris) {
        connection.sendDiagnostics({ uri, diagnostics: [] });
      }

      const result = engine.applyWatchedFileChanges(batch);
      if (result.needsFullWorkspaceReindex || result.affectsSharedProviders) {
        revalidateAllOpenDocuments();
      } else {
        for (const openDoc of documents.all()) {
          if (batchedCanonicalUris.has(normalizeDocumentUri(openDoc.uri))) {
            try {
              const diagnostics = engine.getDiagnostics(openDoc.uri, openDoc.getText());
              connection.sendDiagnostics({ uri: openDoc.uri, diagnostics });
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              engine.recordError(msg);
            }
          }
        }
      }
    }, watchedFilesDebounceMs);
  });

  connection.onCompletion((params): CompletionItem[] => {
    const doc = documents.get(params.textDocument.uri);
    return engine.getCompletions(params.textDocument.uri, params.position, doc?.getText());
  });

  connection.onHover((params): Hover | null => {
    const doc = documents.get(params.textDocument.uri);
    return engine.getHover(params.textDocument.uri, params.position, doc?.getText());
  });

  connection.onDefinition((params): Location[] | LocationLink[] => {
    const doc = documents.get(params.textDocument.uri);
    return engine.getDefinition(params.textDocument.uri, params.position, doc?.getText());
  });

  connection.onReferences((params): Location[] => {
    const doc = documents.get(params.textDocument.uri);
    return engine.getReferences(params.textDocument.uri, params.position, doc?.getText());
  });

  connection.onCodeAction((params): CodeAction[] => {
    const doc = documents.get(params.textDocument.uri);
    return engine.getCodeActions(params.textDocument.uri, params.range, doc?.getText());
  });

  connection.onRequest('ansibleLens/getMetadataStatus', () => ({
    collectionsCount: engine.getLoadedCollectionsCount(),
    modulesCount: engine.getRegistry().listModules().length,
  }));

  connection.onRequest('ansibleLens/updateSettings', (params?: unknown) => {
    const parsed = extractServerSettings(params);
    if (parsed) {
      engine.applySettings(parsed);
      engine.indexWorkspace();
      revalidateAllOpenDocuments();
    }
    return {
      collectionsCount: engine.getLoadedCollectionsCount(),
      modulesCount: engine.getRegistry().listModules().length,
    };
  });

  connection.onRequest(
    'ansibleLens/getDiagnosticsInfo',
    (params?: { readonly activeUri?: string }) => engine.getDiagnosticsInfo(params?.activeUri),
  );

  connection.onRequest(
    'ansibleLens/getModuleDocsMarkdown',
    (params?: { readonly moduleName?: string }) => {
      const moduleName = typeof params?.moduleName === 'string' ? params.moduleName : '';
      return { markdown: engine.getModuleDocsMarkdown(moduleName) };
    },
  );

  connection.onRequest('ansibleLens/refreshMetadata', () => {
    engine.indexWorkspace();
    revalidateAllOpenDocuments();
    return {
      collectionsCount: engine.getLoadedCollectionsCount(),
      modulesCount: engine.getRegistry().listModules().length,
    };
  });

  documents.listen(connection);
  return { connection, documents, service: engine, dispose };
}

/**
 * Starts the stdio/IPC LSP server process when invoked directly as the server entrypoint.
 */
export function startLanguageServer(): BoundServer {
  const connection = createConnection(ProposedFeatures.all);
  const bound = bindLanguageServer(connection);
  connection.listen();
  return bound;
}

const isEntrypoint =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('server.js') ||
    process.argv[1].endsWith('server.cjs') ||
    process.argv[1].endsWith('server.ts'));

if (isEntrypoint) {
  startLanguageServer();
}
