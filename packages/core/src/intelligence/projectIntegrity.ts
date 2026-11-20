import { parse as parseYaml } from 'yaml';
import type {
  AnsibleDocumentAst,
  IWorkspaceFs,
  LintDiagnostic,
  PlayNode,
  TaskNode,
} from '../contracts/types.js';
import { findClosestMatch } from './similarity.js';

function normalizeSlash(input: string): string {
  return input.replace(/\\/g, '/');
}

function joinFsPath(...parts: string[]): string {
  const cleaned: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = normalizeSlash(parts[i] ?? '');
    if (part.length === 0) {
      continue;
    }
    if (cleaned.length === 0) {
      cleaned.push(part.replace(/\/+$/, ''));
    } else {
      cleaned.push(part.replace(/^\/+|\/+$/g, ''));
    }
  }
  return cleaned.join('/');
}

function uriToFsPath(uri: string): string {
  if (uri.startsWith('file:///')) {
    let stripped = decodeURIComponent(uri.slice('file://'.length));
    if (/^\/[a-zA-Z]:\//.test(stripped)) {
      stripped = stripped.slice(1);
    }
    return normalizeSlash(stripped);
  }
  if (uri.startsWith('file://')) {
    return normalizeSlash(decodeURIComponent(uri.slice('file://'.length)));
  }
  return normalizeSlash(uri);
}

function dirnamePath(filePath: string): string {
  const normalized = normalizeSlash(filePath);
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? normalized : normalized.slice(0, idx);
}

function containsJinja(value: string): boolean {
  return value.includes('{{') || value.includes('{%');
}

function shortModuleName(moduleName: string): string {
  const idx = moduleName.lastIndexOf('.');
  return idx === -1 ? moduleName : moduleName.slice(idx + 1);
}

function isValidRoleName(roleName: string): boolean {
  if (roleName.trim().length === 0) {
    return false;
  }
  if (roleName.includes('..') || roleName.startsWith('/') || roleName.startsWith('\\')) {
    return false;
  }
  return /^[a-zA-Z0-9_.-]+$/.test(roleName);
}

function resolveRoleDir(
  roleName: string,
  workspaceRoot: string,
  playbookDir: string,
  fs: IWorkspaceFs,
): string | undefined {
  const normalizedRoot = normalizeSlash(workspaceRoot);
  const candidates = [
    joinFsPath(playbookDir, 'roles', roleName),
    joinFsPath(normalizedRoot, 'roles', roleName),
    joinFsPath(normalizedRoot, roleName),
  ];

  for (const dir of candidates) {
    if (
      fs.exists(dir) ||
      fs.exists(joinFsPath(dir, 'tasks/main.yml')) ||
      fs.exists(joinFsPath(dir, 'tasks/main.yaml')) ||
      fs.exists(joinFsPath(dir, 'meta/main.yml')) ||
      fs.exists(joinFsPath(dir, 'defaults/main.yml')) ||
      fs.exists(joinFsPath(dir, 'vars/main.yml')) ||
      fs.exists(joinFsPath(dir, 'handlers/main.yml')) ||
      fs.listFiles(dir).length > 0
    ) {
      return dir;
    }
  }

  return undefined;
}

function hasRoleTasksFile(roleDir: string, fs: IWorkspaceFs): boolean {
  return (
    fs.exists(joinFsPath(roleDir, 'tasks/main.yml')) ||
    fs.exists(joinFsPath(roleDir, 'tasks/main.yaml')) ||
    fs.exists(joinFsPath(roleDir, 'tasks'))
  );
}

function collectHandlerNamesFromYaml(content: string): readonly string[] {
  const names: string[] = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    void err;
    return names;
  }

  if (!Array.isArray(parsed)) {
    return names;
  }

  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = record['name'];
    if (typeof name === 'string' && name.trim().length > 0) {
      names.push(name.trim());
    }
    const listen = record['listen'];
    if (typeof listen === 'string' && listen.trim().length > 0) {
      names.push(listen.trim());
    } else if (Array.isArray(listen)) {
      for (const l of listen) {
        if (typeof l === 'string' && l.trim().length > 0) {
          names.push(l.trim());
        }
      }
    }
  }

  return names;
}

