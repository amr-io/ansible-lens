import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node.js';
import { shouldActivateForDocument, workspaceHasAnsibleCfg } from './activation.js';
import { createClientLogger, type ClientLogger } from './logger.js';

export const EXTENSION_ID = 'amr-vibe.ansible-lens';
export const OFFICIAL_DOCS_URL =
  'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/index.html';

export const COMMAND_OPEN_OFFICIAL_DOCS = 'ansibleLens.openOfficialDocs';
export const COMMAND_REFRESH_METADATA = 'ansibleLens.refreshMetadata';
export const COMMAND_CONVERT_FILE_TO_FQCN = 'ansibleLens.convertFileToFqcn';

let client: LanguageClient | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export function getExtensionId(): string {
  return EXTENSION_ID;
}

/**
 * Formats the status bar text displaying Ansible Lens active state and
 * loaded collection count.
 */
export function formatStatusBarText(active: boolean, collectionsCount: number): string {
  if (!active) {
    return '$(eye) Ansible Lens: Standby';
  }
  const suffix = collectionsCount === 1 ? 'collection' : 'collections';
  return `$(eye) Ansible Lens (${collectionsCount} ${suffix})`;
}

function updateStatusBar(
  item: vscode.StatusBarItem,
  active: boolean,
  collectionsCount: number,
  reason?: string,
): void {
  item.text = formatStatusBarText(active, collectionsCount);
  item.tooltip = active
    ? `Ansible Lens active (${collectionsCount} loaded collection(s))${reason ? ` — ${reason}` : ''}`
    : 'Ansible Lens standing by (no active Ansible document)';
  item.command = COMMAND_OPEN_OFFICIAL_DOCS;
  item.show();
}

function isWorkspaceAnsibleEnabled(): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return workspaceHasAnsibleCfg(
    folders.map((f) => f.uri.fsPath),
    (filePath) => fs.existsSync(filePath),
  );
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
  const hasCfg = isWorkspaceAnsibleEnabled();
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
      { scheme: 'untitled', language: 'yaml' },
      { scheme: 'untitled', language: 'ansible' },
    ],
    outputChannel,
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{yml,yaml,ini,cfg}'),
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

  await client.start();
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
