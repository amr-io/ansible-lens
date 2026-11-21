import assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';
import { EXTENSION_ID } from '../../src/extension.js';

const POLL_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 100;

async function waitUntil<T>(
  label: string,
  fn: () => Promise<T | undefined>,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val !== undefined) {
      return val;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function openInEditor(filePath: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  return vscode.window.showTextDocument(doc, { preview: false });
}

function findLineAndColumn(doc: vscode.TextDocument, needle: string): vscode.Position {
  const lines = doc.getText().split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const idx = line.indexOf(needle);
    if (idx !== -1) {
      return new vscode.Position(i, idx + Math.min(3, needle.length - 1));
    }
  }
  throw new Error(`Needle not found in ${doc.uri.fsPath}: ${needle}`);
}

function labelsOf(list: vscode.CompletionList | undefined): string[] {
  if (!list) {
    return [];
  }
  return list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
}

function extractReplacementRange(
  item: vscode.CompletionItem | undefined,
): vscode.Range | undefined {
  if (!item?.range) {
    return undefined;
  }
  return item.range instanceof vscode.Range ? item.range : item.range.replacing;
}

/**
 * Replaces the entire text of `editor.document` temporarily, runs `fn`, and reverts.
 */
async function withTemporaryContent<T>(
  editor: vscode.TextEditor,
  newText: string,
  fn: (doc: vscode.TextDocument) => Promise<T>,
): Promise<T> {
  const doc = editor.document;
  const original = doc.getText();
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(original.length));
  await editor.edit((eb) => eb.replace(fullRange, newText));
  try {
    return await fn(doc);
  } finally {
    const revertRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    await editor.edit((eb) => eb.replace(revertRange, original));
  }
}

function containsAnsibleDocsUrl(markdown: string): boolean {
  const open = markdown.indexOf('](');
  if (open === -1) {
    return false;
  }
  const close = markdown.indexOf(')', open + 2);
  if (close === -1) {
    return false;
  }
  try {
    return new URL(markdown.slice(open + 2, close)).hostname === 'docs.ansible.com';
  } catch (error) {
    if (error instanceof TypeError) {
      return false;
    }
    throw error;
  }
}

async function verifyFlatFixture(workspaceRoot: string): Promise<void> {
  const sitePath = path.join(workspaceRoot, 'site.yml');
  const editor = await openInEditor(sitePath);
  const doc = editor.document;

  // Wait for LSP server readiness via a Hover request on `ansible.builtin.stat`.
  const statPos = findLineAndColumn(doc, 'ansible.builtin.stat');
  const hovers = await waitUntil('hover on ansible.builtin.stat', async () => {
    const res = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      doc.uri,
      statPos,
    );
    return res && res.length > 0 ? res : undefined;
  });
  const hoverMd = hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : c.value))
    .join('\n');
  assert.ok(containsAnsibleDocsUrl(hoverMd), 'Hover must link to docs.ansible.com');

  // Zero permanent underlines by default.
  const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
    'vscode.executeLinkProvider',
    doc.uri,
  );
  assert.equal(links?.length ?? 0, 0, 'DocumentLinkProvider must return 0 links by default');

  // Ctrl+Click on module name returns an ansible-lens-docs: virtual document with docs.ansible.com.
  const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider',
    doc.uri,
    statPos,
  );
  assert.equal(defs?.length, 1);
  const firstDef = defs?.[0];
  const targetUri =
    firstDef && 'targetUri' in firstDef ? firstDef.targetUri : (firstDef as vscode.Location).uri;
  assert.equal(targetUri.scheme, 'ansible-lens-docs');
  const docsDoc = await vscode.workspace.openTextDocument(targetUri);
  assert.ok(containsAnsibleDocsUrl(docsDoc.lineAt(0).text ?? ''));

  // CodeAction quick-fix converts short module name `copy:` to `ansible.builtin.copy`.
  const siteEditor = await vscode.window.showTextDocument(doc, { preview: false });
  const withShortCopy = doc.getText().replace('ansible.builtin.copy:', 'copy:');
  await withTemporaryContent(siteEditor, withShortCopy, async (editedDoc) => {
    const copyPos = findLineAndColumn(editedDoc, 'copy:');
    const actions = await waitUntil('fqcn quick-fix on copy:', async () => {
      const res = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        editedDoc.uri,
        new vscode.Range(copyPos, new vscode.Position(copyPos.line, copyPos.character + 4)),
      );
      return res?.some((a) => a.title.includes('ansible.builtin.copy')) ? res : undefined;
    });
    assert.ok(actions.some((a) => a.title === 'Convert File to FQCN'));
  });
}

