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
import { AnsibleLanguageService } from './language-service.js';
import { createServerLogger } from './logger.js';

export interface BoundServer {
  readonly connection: Connection;
  readonly documents: TextDocuments<TextDocument>;
  readonly service: AnsibleLanguageService;
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

  const validateDocument = (doc: TextDocument): void => {
    try {
      engine.updateDocument(doc.uri, doc.getText());
      const diagnostics = engine.getDiagnostics(doc.uri, doc.getText());
      connection.sendDiagnostics({ uri: doc.uri, diagnostics });
    } catch (error) {
      logger.error('Failed to validate document', {
        uri: doc.uri,
        error: error instanceof Error ? error.message : String(error),
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

    const initOpts = params.initializationOptions as
      { readonly documentLinksEnabled?: boolean } | undefined;
    if (typeof initOpts?.documentLinksEnabled === 'boolean') {
      engine.setDocumentLinksEnabled(initOpts.documentLinksEnabled);
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

  connection.onRequest(
    'ansibleLens/getModuleDocsMarkdown',
    (params?: { readonly moduleName?: string }) => {
      const moduleName = typeof params?.moduleName === 'string' ? params.moduleName : '';
      return { markdown: engine.getModuleDocsMarkdown(moduleName) };
    },
  );

  connection.onRequest('ansibleLens/refreshMetadata', () => {
    engine.indexWorkspace();
    for (const doc of documents.all()) {
      validateDocument(doc);
    }
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