function collectTaskHandlerTargets(task: TaskNode, knownHandlers: Set<string>): void {
  if (task.name !== undefined && task.name.trim().length > 0) {
    knownHandlers.add(task.name.trim());
  }
  for (const param of task.params) {
    if (param.name === 'listen') {
      if (typeof param.value === 'string' && param.value.trim().length > 0) {
        knownHandlers.add(param.value.trim());
      } else if (Array.isArray(param.value)) {
        for (const v of param.value) {
          if (typeof v === 'string' && v.trim().length > 0) {
            knownHandlers.add(v.trim());
          }
        }
      }
    }
  }
}

function collectWorkspaceHandlers(
  ast: AnsibleDocumentAst,
  play: PlayNode | undefined,
  workspaceRoot: string,
  playbookDir: string,
  fs: IWorkspaceFs,
): Set<string> {
  const known = new Set<string>();

  for (const h of ast.handlers) {
    collectTaskHandlerTargets(h, known);
  }
  if (play) {
    for (const h of play.handlers) {
      collectTaskHandlerTargets(h, known);
    }
  }

  const candidateFiles = new Set<string>([
    joinFsPath(playbookDir, 'handlers/main.yml'),
    joinFsPath(playbookDir, 'handlers/main.yaml'),
    joinFsPath(dirnamePath(playbookDir), 'handlers/main.yml'),
    joinFsPath(dirnamePath(playbookDir), 'handlers/main.yaml'),
    joinFsPath(workspaceRoot, 'handlers/main.yml'),
    joinFsPath(workspaceRoot, 'handlers/main.yaml'),
  ]);

  if (play) {
    for (const role of play.roles) {
      candidateFiles.add(joinFsPath(playbookDir, 'roles', role.name, 'handlers/main.yml'));
      candidateFiles.add(joinFsPath(playbookDir, 'roles', role.name, 'handlers/main.yaml'));
      candidateFiles.add(joinFsPath(workspaceRoot, 'roles', role.name, 'handlers/main.yml'));
      candidateFiles.add(joinFsPath(workspaceRoot, 'roles', role.name, 'handlers/main.yaml'));
    }
  }

  const rolesDir = joinFsPath(workspaceRoot, 'roles');
  for (const entry of fs.listFiles(rolesDir)) {
    const cleanEntry = normalizeSlash(entry).replace(/\/+$/, '');
    const roleName = cleanEntry.includes('/')
      ? cleanEntry.slice(cleanEntry.lastIndexOf('/') + 1)
      : cleanEntry;
    if (roleName.length > 0) {
      candidateFiles.add(joinFsPath(rolesDir, roleName, 'handlers/main.yml'));
      candidateFiles.add(joinFsPath(rolesDir, roleName, 'handlers/main.yaml'));
    }
  }

  for (const handlerFile of candidateFiles) {
    if (!fs.exists(handlerFile)) {
      continue;
    }
    const content = fs.readFile(handlerFile);
    if (content !== undefined) {
      for (const name of collectHandlerNamesFromYaml(content)) {
        known.add(name);
      }
    }
  }

  return known;
}

function collectInventoryTargets(
  workspaceRoot: string,
  fs: IWorkspaceFs,
): {
  readonly hasInventory: boolean;
  readonly targets: Set<string>;
} {
  const candidates = ['inventory', 'hosts', 'hosts.ini', 'inventory.yml', 'inventory.yaml'];
  let hasInventory = false;
  const targets = new Set<string>();

  for (const fileName of candidates) {
    const fullPath = joinFsPath(workspaceRoot, fileName);
    if (!fs.exists(fullPath)) {
      continue;
    }
    const content = fs.readFile(fullPath);
    if (content === undefined) {
      continue;
    }
    hasInventory = true;

    if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) {
      parseYamlInventory(content, targets);
    } else {
      parseIniInventory(content, targets);
    }
  }

  return { hasInventory, targets };
}

