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
  DocumentLink,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  LocationLink,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AnsibleLanguageService, type ServerSettings } from './language-service.js';
import { createServerLogger } from './logger.js';

export interface BoundServer {
  readonly connection: Connection;
  readonly documents: TextDocuments<TextDocument>;
  readonly service: AnsibleLanguageService;
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

  const docLinksObj =
    typeof root['documentLinks'] === 'object' && root['documentLinks'] !== null
      ? (root['documentLinks'] as Record<string, unknown>)
      : undefined;
  const documentLinksEnabled =
    typeof root['documentLinksEnabled'] === 'boolean'
      ? root['documentLinksEnabled']
      : typeof docLinksObj?.['enabled'] === 'boolean'
        ? docLinksObj['enabled']
        : undefined;

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
    ...(documentLinksEnabled !== undefined ? { documentLinksEnabled } : {}),
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
): BoundServer {
  const logger = createServerLogger('server', connection.console);
  const documents = new TextDocuments(TextDocument);
  const engine =
    service ??
    new AnsibleLanguageService({
      logger,
    });

  const revalidateAllOpenDocuments = (): void => {
    for (const openDoc of documents.all()) {
      try {
        engine.updateDocument(openDoc.uri, openDoc.getText());
        const diagnostics = engine.getDiagnostics(openDoc.uri, openDoc.getText());
        connection.sendDiagnostics({ uri: openDoc.uri, diagnostics });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        engine.recordError(msg);
      }
    }
  };

  const triggerSilentAutoDownload = (uri: string, text: string): void => {
    if (!engine.isAutoDownloadEnabled()) {
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
    try {
      const text = doc.getText();
      engine.updateDocument(doc.uri, text);
      const diagnostics = engine.getDiagnostics(doc.uri, text);
      connection.sendDiagnostics({ uri: doc.uri, diagnostics });
      triggerSilentAutoDownload(doc.uri, text);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      engine.recordError(msg);
      logger.error('Failed to validate document', {
        uri: doc.uri,
        error: msg,
      });
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
        documentLinkProvider: {
          resolveProvider: false,
        },
        codeActionProvider: {
          codeActionKinds: ['quickfix', 'source.fixAll.ansible-lens.fqcn'],
        },
      },
    };
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
    validateDocument(event.document);
  });

  documents.onDidChangeContent((change) => {
    validateDocument(change.document);
  });

  documents.onDidClose((event) => {
    engine.removeDocument(event.document.uri);
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  connection.onCompletion((params): CompletionItem[] => {
    const doc = documents.get(params.textDocument.uri);
    return engine.getCompletions(params.textDocument.uri, params.position, doc?.getText());
  });

  connection.onHover((params): Hover | null => {
    const doc = documents.get(params.textDocument.uri);
    return engine.getHover(params.textDocument.uri, params.position, doc?.getText());
  });

  connection.onDocumentLinks((params): DocumentLink[] => {
    const doc = documents.get(params.textDocument.uri);
    return engine.getDocumentLinks(params.textDocument.uri, doc?.getText());
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

  connection.onRequest(
    'ansibleLens/setDocumentLinksEnabled',
    (params?: { readonly enabled?: boolean }) => {
      engine.setDocumentLinksEnabled(Boolean(params?.enabled));
      return { documentLinksEnabled: engine.isDocumentLinksEnabled() };
    },
  );

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
  return { connection, documents, service: engine };
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
