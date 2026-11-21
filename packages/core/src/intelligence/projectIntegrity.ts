import { parse as parseYaml } from 'yaml';
import type {
  AnsibleDocumentAst,
  IWorkspaceFs,
  LintDiagnostic,
  PlayNode,
  TaskNode,
} from '../contracts/types.js';
import { findClosestMatch } from './similarity.js';

/**
 * Discovered Ansible project root and configuration for a document inside a workspace
 * (including nested monorepos such as `mcleaf/ansible/` opened from `mcleaf/`).
 */
export interface AnsibleProjectContext {
  readonly ansibleRoot: string;
  readonly workspaceRoot: string;
  readonly documentDir: string;
  readonly ansibleCfgPath?: string;
  readonly rolesPaths: readonly string[];
  readonly inventoryPaths: readonly string[];
}

/**
 * Parsed `[defaults]` settings from an `ansible.cfg` file.
 */
export interface ParsedAnsibleCfg {
  readonly rolesPaths: readonly string[];
  readonly inventoryPath?: string;
}

function normalizeSlash(input: string): string {
  return input.replaceAll('\\', '/');
}

function trimTrailingSlashes(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 47) {
    end--;
  }
  return input.slice(0, end);
}

function trimBothSlashes(input: string): string {
  let start = 0;
  let end = input.length;
  while (start < end && input.charCodeAt(start) === 47) {
    start++;
  }
  while (end > start && input.charCodeAt(end - 1) === 47) {
    end--;
  }
  return input.slice(start, end);
}

function resolvePosixSegments(fullPath: string): string {
  const isAbs = fullPath.startsWith('/');
  const drivePrefix =
    !isAbs && fullPath.length >= 2 && fullPath[1] === ':' ? fullPath.slice(0, 2) : '';
  const pathBody = drivePrefix.length > 0 ? fullPath.slice(2) : fullPath;
  const rawParts = pathBody.split('/');
  const stack: string[] = [];
  for (const part of rawParts) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!isAbs && drivePrefix.length === 0) {
        stack.push('..');
      }
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join('/');
  if (drivePrefix.length > 0) {
    return joined.length > 0 ? `${drivePrefix}/${joined}` : drivePrefix;
  }
  return isAbs ? `/${joined}` : joined;
}

function joinFsPath(...parts: string[]): string {
  const cleaned: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = normalizeSlash(parts[i] ?? '');
    if (part.length === 0) {
      continue;
    }
    if (cleaned.length === 0) {
      cleaned.push(trimTrailingSlashes(part));
    } else {
      cleaned.push(trimBothSlashes(part));
    }
  }
  return resolvePosixSegments(cleaned.join('/'));
}

function uriToFsPath(uri: string): string {
  if (uri.startsWith('file:///')) {
    let stripped = decodeURIComponent(uri.slice('file://'.length));
    if (stripped.length >= 4 && stripped[0] === '/' && stripped[2] === ':' && stripped[3] === '/') {
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
  if (idx < 0) {
    return normalized;
  }
  if (idx === 0) {
    return '/';
  }
  return normalized.slice(0, idx);
}

function stripInlineIniComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if ((ch === '#' || ch === ';') && !inSingle && !inDouble) {
      if (i === 0 || value[i - 1] === ' ' || value[i - 1] === '\t') {
        return value.slice(0, i).trim();
      }
    }
  }
  return value.trim();
}

