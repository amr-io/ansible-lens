import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createConnection,
  createProtocolConnection,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  CompletionRequest,
  HoverRequest,
  DefinitionRequest,
  ReferencesRequest,
  CodeActionRequest,
  PublishDiagnosticsNotification,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-languageserver/node.js';
import {
  AnsibleLanguageService,
  NodeWorkspaceFs,
  bindLanguageServer,
  createServerContext,
  fsPathToUri,
} from '../src/index.js';

const FIXTURE_ROOT = path.resolve(
  import.meta.dirname,
  '../../../test/fixtures/sample-ansible-project',
);

function findLineAndChar(
  text: string,
  needle: string,
  occurrence = 0,
): { line: number; character: number } {
  let fromIndex = 0;
  let found = -1;
  for (let i = 0; i <= occurrence; i++) {
    found = text.indexOf(needle, fromIndex);
    if (found < 0) {
      throw new Error(`Could not find "${needle}" in fixture text`);
    }
    fromIndex = found + needle.length;
  }
  const before = text.slice(0, found);
  const lines = before.split(/\r?\n/);
  return {
    line: lines.length - 1,
    character: (lines[lines.length - 1] ?? '').length,
  };
}

describe('Ansible Lens Language Server — End-to-End LSP Integration', () => {
  it('initializes server context with fallback catalog', () => {
    const ctx = createServerContext();
    expect(ctx.initialized).toBe(true);
  });

  it('exercises full LSP protocol over connected streams against sample-ansible-project', async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();

    const serverConn = createConnection(
      new StreamMessageReader(clientToServer),
      new StreamMessageWriter(serverToClient),
    );
    const service = new AnsibleLanguageService({
      fs: new NodeWorkspaceFs(),
    });
    bindLanguageServer(serverConn, service);
    serverConn.listen();

    const clientConn = createProtocolConnection(
      new StreamMessageReader(serverToClient),
      new StreamMessageWriter(clientToServer),
    );

    const publishedDiagnostics = new Map<string, unknown[]>();
    clientConn.onNotification(PublishDiagnosticsNotification.type, (params) => {
      publishedDiagnostics.set(params.uri, params.diagnostics);
    });
    clientConn.listen();

    const rootUri = pathToFileURL(FIXTURE_ROOT).toString();
    const initResult = await clientConn.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri,
      capabilities: {},
      workspaceFolders: [{ uri: rootUri, name: 'sample-ansible-project' }],
    });
    expect(initResult.capabilities.hoverProvider).toBe(true);
    expect(initResult.capabilities.completionProvider).toBeDefined();
    expect(initResult.capabilities.definitionProvider).toBe(true);
    expect(initResult.capabilities.referencesProvider).toBe(true);
    expect(initResult.capabilities.documentLinkProvider).toBeUndefined();
    expect(initResult.capabilities.codeActionProvider).toBeDefined();

    await clientConn.sendNotification(InitializedNotification.type, {});

    const sitePath = path.join(FIXTURE_ROOT, 'site.yml');
    const siteUri = fsPathToUri(sitePath);
    const siteText = fs.readFileSync(sitePath, 'utf8');

    await clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: siteUri,
        languageId: 'yaml',
        version: 1,
        text: siteText,
      },
    });

    // 1. Hover on module (`ansible.builtin.stat`)
    const statPos = findLineAndChar(siteText, 'ansible.builtin.stat');
    const modHover = await clientConn.sendRequest(HoverRequest.type, {
      textDocument: { uri: siteUri },
      position: { line: statPos.line, character: statPos.character + 4 },
    });
    expect(modHover).not.toBeNull();
    const modHoverVal =
      typeof modHover?.contents === 'object' && 'value' in modHover.contents
        ? modHover.contents.value
        : '';
    expect(modHoverVal).toContain('ansible.builtin.stat');
    expect(modHoverVal).toContain('[Open Official Docs](https://docs.ansible.com');
    expect(modHoverVal.split('\n')[0]).toContain('[Open Official Docs]');
    expect(modHoverVal).toContain('Parameters');

    // 2. Hover on parameter (`update_cache` or `path`)
    const pathParamPos = findLineAndChar(siteText, 'path: /etc/nginx/nginx.conf');
    const paramHover = await clientConn.sendRequest(HoverRequest.type, {
      textDocument: { uri: siteUri },
      position: { line: pathParamPos.line, character: pathParamPos.character + 1 },
    });
    const paramHoverVal =
      typeof paramHover?.contents === 'object' && 'value' in paramHover.contents
        ? paramHover.contents.value
        : '';
    expect(paramHoverVal).toContain('Parameter `path`');
    expect(paramHoverVal.split('\n')[0]).toContain('#parameter-path');

    // 3. Hover on registered return field (`nginx_stat.stat`)
    const regFieldPos = findLineAndChar(siteText, 'nginx_stat.stat');
    const regHover = await clientConn.sendRequest(HoverRequest.type, {
      textDocument: { uri: siteUri },
      position: {
        line: regFieldPos.line,
        character: regFieldPos.character + 'nginx_stat.'.length + 1,
      },
    });
    const regHoverVal =
      typeof regHover?.contents === 'object' && 'value' in regHover.contents
        ? regHover.contents.value
        : '';
    expect(regHoverVal).toContain('nginx_stat.stat');
    expect(regHoverVal.split('\n')[0]).toContain('#return-stat');

    // 4. Hover on workspace variable showing 22-level precedence breakdown (`http_port`)
    const templatePath = path.join(FIXTURE_ROOT, 'roles/webserver/tasks/main.yml');
    const tasksUri = fsPathToUri(templatePath);
    const tasksText = fs.readFileSync(templatePath, 'utf8');
    await clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: tasksUri,
        languageId: 'yaml',
        version: 1,
        text: tasksText,
      },
    });
    const varHover = service.getHover(
      siteUri,
      findLineAndChar(siteText, 'http_port: 8443'),
      siteText,
    );
    const varHoverVal =
      varHover && typeof varHover.contents === 'object' && 'value' in varHover.contents
        ? varHover.contents.value
        : '';
    expect(varHoverVal).toContain('Precedence Rank');
    expect(varHoverVal).toContain('12 / 22');
    expect(varHoverVal).toContain('Shadowed Definitions');

    // 4b. CompletionRequest over LSP protocol
    const protocolCompletions = await clientConn.sendRequest(CompletionRequest.type, {
      textDocument: { uri: siteUri },
      position: { line: statPos.line, character: statPos.character },
    });
    const compItems = Array.isArray(protocolCompletions)
      ? protocolCompletions
      : (protocolCompletions?.items ?? []);
    expect(compItems.some((c) => c.label === 'ansible.builtin.stat')).toBe(true);

    // 5. Module Ctrl+Click (`docsCtrlClickBehavior`) resolves to `ansible-lens-docs:` by default and disables cleanly
    const moduleDefs = await clientConn.sendRequest(DefinitionRequest.type, {
      textDocument: { uri: siteUri },
      position: { line: statPos.line, character: statPos.character + 5 },
    });
    expect(Array.isArray(moduleDefs) && moduleDefs.length === 1).toBe(true);

    await clientConn.sendRequest('ansibleLens/updateSettings', {
      docsCtrlClickBehavior: 'disabled',
    });
    const disabledDefs = await clientConn.sendRequest(DefinitionRequest.type, {
      textDocument: { uri: siteUri },
      position: { line: statPos.line, character: statPos.character + 5 },
    });
    expect(disabledDefs).toEqual([]);
    await clientConn.sendRequest('ansibleLens/updateSettings', {
      docsCtrlClickBehavior: 'renderedPreview',
    });

    // 6. Definition for roles, handlers, template src, and variables
    const rolePos = findLineAndChar(siteText, '- webserver');
    const roleDefs = await clientConn.sendRequest(DefinitionRequest.type, {
      textDocument: { uri: siteUri },
      position: { line: rolePos.line, character: rolePos.character + 3 },
    });
    expect(Array.isArray(roleDefs) && roleDefs.length > 0).toBe(true);
    expect(JSON.stringify(roleDefs)).toContain('roles/webserver/tasks/main.yml');

    const notifyPos = findLineAndChar(siteText, 'Reload nginx');
    const handlerDefs = await clientConn.sendRequest(DefinitionRequest.type, {
      textDocument: { uri: siteUri },
      position: { line: notifyPos.line, character: notifyPos.character + 2 },
    });
    expect(Array.isArray(handlerDefs) && handlerDefs.length > 0).toBe(true);

    const templateSrcPos = findLineAndChar(tasksText, 'nginx.conf.j2');
    const templateDefs = await clientConn.sendRequest(DefinitionRequest.type, {
      textDocument: { uri: tasksUri },
      position: { line: templateSrcPos.line, character: templateSrcPos.character + 2 },
    });
    expect(JSON.stringify(templateDefs)).toContain('roles/webserver/templates/nginx.conf.j2');

    // 7. References across workspace for `nginx_service_name`
    const svcVarPos = findLineAndChar(tasksText, 'nginx_service_name');
    const refs =
      (await clientConn.sendRequest(ReferencesRequest.type, {
        textDocument: { uri: tasksUri },
        position: { line: svcVarPos.line, character: svcVarPos.character + 2 },
        context: { includeDeclaration: true },
      })) ?? [];
    expect(refs.length).toBeGreaterThanOrEqual(4);

    const waitForDiagnostics = async (targetUri: string, timeoutMs = 2000): Promise<unknown[]> => {
      const deadline = Date.now() + timeoutMs;
      while (!publishedDiagnostics.has(targetUri) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
      return publishedDiagnostics.get(targetUri) ?? [];
    };

    // 8. Smart Hybrid non-interference on k8s-deployment.yml
    const k8sPath = path.join(FIXTURE_ROOT, 'k8s-deployment.yml');
    const k8sUri = fsPathToUri(k8sPath);
    const k8sText = fs.readFileSync(k8sPath, 'utf8');
    await clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: k8sUri,
        languageId: 'yaml',
        version: 1,
        text: k8sText,
      },
    });
    expect(await waitForDiagnostics(k8sUri)).toEqual([]);
    expect(service.getCompletions(k8sUri, { line: 0, character: 0 }, k8sText)).toEqual([]);

    // 9. Diagnostics & CodeActions (Quick-Fix + Convert File to FQCN) on short module names
    const shortPlayUri = fsPathToUri(path.join(FIXTURE_ROOT, 'short-playbook.yml'));
    const shortPlayText = [
      '---',
      '- name: Short module playbook',
      '  hosts: webservers',
      '  tasks:',
      '    - name: Copy file using short name',
      '      copy:',
      '        src: roles/webserver/files/index.html',
      '        dest: /tmp/index.html',
      '    - name: Restart service using short name',
      '      service:',
      '        name: nginx',
      '        state: restarted',
    ].join('\n');

    await clientConn.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: shortPlayUri,
        languageId: 'yaml',
        version: 1,
        text: shortPlayText,
      },
    });
    const diags = await waitForDiagnostics(shortPlayUri);
    expect(diags.length).toBeGreaterThanOrEqual(2);

    const copyLinePos = findLineAndChar(shortPlayText, 'copy:');
    const actions =
      (await clientConn.sendRequest(CodeActionRequest.type, {
        textDocument: { uri: shortPlayUri },
        range: {
          start: copyLinePos,
          end: { line: copyLinePos.line, character: copyLinePos.character + 4 },
        },
        context: { diagnostics: [] },
      })) ?? [];
    const titles = actions.map((a) => a.title);
    expect(titles.some((t) => t.includes('ansible.builtin.copy'))).toBe(true);
    expect(titles).toContain('Convert File to FQCN');

    clientConn.dispose();
    serverConn.dispose();
  });

  it('provides rich completions for modules, params, choices, register fields, loop .results, Jinja2 filters/tests, magic vars, ansible_facts, and inventory hosts', () => {
    const service = new AnsibleLanguageService({
      fs: new NodeWorkspaceFs(),
      workspaceRoots: [FIXTURE_ROOT],
    });
    service.indexWorkspace();

    const sitePath = path.join(FIXTURE_ROOT, 'site.yml');
    const siteUri = fsPathToUri(sitePath);
    const siteText = fs.readFileSync(sitePath, 'utf8');
    service.updateDocument(siteUri, siteText);

    // A. Inventory hosts/groups after `hosts:`
    const hostsCompletionDoc = '- name: Test\n  hosts: ';
    const hostsItems = service.getCompletions(
      siteUri,
      { line: 1, character: '  hosts: '.length },
      hostsCompletionDoc,
    );
    const hostLabels = hostsItems.map((i) => i.label);
    expect(hostLabels).toContain('webservers');
    expect(hostLabels).toContain('dbservers');
    expect(hostLabels).toContain('web1');

    // B. Task-level modules (FQCN & short names) + keywords
    const taskDoc = [
      '- name: Test',
      '  hosts: all',
      '  tasks:',
      '    - name: Task 1',
      '      ',
    ].join('\n');
    const taskItems = service.getCompletions(siteUri, { line: 4, character: 6 }, taskDoc);
    const taskLabels = taskItems.map((i) => i.label);
    expect(taskLabels).toContain('ansible.builtin.copy');
    expect(taskLabels).toContain('copy');
    expect(taskLabels).toContain('register');
    expect(taskLabels).toContain('when');

    // C. Module parameters for active task module
    const paramDoc = [
      '- name: Test',
      '  hosts: all',
      '  tasks:',
      '    - name: Install nginx',
      '      ansible.builtin.apt:',
      '        ',
    ].join('\n');
    const paramItems = service.getCompletions(siteUri, { line: 5, character: 8 }, paramDoc);
    const paramLabels = paramItems.map((i) => i.label);
    expect(paramLabels).toContain('update_cache');
    expect(paramLabels).toContain('state');

    // D. Enum choices for `state:` on `ansible.builtin.service`
    const choiceDoc = [
      '- name: Test',
      '  hosts: all',
      '  tasks:',
      '    - name: Service task',
      '      ansible.builtin.service:',
      '        name: nginx',
      '        state: ',
    ].join('\n');
    const choiceItems = service.getCompletions(
      siteUri,
      { line: 6, character: '        state: '.length },
      choiceDoc,
    );
    const choiceLabels = choiceItems.map((i) => i.label);
    expect(choiceLabels).toEqual(
      expect.arrayContaining(['started', 'stopped', 'restarted', 'reloaded']),
    );

    // E. Register return fields & loop `.results`
    const regDoc = [
      siteText,
      '    - name: Use svc_check',
      '      ansible.builtin.debug:',
      '        msg: "{{ svc_check.',
    ].join('\n');
    const regLines = regDoc.split('\n');
    const regItems = service.getCompletions(
      siteUri,
      { line: regLines.length - 1, character: (regLines[regLines.length - 1] ?? '').length },
      regDoc,
    );
    const regLabels = regItems.map((i) => i.label);
    expect(regLabels).toEqual(expect.arrayContaining(['rc', 'stdout', 'stdout_lines', 'changed']));

    const loopRegDoc = [
      siteText,
      '    - name: Use port_checks loop register',
      '      ansible.builtin.debug:',
      '        msg: "{{ port_checks.',
    ].join('\n');
    const loopLines = loopRegDoc.split('\n');
    const loopItems = service.getCompletions(
      siteUri,
      { line: loopLines.length - 1, character: (loopLines[loopLines.length - 1] ?? '').length },
      loopRegDoc,
    );
    expect(loopItems.map((i) => i.label)).toContain('results');

    // F. Jinja2 filters after `|`
    const filterDoc = `${siteText}\n    - name: Filter test\n      ansible.builtin.debug:\n        msg: "{{ http_port | `;
    const filterLines = filterDoc.split('\n');
    const filterItems = service.getCompletions(
      siteUri,
      {
        line: filterLines.length - 1,
        character: (filterLines[filterLines.length - 1] ?? '').length,
      },
      filterDoc,
    );
    expect(filterItems.map((i) => i.label)).toEqual(
      expect.arrayContaining(['default', 'to_json', 'dict2items', 'regex_replace']),
    );

    // G. Jinja2 tests after `is `
    const testDoc = `${siteText}\n    - name: Test expr\n      ansible.builtin.debug:\n        msg: "ok"\n      when: http_port is `;
    const testLines = testDoc.split('\n');
    const testItems = service.getCompletions(
      siteUri,
      { line: testLines.length - 1, character: (testLines[testLines.length - 1] ?? '').length },
      testDoc,
    );
    expect(testItems.map((i) => i.label)).toEqual(
      expect.arrayContaining(['defined', 'undefined', 'truthy', 'succeeded']),
    );

    // H. Cross-file workspace variables & magic variables inside `{{ `
    const varDoc = `${siteText}\n    - name: Var expr\n      ansible.builtin.debug:\n        msg: "{{ `;
    const varLines = varDoc.split('\n');
    const varItems = service.getCompletions(
      siteUri,
      { line: varLines.length - 1, character: (varLines[varLines.length - 1] ?? '').length },
      varDoc,
    );
    const varLabels = varItems.map((i) => i.label);
    expect(varLabels).toEqual(
      expect.arrayContaining([
        'http_port',
        'app_name',
        'inventory_hostname',
        'hostvars',
        'ansible_facts',
      ]),
    );

    // I. ansible_facts fields after `ansible_facts.`
    const factsDoc = `${siteText}\n    - name: Facts expr\n      ansible.builtin.debug:\n        msg: "{{ ansible_facts.`;
    const factsLines = factsDoc.split('\n');
    const factsItems = service.getCompletions(
      siteUri,
      { line: factsLines.length - 1, character: (factsLines[factsLines.length - 1] ?? '').length },
      factsDoc,
    );
    expect(factsItems.map((i) => i.label)).toEqual(
      expect.arrayContaining(['os_family', 'distribution', 'default_ipv4', 'pkg_mgr']),
    );
  });

  it('never hijacks or emits diagnostics on Docker Compose or GitHub Actions YAML', () => {
    const service = new AnsibleLanguageService();

    const composeUri = 'file:///workspace/docker-compose.yml';
    const composeText = [
      'version: "3.9"',
      'services:',
      '  web:',
      '    image: nginx:latest',
      '    ports:',
      '      - "80:80"',
    ].join('\n');

    expect(service.getDiagnostics(composeUri, composeText)).toEqual([]);
    expect(service.getCompletions(composeUri, { line: 2, character: 4 }, composeText)).toEqual([]);

    const ghaUri = 'file:///workspace/.github/workflows/ci.yml';
    const ghaText = [
      'name: CI',
      'on:',
      '  push:',
      '    branches: [main]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
    ].join('\n');

    expect(service.getDiagnostics(ghaUri, ghaText)).toEqual([]);
    expect(service.getHover(ghaUri, { line: 6, character: 6 }, ghaText)).toBeNull();
  });
});