async function verifyNestedMonorepoFixture(workspaceRoot: string): Promise<void> {
  const sitePath = path.join(workspaceRoot, 'ansible/playbooks/site.yml');
  const roleTasksPath = path.join(workspaceRoot, 'ansible/roles/webapp/tasks/main.yml');
  const ghaPath = path.join(workspaceRoot, '.github/workflows/ci.yml');

  const roleEditor = await openInEditor(roleTasksPath);
  const roleDoc = roleEditor.document;

  // Wait for LSP server readiness on the nested workspace.
  const statPos = findLineAndColumn(roleDoc, 'ansible.builtin.stat');
  await waitUntil('hover in nested monorepo', async () => {
    const res = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      roleDoc.uri,
      statPos,
    );
    return res && res.length > 0 ? res : undefined;
  });

  // 1. Zero Permanent Underlines + Ctrl+Click module docs + Ctrl+Click registered var.
  const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
    'vscode.executeLinkProvider',
    roleDoc.uri,
  );
  assert.equal(links?.length ?? 0, 0);

  const moduleDefs = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeDefinitionProvider',
    roleDoc.uri,
    statPos,
  );
  assert.equal(moduleDefs?.[0]?.uri.scheme, 'ansible-lens-docs');
  const renderedDocs = await vscode.workspace.openTextDocument(moduleDefs![0]!.uri);
  assert.ok(containsAnsibleDocsUrl(renderedDocs.getText()));

  const regRefPos = findLineAndColumn(roleDoc, '- not webapp_version_file.stat.isdir');
  const regRefCol = roleDoc.lineAt(regRefPos.line).text.indexOf('webapp_version_file') + 4;
  const regDefs = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeDefinitionProvider',
    roleDoc.uri,
    new vscode.Position(regRefPos.line, regRefCol),
  );
  const registerDeclPos = findLineAndColumn(roleDoc, 'register: webapp_version_file');
  assert.equal(regDefs?.[0]?.uri.fsPath, roleDoc.uri.fsPath);
  assert.equal(regDefs?.[0]?.range.start.line, registerDeclPos.line);

  // 2. Completions on `when: webapp_version_file.`, `when:\n  - webapp_version_file.stat.`,
  //    and `webapp_version_file.stat.e` with valid replacing ranges.
  const baseText = roleDoc.getText().trimEnd();
  for (const scenario of [
    {
      name: 'single-line trailing dot',
      tail: ['  when: webapp_version_file.'],
      expected: 'stat',
      prefixLen: 0,
    },
    {
      name: 'multi-line when list trailing dot on stat.',
      tail: ['  when:', '    - webapp_version_file.stat.'],
      expected: 'exists',
      prefixLen: 0,
    },
    {
      name: 'nested partial prefix stat.e in multi-line when list',
      tail: ['  when:', '    - webapp_version_file.stat.e'],
      expected: 'exists',
      prefixLen: 1,
    },
  ]) {
    const edited = [
      baseText,
      '',
      '- name: Completion probe',
      '  ansible.builtin.debug:',
      '    msg: ok',
      ...scenario.tail,
    ].join('\n');
    await withTemporaryContent(roleEditor, edited, async (editedDoc) => {
      const lastLineIdx = editedDoc.lineCount - 1;
      const lastLine = editedDoc.lineAt(lastLineIdx).text;
      const cursor = new vscode.Position(lastLineIdx, lastLine.length);
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        editedDoc.uri,
        cursor,
      );
      const labels = labelsOf(list);
      assert.ok(
        labels.includes(scenario.expected),
        `${scenario.name}: expected '${scenario.expected}' in [${labels.join(', ')}]`,
      );
      const item = list?.items.find(
        (i) => (typeof i.label === 'string' ? i.label : i.label.label) === scenario.expected,
      );
      const range = extractReplacementRange(item);
      assert.ok(
        range,
        `${scenario.name}: completion item must carry an explicit replacement range`,
      );
      assert.equal(range.start.character, cursor.character - scenario.prefixLen);
      assert.equal(range.end.character, cursor.character);
    });
  }

  // 3. Zero false-positive or duplicate missing-role errors in the nested monorepo,
  //    and zero diagnostics on .github/workflows/ci.yml.
  assert.deepEqual(vscode.languages.getDiagnostics(roleDoc.uri), []);

  const diagCode = (d: vscode.Diagnostic): string =>
    typeof d.code === 'object' && d.code !== null ? String(d.code.value) : String(d.code ?? '');

  // 4. notify: LocationLink originSelectionRange (full multi-word phrase) & non-clickability of `- name:` and `# comments`.
  const notifyItemPos = findLineAndColumn(roleDoc, '- Restart webapp service');
  const notifyItemText = roleDoc.lineAt(notifyItemPos.line).text;
  const handlerPhraseStart = notifyItemText.indexOf('Restart webapp service');
  const handlerPhraseEnd = handlerPhraseStart + 'Restart webapp service'.length;
  const notifyDefs = await vscode.commands.executeCommand<
    (vscode.Location | vscode.LocationLink)[]
  >(
    'vscode.executeDefinitionProvider',
    roleDoc.uri,
    new vscode.Position(notifyItemPos.line, handlerPhraseStart + 10),
  );
  assert.equal(notifyDefs?.length, 1);
  const notifyLink = notifyDefs?.[0] as vscode.LocationLink;
  assert.ok(notifyLink && 'originSelectionRange' in notifyLink && notifyLink.originSelectionRange);
  assert.equal(notifyLink.originSelectionRange.start.character, handlerPhraseStart);
  assert.equal(notifyLink.originSelectionRange.end.character, handlerPhraseEnd);
  assert.ok(
    notifyLink.targetUri.fsPath.replaceAll('\\', '/').endsWith('/roles/webapp/handlers/main.yml'),
    `Expected same-role handler jump to roles/webapp/handlers/main.yml, got ${notifyLink.targetUri.fsPath}`,
  );

  const taskNamePos = findLineAndColumn(roleDoc, '- name: Check Webapp version file');
  const nameDefs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider',
    roleDoc.uri,
    new vscode.Position(taskNamePos.line, 12),
  );
  assert.equal(nameDefs?.length ?? 0, 0, '- name: line must never resolve to a notify handler');

  const commentPos = findLineAndColumn(
    roleDoc,
    '# Restart webapp service comment should never be clickable',
  );
  const commentDefs = await vscode.commands.executeCommand<
    (vscode.Location | vscode.LocationLink)[]
  >(
    'vscode.executeDefinitionProvider',
    roleDoc.uri,
    new vscode.Position(commentPos.line, commentPos.character + 6),
  );
  assert.equal(
    commentDefs?.length ?? 0,
    0,
    '# comment line must never resolve to a notify handler',
  );

  // 4b. `{% raw %}...{% endraw %}` produces 0 diagnostics (e.g. Docker Go-template format strings).
  const withRawBlock = [
    baseText,
    '',
    '- name: Inspect container image with raw Go template',
    '  ansible.builtin.command:',
    "    cmd: \"docker inspect --format '{% raw %}{{.Config.Image}}{% endraw %}' {{ webapp_http_port }}\"",
    '  changed_when: false',
  ].join('\n');
  await withTemporaryContent(roleEditor, withRawBlock, async (editedDoc) => {
    await new Promise((r) => setTimeout(r, 350));
    const diags = vscode.languages.getDiagnostics(editedDoc.uri);
    assert.deepEqual(
      diags,
      [],
      `Expected 0 diagnostics for {% raw %}{{.Config.Image}}{% endraw %}, got: ${diags.map((d) => `${diagCode(d)}: ${d.message}`).join('; ')}`,
    );
  });

  // 5. `undefined-variable` + Levenshtein 1-click Quick-Fix ("Did you mean 'webapp_ufw_allowed_ports'?").
  const withTypoVar = [
    baseText,
    '',
    '- name: Typo variable task',
    '  ansible.builtin.debug:',
    '    msg: "Port {{ item }}"',
    '  loop: "{{ webapp_ufw_allowed_por }}"',
  ].join('\n');
  await withTemporaryContent(roleEditor, withTypoVar, async (editedDoc) => {
    const undefDiag = await waitUntil('undefined-variable diagnostic', async () => {
      return vscode.languages
        .getDiagnostics(editedDoc.uri)
        .find((d) => diagCode(d) === 'undefined-variable');
    });
    assert.ok(undefDiag.message.includes("Did you mean 'webapp_ufw_allowed_ports'?"));
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      editedDoc.uri,
      undefDiag.range,
    );
    assert.ok(
      actions?.some((a) => a.title.includes("Did you mean 'webapp_ufw_allowed_ports'?")),
      'Expected Levenshtein Quick-Fix for undefined-variable',
    );
  });

  // 6. `var-naming[no-role-prefix]` in `roles/webapp/defaults/main.yml` + 1-click Quick-Fix,
  //    plus live settings update (`ansibleLens.lint.rules` override to `"off"`).
  const defaultsPath = path.join(workspaceRoot, 'ansible/roles/webapp/defaults/main.yml');
  const handlersPath = path.join(workspaceRoot, 'ansible/roles/webapp/handlers/main.yml');
  const defaultsEditor = await openInEditor(defaultsPath);
  const defaultsBase = defaultsEditor.document.getText().trimEnd();
  const withUnprefixedVar = `${defaultsBase}\nlisten_port: 9000\n`;
  await withTemporaryContent(defaultsEditor, withUnprefixedVar, async (editedDefaults) => {
    const prefixDiag = await waitUntil('var-naming[no-role-prefix] diagnostic', async () => {
      return vscode.languages
        .getDiagnostics(editedDefaults.uri)
        .find((d) => diagCode(d) === 'var-naming[no-role-prefix]');
    });
    assert.ok(prefixDiag.message.includes('webapp_listen_port'));
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      editedDefaults.uri,
      prefixDiag.range,
    );
    assert.ok(actions?.some((a) => a.title.includes("Rename to 'webapp_listen_port'")));

    // Live settings update: disable `var-naming[no-role-prefix]` via workspace configuration
    const cfg = vscode.workspace.getConfiguration('ansibleLens');
    await cfg.update(
      'lint.rules',
      { 'var-naming[no-role-prefix]': 'off' },
      vscode.ConfigurationTarget.Global,
    );
    try {
      await waitUntil('var-naming[no-role-prefix] cleared after live setting update', async () => {
        const remaining = vscode.languages
          .getDiagnostics(editedDefaults.uri)
          .filter((d) => diagCode(d) === 'var-naming[no-role-prefix]');
        return remaining.length === 0 ? true : undefined;
      });
    } finally {
      await cfg.update('lint.rules', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  // 6b. Open & close `defaults/main.yml` and `handlers/main.yml` tabs, then verify cross-file
  //     variable resolution and `notify:` jump STILL work from the disk-backed index.
  await openInEditor(handlersPath);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await openInEditor(defaultsPath);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await new Promise((r) => setTimeout(r, 300));

  const closedTabNotifyDefs = await vscode.commands.executeCommand<
    (vscode.Location | vscode.LocationLink)[]
  >(
    'vscode.executeDefinitionProvider',
    roleDoc.uri,
    new vscode.Position(notifyItemPos.line, handlerPhraseStart + 10),
  );
  assert.equal(
    closedTabNotifyDefs?.length,
    1,
    'notify: jump must still resolve after closing handlers/main.yml tab',
  );

  // 7. `.j2` template completions inheriting `../../versions.yml` (`webapp_release_tag`) and role defaults,
  //    scoped sortText ranking (role-local < shared < other role < magic),
  //    plus Smart `{{ | }}` Auto-Space on Space and Backspace.
  const templatePath = path.join(workspaceRoot, 'ansible/roles/webapp/templates/webapp.rc.j2');
  const templateEditor = await openInEditor(templatePath);
  const templateBase = templateEditor.document.getText().trimEnd();
  assert.deepEqual(
    vscode.languages.getDiagnostics(templateEditor.document.uri),
    [],
    'Open .j2 template must have 0 diagnostics even after defaults/main.yml tab was closed',
  );

  const templateProbe = `${templateBase}\nTAG="{{ `;
  await withTemporaryContent(templateEditor, templateProbe, async (editedTemplate) => {
    const lastIdx = editedTemplate.lineCount - 1;
    const cursor = new vscode.Position(lastIdx, editedTemplate.lineAt(lastIdx).text.length);
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      editedTemplate.uri,
      cursor,
    );
    const items = list?.items ?? [];
    const byLabel = new Map(
      items.map((item) => [
        typeof item.label === 'string' ? item.label : item.label.label,
        item,
      ]),
    );
    assert.ok(byLabel.has('webapp_release_tag'), 'Expected webapp_release_tag from ../../versions.yml');
    assert.ok(byLabel.has('webapp_http_port'), 'Expected role-local webapp_http_port');
    assert.ok(byLabel.has('common_timezone'), 'Expected other-role common_timezone');
    assert.ok(byLabel.has('inventory_hostname'), 'Expected magic var inventory_hostname');

    const sortOf = (name: string): string => byLabel.get(name)?.sortText ?? name;
    assert.ok(
      sortOf('webapp_http_port') < sortOf('webapp_release_tag'),
      `Role-local var should sort before vars_files: ${sortOf('webapp_http_port')} vs ${sortOf('webapp_release_tag')}`,
    );
    assert.ok(
      sortOf('webapp_release_tag') < sortOf('common_timezone'),
      `vars_files should sort before other role vars: ${sortOf('webapp_release_tag')} vs ${sortOf('common_timezone')}`,
    );
    assert.ok(
      sortOf('common_timezone') < sortOf('inventory_hostname'),
      `Other role vars should sort before magic vars: ${sortOf('common_timezone')} vs ${sortOf('inventory_hostname')}`,
    );
  });

  // 7b. Live cross-file revalidation: renaming a variable in `versions.yml` immediately updates
  //     diagnostics in the already-open `.j2` template without editing the template.
  const versionsPath = path.join(workspaceRoot, 'versions.yml');
  const versionsEditor = await openInEditor(versionsPath);
  const versionsBase = versionsEditor.document.getText();
  const renamedVersions = versionsBase.replace('webapp_release_tag', 'webapp_release_version');
  await withTemporaryContent(versionsEditor, renamedVersions, async () => {
    const templateUndef = await waitUntil(
      'live undefined-variable diagnostic on open .j2 template after renaming versions.yml var',
      async () => {
        return vscode.languages
          .getDiagnostics(templateEditor.document.uri)
          .find((d) => diagCode(d) === 'undefined-variable' && d.message.includes('webapp_release_tag'));
      },
    );
    assert.ok(templateUndef);
  });
  await waitUntil('open .j2 template diagnostics clear after restoring versions.yml', async () => {
    return vscode.languages.getDiagnostics(templateEditor.document.uri).length === 0 ? true : undefined;
  });

  // Smart `{{ | }}` Auto-Space in `.j2` template: insert `' '` inside `{{}}` -> expands to `{{  }}` with cursor centered.
  const activeTemplateEditor = await openInEditor(templatePath);
  const autoSpaceInit = `${templateBase}\nAUTO={{}}`;
  await withTemporaryContent(activeTemplateEditor, autoSpaceInit, async (editedTemplate) => {
    const lastIdx = editedTemplate.lineCount - 1;
    const braceCenter = new vscode.Position(lastIdx, 'AUTO={{'.length);
    await activeTemplateEditor.edit((eb) => eb.insert(braceCenter, ' '));
    await waitUntil('auto-space expansion to {{  }}', async () => {
      return editedTemplate.lineAt(lastIdx).text === 'AUTO={{  }}' ? true : undefined;
    });
    assert.equal(activeTemplateEditor.selection.active.character, 'AUTO={{ '.length);

    // Simulate Backspace deleting the leading space inside `{{ | }}` -> collapses both spaces back to `{{}}`.
    const deleteRange = new vscode.Range(
      new vscode.Position(lastIdx, 'AUTO={{'.length),
      new vscode.Position(lastIdx, 'AUTO={{ '.length),
    );
    await activeTemplateEditor.edit((eb) => eb.delete(deleteRange));
    await waitUntil('auto-space collapse to {{}} on Backspace', async () => {
      return editedTemplate.lineAt(lastIdx).text === 'AUTO={{}}' ? true : undefined;
    });
  });

  // 8. `Ansible Lens: Copy Diagnostics Info` command returns structured report.
  const diagReport = await vscode.commands.executeCommand<string>(
    'ansibleLens.copyDiagnosticsInfo',
  );
  assert.ok(diagReport?.includes('Ansible Lens Diagnostics Info'));
  assert.ok(diagReport?.includes('ansible.builtin'));

  const siteEditor = await openInEditor(sitePath);
  await new Promise((r) => setTimeout(r, 400));
  const siteDiags = vscode.languages.getDiagnostics(siteEditor.document.uri);
  assert.deepEqual(
    siteDiags.filter((d) => diagCode(d) === 'missing-role'),
    [],
    'Expected 0 missing-role diagnostics when roles exist under ansible/roles',
  );

  // 8b. Typo in `vars_files: ../../version.yml` emits `missing-vars-file` AND evicts old variables
  //     from the open `.j2` template immediately.
  const brokenVarsFilesSite = siteEditor.document
    .getText()
    .replace('../../versions.yml', '../../version.yml');
  await withTemporaryContent(siteEditor, brokenVarsFilesSite, async (editedSite) => {
    const missingVarsDiag = await waitUntil('missing-vars-file diagnostic on site.yml', async () => {
      return vscode.languages
        .getDiagnostics(editedSite.uri)
        .find((d) => diagCode(d) === 'missing-vars-file');
    });
    assert.ok(missingVarsDiag.message.includes('../../version.yml'));

    const evictedTemplateDiag = await waitUntil(
      'evicted webapp_release_tag triggers undefined-variable in open .j2 template',
      async () => {
        return vscode.languages
          .getDiagnostics(templateEditor.document.uri)
          .find((d) => diagCode(d) === 'undefined-variable' && d.message.includes('webapp_release_tag'));
      },
    );
    assert.ok(evictedTemplateDiag);
  });

  // Add a genuinely missing role and verify exactly 1 missing-role diagnostic fires.
  const withMissingRole = `${siteEditor.document.getText().trimEnd()}\n    - truly_missing_role\n`;
  await withTemporaryContent(siteEditor, withMissingRole, async (editedSite) => {
    const missingDiags = await waitUntil('single missing-role diagnostic', async () => {
      const diags = vscode.languages
        .getDiagnostics(editedSite.uri)
        .filter((d) => diagCode(d) === 'missing-role');
      return diags.length > 0 ? diags : undefined;
    });
    assert.equal(missingDiags.length, 1, 'missing-role diagnostic must never be duplicated');
  });

  const ghaEditor = await openInEditor(ghaPath);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(
    vscode.languages.getDiagnostics(ghaEditor.document.uri),
    [],
    'GitHub Actions workflow must have 0 Ansible diagnostics',
  );
}

/** Entrypoint invoked by `@vscode/test-electron` inside the Extension Host. */
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `Extension ${EXTENSION_ID} must be installed in test host`);
  if (!ext.isActive) {
    await ext.activate();
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspaceRoot, 'Workspace root must be opened');

  if (path.basename(workspaceRoot) === 'nested-monorepo-project') {
    await verifyNestedMonorepoFixture(workspaceRoot);
  } else {
    await verifyFlatFixture(workspaceRoot);
  }
}