function unquoteIniValue(raw: string): string {
  const trimmed = stripInlineIniComment(raw);
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Parses `roles_path` (or `roles_dir`) and `inventory` (or `hostfile`) from `ansible.cfg`.
 */
export function parseAnsibleCfg(content: string): ParsedAnsibleCfg {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  let currentSection = 'defaults';
  const rolesPaths: string[] = [];
  let inventoryPath: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']') && line.length > 2) {
      currentSection = line.slice(1, -1).trim().toLowerCase();
      continue;
    }
    if (currentSection !== 'defaults') {
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) {
      continue;
    }
    const key = line.slice(0, eqIdx).trim().toLowerCase();
    const rawVal = unquoteIniValue(line.slice(eqIdx + 1));
    if (rawVal.length === 0) {
      continue;
    }
    if (key === 'roles_path' || key === 'roles_dir') {
      const separator = rawVal.includes(':') ? ':' : ',';
      for (const item of rawVal.split(separator)) {
        const cleaned = item.trim();
        if (cleaned.length > 0) {
          rolesPaths.push(cleaned);
        }
      }
    } else if (key === 'inventory' || key === 'hostfile') {
      inventoryPath = rawVal;
    }
  }

  return {
    rolesPaths,
    ...(inventoryPath !== undefined ? { inventoryPath } : {}),
  };
}

