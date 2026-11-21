import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  DidChangeConfigurationNotification,
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node.js';
import type {
  DiagnosticsInfoReport,
  DocsCtrlClickBehavior,
  ServerSettings,
} from '@ansible-lens/server';
import { shouldActivateForDocument, workspaceHasAnsibleCfg } from './activation.js';
import {
  GET_MODULE_DOCS_REQUEST,
  MODULE_DOCS_SCHEME,
  ModuleDocsContentProvider,
  showRenderedDocsPreview,
} from './docs-provider.js';
import { resolveOpenInBrowserUrl } from './docs-uri.js';
import { evaluateJinjaBraceAutoSpace } from './jinja-autospace.js';
import { createClientLogger, type ClientLogger } from './logger.js';

export const EXTENSION_ID = 'amr-vibe.ansible-lens';
export const OFFICIAL_DOCS_URL =
  'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/index.html';

export const COMMAND_OPEN_OFFICIAL_DOCS = 'ansibleLens.openOfficialDocs';
export const COMMAND_REFRESH_METADATA = 'ansibleLens.refreshMetadata';
export const COMMAND_CONVERT_FILE_TO_FQCN = 'ansibleLens.convertFileToFqcn';
export const COMMAND_COPY_DIAGNOSTICS_INFO = 'ansibleLens.copyDiagnosticsInfo';

let client: LanguageClient | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export function getExtensionId(): string {
  return EXTENSION_ID;
}

/**
 * Formats the status bar text displaying Ansible Lens active state and
 * loaded collection count (or a brief download spinner while fetching metadata packs).
 */
export function formatStatusBarText(
  active: boolean,
  collectionsCount: number,
  downloadingCollections?: readonly string[],
): string {
  if (downloadingCollections && downloadingCollections.length > 0) {
    return `$(sync~spin) Ansible Lens (downloading ${downloadingCollections.join(', ')}...)`;
  }
  if (!active) {
    return '$(eye) Ansible Lens: Standby';
  }
  const suffix = collectionsCount === 1 ? 'collection' : 'collections';
  return `$(eye) Ansible Lens (${collectionsCount} ${suffix})`;
}

/**
 * Formats a human-readable diagnostics summary copied to the clipboard by
 * `Ansible Lens: Copy Diagnostics Info`.
 */
export function formatDiagnosticsInfoReport(params: {
  readonly osPlatform: string;
  readonly osRelease: string;
  readonly vscodeVersion: string;
  readonly extensionVersion: string;
  readonly serverInfo?: DiagnosticsInfoReport;
}): string {
  const info = params.serverInfo;
  const lines: string[] = [
    'Ansible Lens Diagnostics Info',
    '=============================',
    `OS: ${params.osPlatform} (${params.osRelease})`,
    `VS Code Version: ${params.vscodeVersion}`,
    `Extension Version: ${params.extensionVersion}`,
    `Detected Ansible Root: ${info?.detectedAnsibleRoot ?? 'none'}`,
    `Workspace Roots: ${info && info.workspaceRoots.length > 0 ? info.workspaceRoots.join(', ') : 'none'}`,
    `Configured Root Paths: ${info && info.ansibleRootPaths.length > 0 ? info.ansibleRootPaths.join(', ') : 'none'}`,
    `Loaded Collections (${info?.loadedCollections.length ?? 0}): ${info && info.loadedCollections.length > 0 ? info.loadedCollections.join(', ') : 'none'}`,
    `Loaded Modules: ${info?.loadedModulesCount ?? 0}`,
    `Indexed Documents: ${info?.indexedDocumentsCount ?? 0}`,
    `Indexed Variables: ${info?.indexedVariablesCount ?? 0}`,
    `Recent Errors: ${info && info.recentErrors.length > 0 ? info.recentErrors.join(' | ') : 'none'}`,
  ];
  return lines.join('\n');
}