function parseIniInventory(content: string, targets: Set<string>): void {
  const lines = content.split(/\r?\n/);
  let inVarsSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      const section = sectionMatch[1] ?? '';
      const colonIdx = section.indexOf(':');
      const groupName = colonIdx === -1 ? section : section.slice(0, colonIdx);
      const modifier = colonIdx === -1 ? '' : section.slice(colonIdx + 1);
      inVarsSection = modifier === 'vars';
      if (groupName.trim().length > 0) {
        targets.add(groupName.trim());
      }
      continue;
    }

    if (inVarsSection) {
      continue;
    }

    const firstToken = line.split(/\s+/)[0];
    if (firstToken !== undefined && firstToken.length > 0 && !firstToken.includes('=')) {
      targets.add(firstToken);
    }
  }
}

function parseYamlInventory(content: string, targets: Set<string>): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    void err;
    return;
  }

  const visitGroup = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [key, val] of Object.entries(record)) {
      if (key === 'vars') {
        continue;
      }
      if (key === 'hosts' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
        for (const hostName of Object.keys(val as Record<string, unknown>)) {
          targets.add(hostName);
        }
        continue;
      }
      if (key === 'children' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
        for (const [childGroup, childVal] of Object.entries(val as Record<string, unknown>)) {
          targets.add(childGroup);
          visitGroup(childVal);
        }
        continue;
      }
      targets.add(key);
      visitGroup(val);
    }
  };

  visitGroup(parsed);
}

