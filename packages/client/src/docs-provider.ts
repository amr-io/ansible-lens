import * as vscode from 'vscode';

import {
  formatOfflineDocsMarkdown,
  parseModuleNameFromDocsPath,
  MODULE_DOCS_SCHEME,
} from './docs-uri.js';

export {
  GET_MODULE_DOCS_REQUEST,
  MODULE_DOCS_SCHEME,
  buildOfflineDocUrl,
  formatOfflineDocsMarkdown,
  parseModuleNameFromDocsPath,
} from './docs-uri.js';

export interface ModuleDocsRequester {
  requestMarkdown(moduleName: string): Promise<string | undefined>;
}

/**
 * Read-only `TextDocumentContentProvider` backing Python/Pylance-style Ctrl+Click on
 * module names: the server's definition provider returns an `ansible-lens-docs:` URI and
 * this provider renders the module's full documentation as Markdown.
 */
export class ModuleDocsContentProvider implements vscode.TextDocumentContentProvider {
  public constructor(private readonly requester: ModuleDocsRequester) {}

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const moduleName = parseModuleNameFromDocsPath(uri.path);
    const markdown = await this.requester.requestMarkdown(moduleName);
    return markdown ?? formatOfflineDocsMarkdown(moduleName);
  }
}

/**
 * When a docs virtual document becomes the active editor, swap the raw Markdown tab
 * for VS Code's rendered Markdown preview.
 */
export async function showRenderedDocsPreview(
  editor: vscode.TextEditor | undefined,
): Promise<void> {
  if (!editor || editor.document.uri.scheme !== MODULE_DOCS_SCHEME) {
    return;
  }
  const docUri = editor.document.uri;
  await vscode.commands.executeCommand('markdown.showPreview', docUri);
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.toString() === docUri.toString()
      ) {
        await vscode.window.tabGroups.close(tab, true);
      }
    }
  }
}