function readWorkspaceSettings(): ServerSettings {
  const cfg = vscode.workspace.getConfiguration('ansibleLens');
  const profile = cfg.get<'minimal' | 'basic' | 'moderate' | 'production'>(
    'lint.profile',
    'moderate',
  );
  const docsCtrlClickBehavior = cfg.get<DocsCtrlClickBehavior>(
    'docs.ctrlClickBehavior',
    'renderedPreview',
  );
  return {
    docsCtrlClickBehavior,
    lint: {
      enabled: cfg.get<boolean>('lint.enabled', true),
      profile,
      rules: cfg.get<Readonly<Record<string, 'error' | 'warning' | 'info' | 'off'>>>(
        'lint.rules',
        {},
      ),
      extraVars: cfg.get<readonly string[]>('lint.extraVars', []),
    },
    metadata: {
      autoDownload: cfg.get<boolean>('metadata.autoDownload', true),
      manifestUrl: cfg.get<string>(
        'metadata.manifestUrl',
        'https://github.com/amr-vibe/ansible-lens/releases/download/metadata-latest/manifest.json',
      ),
    },
    ansibleRootPaths: cfg.get<readonly string[]>('ansible.rootPaths', []),
  };
}

function updateStatusBar(
  item: vscode.StatusBarItem,
  active: boolean,
  collectionsCount: number,
  reason?: string,
  downloadingCollections?: readonly string[],
): void {
  item.text = formatStatusBarText(active, collectionsCount, downloadingCollections);
  item.tooltip = active
    ? `Ansible Lens active (${collectionsCount} loaded collection(s))${reason ? ` — ${reason}` : ''}`
    : 'Ansible Lens standing by (no active Ansible document)';
  item.command = COMMAND_OPEN_OFFICIAL_DOCS;
  item.show();
}

function isWorkspaceAnsibleEnabled(docFsPath?: string): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const candidateDirs = folders.map((f) => f.uri.fsPath);
  if (docFsPath) {
    let cur = path.dirname(docFsPath);
    for (let depth = 0; depth < 8; depth++) {
      candidateDirs.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) {
        break;
      }
      cur = parent;
    }
  }
  return workspaceHasAnsibleCfg(candidateDirs, (filePath) => fs.existsSync(filePath));
}