function checkMissingSrcFile(
  task: TaskNode,
  docPath: string,
  playbookDir: string,
  workspaceRoot: string,
  fs: IWorkspaceFs,
  diagnostics: LintDiagnostic[],
): void {
  const shortMod = shortModuleName(task.moduleName);
  if (shortMod !== 'copy' && shortMod !== 'template') {
    return;
  }

  const srcParam = task.params.find((p) => p.name === 'src');
  if (!srcParam || typeof srcParam.value !== 'string') {
    return;
  }

  const srcValue = srcParam.value.trim();
  if (srcValue.length === 0 || containsJinja(srcValue)) {
    return;
  }

  const normalizedSrc = normalizeSlash(srcValue).replace(/^\.\//, '');
  const subdir = shortMod === 'copy' ? 'files' : 'templates';
  const docParent = dirnamePath(playbookDir);

  const candidates = new Set<string>([
    joinFsPath(playbookDir, normalizedSrc),
    joinFsPath(playbookDir, subdir, normalizedSrc),
    joinFsPath(docParent, subdir, normalizedSrc),
    joinFsPath(workspaceRoot, normalizedSrc),
    joinFsPath(workspaceRoot, subdir, normalizedSrc),
  ]);

  if (normalizedSrc.startsWith('/')) {
    candidates.add(normalizedSrc);
  }

  // If document is inside roles/<role>/tasks/*.yml, resolve relative to roles/<role>/<subdir>/
  const roleMatch = /^(.*\/roles\/[^/]+)\//.exec(docPath);
  if (roleMatch && roleMatch[1]) {
    candidates.add(joinFsPath(roleMatch[1], subdir, normalizedSrc));
    candidates.add(joinFsPath(roleMatch[1], normalizedSrc));
  }

  for (const candidate of candidates) {
    if (fs.exists(candidate)) {
      return;
    }
  }

  diagnostics.push({
    ruleId: 'missing-src-file',
    message: `Source file '${srcValue}' for '${task.moduleName}' was not found in workspace '${subdir}/' or relative paths.`,
    severity: 'warning',
    range: srcParam.valueRange,
    quickFixes: [],
  });
}

function splitPlayHostPatterns(hostsExpr: string): readonly string[] {
  return hostsExpr
    .split(/[:,]/)
    .map((part) => part.trim().replace(/^[!&]/, ''))
    .filter((part) => part.length > 0);
}

/**
 * Checks cross-file project integrity (missing roles, missing `tasks/main.yml`, broken `notify:` handlers,
 * missing `copy`/`template` `src:` files, and unknown inventory hosts).
 */
export function checkProjectIntegrity(
  ast: AnsibleDocumentAst,
  workspaceRoot: string,
  fs: IWorkspaceFs,
): readonly LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const normalizedRoot = normalizeSlash(workspaceRoot);
  const docPath = uriToFsPath(ast.uri);
  const playbookDir = docPath.includes('/') ? dirnamePath(docPath) : normalizedRoot;

  const checkedRoleNames = new Set<string>();

  const validateRoleRef = (
    roleName: string,
    range: AnsibleDocumentAst['plays'][number]['roles'][number]['range'],
  ): void => {
    if (containsJinja(roleName)) {
      return;
    }
    const dedupKey = `${roleName}@${range.start.offset}`;
    if (checkedRoleNames.has(dedupKey)) {
      return;
    }
    checkedRoleNames.add(dedupKey);

    if (!isValidRoleName(roleName)) {
      diagnostics.push({
        ruleId: 'missing-role',
        message: `Role name '${roleName}' is invalid or references an inaccessible path.`,
        severity: 'error',
        range,
        quickFixes: [],
      });
      return;
    }

    const roleDir = resolveRoleDir(roleName, normalizedRoot, playbookDir, fs);
    if (roleDir === undefined) {
      diagnostics.push({
        ruleId: 'missing-role',
        message: `Role '${roleName}' could not be found under 'roles/${roleName}'.`,
        severity: 'warning',
        range,
        quickFixes: [],
      });
      return;
    }

    if (!hasRoleTasksFile(roleDir, fs)) {
      diagnostics.push({
        ruleId: 'missing-role-tasks',
        message: `Role '${roleName}' exists at '${roleDir}' but is missing 'tasks/main.yml' (or 'tasks/main.yaml').`,
        severity: 'warning',
        range,
        quickFixes: [],
      });
    }
  };

  const inventoryInfo = collectInventoryTargets(normalizedRoot, fs);

  const validateTaskList = (tasks: readonly TaskNode[], knownHandlers: Set<string>): void => {
    for (const task of tasks) {
      const shortMod = shortModuleName(task.moduleName);
      if (shortMod === 'include_role' || shortMod === 'import_role') {
        const nameParam = task.params.find((p) => p.name === 'name');
        if (nameParam && typeof nameParam.value === 'string') {
          validateRoleRef(nameParam.value.trim(), nameParam.valueRange);
        }
      }

      if (task.notify && task.notify.length > 0) {
        for (const handlerTarget of task.notify) {
          const trimmed = handlerTarget.trim();
          if (trimmed.length === 0 || containsJinja(trimmed)) {
            continue;
          }
          if (!knownHandlers.has(trimmed)) {
            const suggestion = findClosestMatch(trimmed, Array.from(knownHandlers));
            const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
            diagnostics.push({
              ruleId: 'missing-handler',
              message: `Handler '${trimmed}' notified by task is not defined in play or role handlers.${hint}`,
              severity: 'warning',
              range: task.notifyRange ?? task.range,
              quickFixes: [],
            });
          }
        }
      }

      checkMissingSrcFile(task, docPath, playbookDir, normalizedRoot, fs, diagnostics);
    }
  };

  for (const play of ast.plays) {
    for (const role of play.roles) {
      validateRoleRef(role.name, role.range);
    }

    if (inventoryInfo.hasInventory && play.hosts !== undefined && !containsJinja(play.hosts)) {
      const patterns = splitPlayHostPatterns(play.hosts);
      for (const target of patterns) {
        if (
          target === 'all' ||
          target === 'localhost' ||
          target === '127.0.0.1' ||
          target === '*' ||
          target.includes('*')
        ) {
          continue;
        }
        if (!inventoryInfo.targets.has(target)) {
          const suggestion = findClosestMatch(target, Array.from(inventoryInfo.targets));
          const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
          diagnostics.push({
            ruleId: 'unknown-inventory-host',
            message: `Host or group '${target}' was not found in workspace inventory.${hint}`,
            severity: 'warning',
            range: play.hostsRange ?? play.range,
            quickFixes: [],
          });
        }
      }
    }

    const knownHandlers = collectWorkspaceHandlers(ast, play, normalizedRoot, playbookDir, fs);
    validateTaskList(play.preTasks, knownHandlers);
    validateTaskList(play.tasks, knownHandlers);
    validateTaskList(play.postTasks, knownHandlers);
    validateTaskList(play.handlers, knownHandlers);
  }

  if (ast.tasks.length > 0 || ast.handlers.length > 0) {
    const knownHandlers = collectWorkspaceHandlers(ast, undefined, normalizedRoot, playbookDir, fs);
    validateTaskList(ast.tasks, knownHandlers);
    validateTaskList(ast.handlers, knownHandlers);
  }

  return diagnostics;
}
