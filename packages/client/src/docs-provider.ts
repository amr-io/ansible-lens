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

async function closeDocsVirtualTab(docUri: vscode.Uri): Promise<void> {
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
  await closeDocsVirtualTab(docUri);
}

/**
 * When `ansibleLens.docs.ctrlClickBehavior` is set to `openInBrowser`, close the temporary
 * virtual docs editor first and then open the module's official `docs.ansible.com` URL
 * in the user's browser.
 */
export async function openModuleDocsInBrowser(
  editor: vscode.TextEditor | undefined,
): Promise<void> {
  if (!editor || editor.document.uri.scheme !== MODULE_DOCS_SCHEME) {
    return;
  }
  const docUri = editor.document.uri;
  const moduleName = parseModuleNameFromDocsPath(docUri.path);
  const { buildOfflineDocUrl } = await import('./docs-uri.js');
  const url = vscode.Uri.parse(buildOfflineDocUrl(moduleName));
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  void vscode.env.openExternal(url);
}