function evaluateEditorActivation(
  editor: vscode.TextEditor | undefined,
  item: vscode.StatusBarItem,
  collectionsCount: number,
  logger: ClientLogger,
): void {
  if (!editor) {
    updateStatusBar(item, false, collectionsCount);
    return;
  }
  const doc = editor.document;
  const hasCfg = isWorkspaceAnsibleEnabled(doc.uri.fsPath);
  const result = shouldActivateForDocument(
    {
      uri: doc.uri.toString(),
      languageId: doc.languageId,
      text: doc.getText(),
    },
    hasCfg,
  );
  updateStatusBar(item, result.isAnsible, collectionsCount, result.reason);
  if (result.isAnsible) {
    logger.debug('Activated Smart Hybrid evaluation for document', {
      uri: doc.uri.toString(),
      kind: result.kind,
      reason: result.reason,
    });
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Ansible Lens');
  const logger = createClientLogger(outputChannel);
  context.subscriptions.push(outputChannel);

  const serverModule = context.asAbsolutePath(path.join('dist', 'server.cjs'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'yaml' },
      { scheme: 'file', language: 'ansible' },
      { scheme: 'file', language: 'jinja' },
      { scheme: 'file', language: 'jinja2' },
      { scheme: 'file', pattern: '**/*.j2' },
      { scheme: 'untitled', language: 'yaml' },
      { scheme: 'untitled', language: 'ansible' },
      { scheme: 'untitled', language: 'jinja' },
      { scheme: 'untitled', language: 'jinja2' },
    ],
    outputChannel,
    initializationOptions: readWorkspaceSettings(),
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{yml,yaml,ini,cfg,j2}'),
    },
    middleware: {
      provideDefinition: async (document, position, token, next) => {
        const result = await next(document, position, token);
        if (token.isCancellationRequested) {
          return undefined;
        }
        const behavior = vscode.workspace
          .getConfiguration('ansibleLens')
          .get<DocsCtrlClickBehavior>('docs.ctrlClickBehavior', 'renderedPreview');
        if (behavior === 'openInBrowser' && result) {
          const docsUrl = resolveOpenInBrowserUrl(result);
          if (docsUrl) {
            try {
              await vscode.env.openExternal(vscode.Uri.parse(docsUrl));
            } catch (error) {
              logger.warn('Failed to open module documentation in browser', {
                url: docsUrl,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            return undefined;
          }
        }
        return result;
      },
    },
  };

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBarItem);

  let collectionsCount = 1;
  updateStatusBar(statusBarItem, false, collectionsCount);

  client = new LanguageClient(
    'ansible-lens',
    'Ansible Lens Language Server',
    serverOptions,
    clientOptions,
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_OPEN_OFFICIAL_DOCS, async () => {
      await vscode.env.openExternal(vscode.Uri.parse(OFFICIAL_DOCS_URL));
      logger.info('Opened official Ansible documentation');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_REFRESH_METADATA, async () => {
      if (!client) {
        return;
      }
      try {
        const status = await client.sendRequest<{ collectionsCount: number; modulesCount: number }>(
          'ansibleLens/refreshMetadata',
        );
        collectionsCount = status.collectionsCount;
        if (statusBarItem) {
          evaluateEditorActivation(
            vscode.window.activeTextEditor,
            statusBarItem,
            collectionsCount,
            logger,
          );
        }
        vscode.window.showInformationMessage(
          `Ansible Lens: Refreshed ${status.collectionsCount} collection(s), ${status.modulesCount} module(s).`,
        );
      } catch (error) {
        logger.error('Failed to refresh metadata', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_CONVERT_FILE_TO_FQCN, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const doc = editor.document;
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        doc.uri,
        fullRange,
        'source.fixAll.ansible-lens.fqcn',
      );
      const fqcnAction = actions?.find((a) => a.title === 'Convert File to FQCN');
      if (fqcnAction?.edit) {
        await vscode.workspace.applyEdit(fqcnAction.edit);
        logger.info('Applied Convert File to FQCN edits', { uri: doc.uri.toString() });
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_COPY_DIAGNOSTICS_INFO, async () => {
      const extVersion =
        (context.extension.packageJSON as { readonly version?: string } | undefined)?.version ??
        '0.1.1';
      let serverInfo: DiagnosticsInfoReport | undefined;
      if (client && client.isRunning()) {
        try {
          const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
          serverInfo = await client.sendRequest<DiagnosticsInfoReport>(
            'ansibleLens/getDiagnosticsInfo',
            { activeUri },
          );
        } catch (error) {
          logger.warn('Could not query server diagnostics info', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const report = formatDiagnosticsInfoReport({
        osPlatform: os.platform(),
        osRelease: os.release(),
        vscodeVersion: vscode.version,
        extensionVersion: extVersion,
        ...(serverInfo ? { serverInfo } : {}),
      });
      await vscode.env.clipboard.writeText(report);
      logger.info('Copied Ansible Lens diagnostics info to clipboard');
      return report;
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (statusBarItem) {
        evaluateEditorActivation(editor, statusBarItem, collectionsCount, logger);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      const active = vscode.window.activeTextEditor;
      if (active && active.document.uri.toString() === doc.uri.toString() && statusBarItem) {
        evaluateEditorActivation(active, statusBarItem, collectionsCount, logger);
      }
    }),
  );

  let isApplyingAutoSpace = false;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (isApplyingAutoSpace || event.contentChanges.length !== 1) {
        return;
      }
      if (
        event.reason === vscode.TextDocumentChangeReason.Undo ||
        event.reason === vscode.TextDocumentChangeReason.Redo
      ) {
        return;
      }
      const autoSpaceEnabled = vscode.workspace
        .getConfiguration('ansibleLens')
        .get<boolean>('jinja.autoSpaceBraces', true);
      if (!autoSpaceEnabled) {
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== event.document.uri.toString()) {
        return;
      }
      const change = event.contentChanges[0];
      if (!change || change.range.start.line !== change.range.end.line) {
        return;
      }
      const doc = event.document;
      const hasCfg = isWorkspaceAnsibleEnabled(doc.uri.fsPath);
      const activation = shouldActivateForDocument(
        {
          uri: doc.uri.toString(),
          languageId: doc.languageId,
          text: doc.getText(),
        },
        hasCfg,
      );
      if (!activation.isAnsible) {
        return;
      }
      const lineIdx = change.range.start.line;
      const lineText = doc.lineAt(lineIdx).text;
      const reaction = evaluateJinjaBraceAutoSpace(
        lineText,
        change.range.start.character,
        change.rangeLength,
        change.text,
      );
      if (!reaction) {
        return;
      }
      isApplyingAutoSpace = true;
      try {
        const editRange = new vscode.Range(
          new vscode.Position(lineIdx, reaction.replaceStartCol),
          new vscode.Position(lineIdx, reaction.replaceEndCol),
        );
        const applied = await editor.edit(
          (editBuilder) => {
            editBuilder.replace(editRange, reaction.newText);
          },
          { undoStopBefore: false, undoStopAfter: false },
        );
        if (applied) {
          const cursorPos = new vscode.Position(lineIdx, reaction.cursorCol);
          editor.selection = new vscode.Selection(cursorPos, cursorPos);
        }
      } finally {
        isApplyingAutoSpace = false;
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('ansibleLens') && client && client.isRunning()) {
        const settings = readWorkspaceSettings();
        try {
          await client.sendNotification(DidChangeConfigurationNotification.type, {
            settings: { ansibleLens: settings },
          });
          await client.sendRequest('ansibleLens/updateSettings', settings);
        } catch (error) {
          logger.warn('Failed to push updated settings to server', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }),
  );

  const languageClient = client;
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      MODULE_DOCS_SCHEME,
      new ModuleDocsContentProvider({
        requestMarkdown: async (moduleName) => {
          try {
            if (!languageClient.isRunning()) {
              await languageClient.start();
            }
            const res = await languageClient.sendRequest<{ markdown: string }>(
              GET_MODULE_DOCS_REQUEST,
              { moduleName },
            );
            return res.markdown;
          } catch (error) {
            logger.warn('Failed to fetch module docs from server', {
              moduleName,
              error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
          }
        },
      }),
    ),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      const behavior = vscode.workspace
        .getConfiguration('ansibleLens')
        .get<DocsCtrlClickBehavior>('docs.ctrlClickBehavior', 'renderedPreview');
      if (behavior !== 'renderedPreview') {
        return;
      }
      try {
        await showRenderedDocsPreview(editor);
      } catch (error) {
        logger.warn('Failed to handle module docs Ctrl+Click action', {
          behavior,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  await client.start();

  context.subscriptions.push(
    client.onNotification(
      'ansibleLens/collectionDownloadProgress',
      (payload: {
        readonly state: 'downloading' | 'idle';
        readonly collections: readonly string[];
        readonly collectionsCount: number;
      }) => {
        collectionsCount = payload.collectionsCount;
        if (!statusBarItem) {
          return;
        }
        if (payload.state === 'downloading') {
          updateStatusBar(
            statusBarItem,
            true,
            collectionsCount,
            'Downloading collection metadata',
            payload.collections,
          );
        } else {
          evaluateEditorActivation(
            vscode.window.activeTextEditor,
            statusBarItem,
            collectionsCount,
            logger,
          );
        }
      },
    ),
  );

  try {
    const status = await client.sendRequest<{ collectionsCount: number; modulesCount: number }>(
      'ansibleLens/getMetadataStatus',
    );
    collectionsCount = status.collectionsCount;
  } catch (error) {
    logger.warn('Could not query initial metadata status', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  evaluateEditorActivation(vscode.window.activeTextEditor, statusBarItem, collectionsCount, logger);
  logger.info('Ansible Lens extension activated', { collectionsCount });
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