function buildAncestorChain(startDir: string, stopDir: string): readonly string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = trimTrailingSlashes(normalizeSlash(startDir)) || '/';
  const normalizedStop = trimTrailingSlashes(normalizeSlash(stopDir)) || '/';

  for (let depth = 0; depth < 16; depth++) {
    if (!seen.has(current)) {
      seen.add(current);
      chain.push(current);
    }
    if (current === normalizedStop) {
      break;
    }
    const parent = dirnamePath(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  if (!seen.has(normalizedStop)) {
    chain.push(normalizedStop);
  }
  return chain;
}

function directoryHasAnsibleLayoutMarkers(dir: string, fs: IWorkspaceFs): boolean {
  // Check roles/, inventory/, inventories/, group_vars/, host_vars/
  const markerCheckPaths = [
    joinFsPath(dir, 'roles'),
    joinFsPath(dir, 'inventory'),
    joinFsPath(dir, 'inventories'),
    joinFsPath(dir, 'group_vars'),
    joinFsPath(dir, 'group_vars/all'),
    joinFsPath(dir, 'group_vars/all.yml'),
    joinFsPath(dir, 'group_vars/all.yaml'),
    joinFsPath(dir, 'host_vars'),
    joinFsPath(dir, 'inventory/hosts'),
    joinFsPath(dir, 'inventory/hosts.ini'),
    joinFsPath(dir, 'inventory/hosts.yml'),
    joinFsPath(dir, 'inventory/hosts.yaml'),
    joinFsPath(dir, 'inventory/inventory.ini'),
    joinFsPath(dir, 'inventory/inventory.yml'),
    joinFsPath(dir, 'inventory/inventory.yaml'),
    joinFsPath(dir, 'hosts.ini'),
    joinFsPath(dir, 'inventory.ini'),
    joinFsPath(dir, 'inventory.yml'),
    joinFsPath(dir, 'inventory.yaml'),
  ];

  for (const candidate of markerCheckPaths) {
    if (fs.exists(candidate)) {
      return true;
    }
  }

  if (
    fs.listFiles(joinFsPath(dir, 'roles')).length > 0 ||
    fs.listFiles(joinFsPath(dir, 'inventory')).length > 0 ||
    fs.listFiles(joinFsPath(dir, 'group_vars')).length > 0 ||
    fs.listFiles(joinFsPath(dir, 'host_vars')).length > 0
  ) {
    return true;
  }

  return false;
}

function resolveRelativeToBase(baseDir: string, targetPath: string): string {
  const normalizedTarget = normalizeSlash(targetPath);
  if (
    normalizedTarget.startsWith('/') ||
    (normalizedTarget.length >= 2 && normalizedTarget[1] === ':')
  ) {
    return resolvePosixSegments(normalizedTarget);
  }
  return joinFsPath(baseDir, normalizedTarget);
}

/**
 * Walks up from `documentDir` toward `workspaceRoot` to locate the nearest `ansible.cfg`
 * (parsing `roles_path` and `inventory` if configured) or the nearest parent directory
 * containing `roles/`, `inventory/`, or `group_vars/`.
 */
export function discoverAnsibleProjectContext(
  docPathOrUri: string,
  workspaceRoot: string,
  fs: IWorkspaceFs,
): AnsibleProjectContext {
  const normalizedWorkspaceRoot = trimTrailingSlashes(normalizeSlash(workspaceRoot)) || '/';
  const docPath = uriToFsPath(docPathOrUri);
  const documentDir = docPath.includes('/') ? dirnamePath(docPath) : normalizedWorkspaceRoot;
  const ancestors = buildAncestorChain(documentDir, normalizedWorkspaceRoot);

  let ansibleRoot: string | undefined;
  let ansibleCfgPath: string | undefined;

  // 1. Nearest ancestor with ansible.cfg
  for (const dir of ancestors) {
    const cfgCandidate = joinFsPath(dir, 'ansible.cfg');
    if (fs.exists(cfgCandidate)) {
      ansibleRoot = dir;
      ansibleCfgPath = cfgCandidate;
      break;
    }
  }

  // 2. Nearest ancestor containing roles/, inventory/, or group_vars/
  if (ansibleRoot === undefined) {
    for (const dir of ancestors) {
      if (directoryHasAnsibleLayoutMarkers(dir, fs)) {
        ansibleRoot = dir;
        break;
      }
    }
  }

  // 3. Fallback to workspaceRoot
  const effectiveAnsibleRoot = ansibleRoot ?? normalizedWorkspaceRoot;

  let parsedCfg: ParsedAnsibleCfg = { rolesPaths: [] };
  if (ansibleCfgPath !== undefined) {
    const cfgContent = fs.readFile(ansibleCfgPath);
    if (cfgContent !== undefined) {
      parsedCfg = parseAnsibleCfg(cfgContent);
    }
  }

  const rolesPathsSet = new Set<string>();
  for (const configuredRolePath of parsedCfg.rolesPaths) {
    rolesPathsSet.add(resolveRelativeToBase(effectiveAnsibleRoot, configuredRolePath));
  }
  rolesPathsSet.add(joinFsPath(documentDir, 'roles'));
  rolesPathsSet.add(joinFsPath(effectiveAnsibleRoot, 'roles'));
  if (dirnamePath(documentDir) !== documentDir) {
    rolesPathsSet.add(joinFsPath(dirnamePath(documentDir), 'roles'));
  }
  rolesPathsSet.add(joinFsPath(normalizedWorkspaceRoot, 'roles'));
  rolesPathsSet.add(effectiveAnsibleRoot);
  rolesPathsSet.add(normalizedWorkspaceRoot);

  const inventoryPathsSet = new Set<string>();
  if (parsedCfg.inventoryPath !== undefined) {
    const resolvedInv = resolveRelativeToBase(effectiveAnsibleRoot, parsedCfg.inventoryPath);
    inventoryPathsSet.add(resolvedInv);
    inventoryPathsSet.add(joinFsPath(resolvedInv, 'hosts'));
    inventoryPathsSet.add(joinFsPath(resolvedInv, 'hosts.ini'));
    inventoryPathsSet.add(joinFsPath(resolvedInv, 'inventory.ini'));
    inventoryPathsSet.add(joinFsPath(resolvedInv, 'hosts.yml'));
    inventoryPathsSet.add(joinFsPath(resolvedInv, 'hosts.yaml'));
    inventoryPathsSet.add(joinFsPath(resolvedInv, 'inventory.yml'));
    inventoryPathsSet.add(joinFsPath(resolvedInv, 'inventory.yaml'));
    for (const listed of fs.listFiles(resolvedInv)) {
      inventoryPathsSet.add(normalizeSlash(listed));
    }
  }

  const standardInvNames = [
    'inventory',
    'hosts',
    'hosts.ini',
    'inventory.ini',
    'inventory.yml',
    'inventory.yaml',
    'inventory/hosts',
    'inventory/hosts.ini',
    'inventory/inventory.ini',
    'inventory/hosts.yml',
    'inventory/hosts.yaml',
    'inventory/inventory.yml',
    'inventory/inventory.yaml',
    'inventories/hosts',
    'inventories/hosts.ini',
  ];

  for (const baseDir of [effectiveAnsibleRoot, documentDir, normalizedWorkspaceRoot]) {
    for (const relName of standardInvNames) {
      inventoryPathsSet.add(joinFsPath(baseDir, relName));
    }
  }

  return {
    ansibleRoot: effectiveAnsibleRoot,
    workspaceRoot: normalizedWorkspaceRoot,
    documentDir,
    ...(ansibleCfgPath !== undefined ? { ansibleCfgPath } : {}),
    rolesPaths: Array.from(rolesPathsSet),
    inventoryPaths: Array.from(inventoryPathsSet),
  };
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
  for (let i = 0; i < roleName.length; i++) {
    const c = roleName.charCodeAt(i);
    const isAlphaNum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    const isAllowedSymbol = c === 95 || c === 46 || c === 45;
    if (!isAlphaNum && !isAllowedSymbol) {
      return false;
    }
  }
  return true;
}

function resolveRoleDir(
  roleName: string,
  context: AnsibleProjectContext,
  fs: IWorkspaceFs,
): string | undefined {
  const candidates = new Set<string>();
  for (const roleBase of context.rolesPaths) {
    candidates.add(joinFsPath(roleBase, roleName));
  }

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
  context: AnsibleProjectContext,
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
    joinFsPath(context.documentDir, 'handlers/main.yml'),
    joinFsPath(context.documentDir, 'handlers/main.yaml'),
    joinFsPath(dirnamePath(context.documentDir), 'handlers/main.yml'),
    joinFsPath(dirnamePath(context.documentDir), 'handlers/main.yaml'),
    joinFsPath(context.ansibleRoot, 'handlers/main.yml'),
    joinFsPath(context.ansibleRoot, 'handlers/main.yaml'),
    joinFsPath(context.workspaceRoot, 'handlers/main.yml'),
    joinFsPath(context.workspaceRoot, 'handlers/main.yaml'),
  ]);

  if (play) {
    for (const role of play.roles) {
      for (const roleBase of context.rolesPaths) {
        candidateFiles.add(joinFsPath(roleBase, role.name, 'handlers/main.yml'));
        candidateFiles.add(joinFsPath(roleBase, role.name, 'handlers/main.yaml'));
      }
    }
  }

  for (const roleBase of context.rolesPaths) {
    if (!roleBase.endsWith('/roles') && !parsedRolePathLookalike(roleBase)) {
      continue;
    }
    for (const entry of fs.listFiles(roleBase)) {
      const cleanEntry = trimTrailingSlashes(normalizeSlash(entry));
      if (cleanEntry.endsWith('/handlers/main.yml') || cleanEntry.endsWith('/handlers/main.yaml')) {
        candidateFiles.add(cleanEntry);
        continue;
      }
      const roleName = cleanEntry.includes('/')
        ? cleanEntry.slice(cleanEntry.lastIndexOf('/') + 1)
        : cleanEntry;
      if (roleName.length > 0) {
        candidateFiles.add(joinFsPath(roleBase, roleName, 'handlers/main.yml'));
        candidateFiles.add(joinFsPath(roleBase, roleName, 'handlers/main.yaml'));
      }
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

function parsedRolePathLookalike(dirPath: string): boolean {
  return dirPath.includes('role');
}

function collectInventoryTargets(
  context: AnsibleProjectContext,
  fs: IWorkspaceFs,
): {
  readonly hasInventory: boolean;
  readonly targets: Set<string>;
} {
  let hasInventory = false;
  const targets = new Set<string>();

  for (const fullPath of context.inventoryPaths) {
    if (!fs.exists(fullPath)) {
      continue;
    }
    const content = fs.readFile(fullPath);
    if (content === undefined) {
      continue;
    }
    hasInventory = true;

    if (fullPath.endsWith('.yml') || fullPath.endsWith('.yaml')) {
      parseYamlInventory(content, targets);
    } else {
      parseIniInventory(content, targets);
    }
  }

  return { hasInventory, targets };
}

function parseIniInventory(content: string, targets: Set<string>): void {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  let inVarsSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']') && line.length > 2) {
      const section = line.slice(1, -1);
      if (!section.includes('[') && !section.includes(']')) {
        const colonIdx = section.indexOf(':');
        const groupName = colonIdx === -1 ? section : section.slice(0, colonIdx);
        const modifier = colonIdx === -1 ? '' : section.slice(colonIdx + 1);
        inVarsSection = modifier === 'vars';
        if (groupName.trim().length > 0) {
          targets.add(groupName.trim());
        }
        continue;
      }
    }

    if (inVarsSection) {
      continue;
    }

    let spaceIdx = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 32 || c === 9) {
        spaceIdx = i;
        break;
      }
    }
    const firstToken = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    if (firstToken.length > 0 && !firstToken.includes('=')) {
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
  context: AnsibleProjectContext,
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

  const rawNormalizedSrc = normalizeSlash(srcValue);
  const normalizedSrc = rawNormalizedSrc.startsWith('./')
    ? rawNormalizedSrc.slice(2)
    : rawNormalizedSrc;
  const subdir = shortMod === 'copy' ? 'files' : 'templates';
  const docParent = dirnamePath(context.documentDir);

  const candidates = new Set<string>([
    joinFsPath(context.documentDir, normalizedSrc),
    joinFsPath(context.documentDir, subdir, normalizedSrc),
    joinFsPath(docParent, subdir, normalizedSrc),
    joinFsPath(context.ansibleRoot, normalizedSrc),
    joinFsPath(context.ansibleRoot, subdir, normalizedSrc),
    joinFsPath(context.workspaceRoot, normalizedSrc),
    joinFsPath(context.workspaceRoot, subdir, normalizedSrc),
  ]);

  if (normalizedSrc.startsWith('/')) {
    candidates.add(normalizedSrc);
  }

  // If document is inside roles/<role>/tasks/*.yml, resolve relative to roles/<role>/<subdir>/
  const rolesMarker = '/roles/';
  const rolesIdx = docPath.lastIndexOf(rolesMarker);
  if (rolesIdx !== -1) {
    const afterRoles = rolesIdx + rolesMarker.length;
    const nextSlash = docPath.indexOf('/', afterRoles);
    if (nextSlash !== -1 && nextSlash > afterRoles) {
      const roleBase = docPath.slice(0, nextSlash);
      candidates.add(joinFsPath(roleBase, subdir, normalizedSrc));
      candidates.add(joinFsPath(roleBase, normalizedSrc));
    }
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
    .replaceAll(',', ':')
    .split(':')
    .map((part) => {
      const trimmed = part.trim();
      if (trimmed.startsWith('!') || trimmed.startsWith('&')) {
        return trimmed.slice(1);
      }
      return trimmed;
    })
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
  const docPath = uriToFsPath(ast.uri);
  const context = discoverAnsibleProjectContext(ast.uri, workspaceRoot, fs);

  const checkedRoleNames = new Set<string>();

  const validateRoleRef = (
    roleName: string,
    range: AnsibleDocumentAst['plays'][number]['roles'][number]['range'],
  ): void => {
    if (containsJinja(roleName)) {
      return;
    }
    const dedupKey = `${roleName}@${range.start.line}:${range.start.column}`;
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

    const roleDir = resolveRoleDir(roleName, context, fs);
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

  const inventoryInfo = collectInventoryTargets(context, fs);

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

      checkMissingSrcFile(task, docPath, context, fs, diagnostics);
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

    const knownHandlers = collectWorkspaceHandlers(ast, play, context, fs);
    validateTaskList(play.preTasks, knownHandlers);
    validateTaskList(play.tasks, knownHandlers);
    validateTaskList(play.postTasks, knownHandlers);
    validateTaskList(play.handlers, knownHandlers);
  }

  if (ast.tasks.length > 0 || ast.handlers.length > 0) {
    const knownHandlers = collectWorkspaceHandlers(ast, undefined, context, fs);
    validateTaskList(ast.tasks, knownHandlers);
    validateTaskList(ast.handlers, knownHandlers);
  }

  return diagnostics;
}
