import path from 'node:path';
import type {
  AnsibleDocumentAst,
  AnsibleDocumentKind,
  AnsibleHeuristicResult,
  IMetadataRegistry,
  InferredRegisteredVariable,
  InferredReturnField,
  LintDiagnostic,
  ModuleReturnFieldSpec,
  PlayNode,
  SourcePosition,
  SourceRange,
  TaskNode,
  TaskParamNode,
  VariableDeclNode,
  VariableDefinition,
  VariableSourceKind,
} from '@ansible-lens/core';
import { detectAnsibleDocument, parseAnsibleDocument } from '@ansible-lens/core';
import { TASK_LEVEL_NON_MODULE_KEYS } from './ansible-reference.js';
import { uriToFsPath } from './workspace-fs.js';

interface LineStructure {
  readonly indent: number;
  readonly hasDash: boolean;
  readonly restAfterDash: string;
  readonly key: string;
  readonly value: string;
}

function isSimpleKeyToken(token: string): boolean {
  if (token.length === 0) {
    return false;
  }
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    const isAlphaNum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    const isSymbol = c === 95 || c === 46 || c === 45 || c === 39 || c === 34;
    if (!isAlphaNum && !isSymbol) {
      return false;
    }
  }
  return true;
}

function isIdentifierToken(token: string): boolean {
  if (token.length === 0) {
    return false;
  }
  const first = token.charCodeAt(0);
  const firstOk = (first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95;
  if (!firstOk) {
    return false;
  }
  for (let i = 1; i < token.length; i++) {
    const c = token.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    if (!ok) {
      return false;
    }
  }
  return true;
}

function parseLineStructure(rawLine: string): LineStructure | undefined {
  let indent = 0;
  while (indent < rawLine.length) {
    const c = rawLine.charCodeAt(indent);
    if (c !== 32 && c !== 9) {
      break;
    }
    indent++;
  }
  const trimmed = rawLine.slice(indent).trimEnd();
  if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') {
    return undefined;
  }

  let hasDash = false;
  let content = trimmed;
  if (trimmed === '-' || trimmed.startsWith('- ') || trimmed.startsWith('-\t')) {
    hasDash = true;
    content = trimmed.slice(1).trimStart();
  }

  const colonIdx = content.indexOf(':');
  if (colonIdx <= 0) {
    return {
      indent,
      hasDash,
      restAfterDash: content,
      key: '',
      value: '',
    };
  }

  const candidateKey = content.slice(0, colonIdx).trim();
  const afterColon = content.slice(colonIdx + 1);
  if (afterColon.length > 0 && afterColon[0] !== ' ' && afterColon[0] !== '\t') {
    return {
      indent,
      hasDash,
      restAfterDash: content,
      key: '',
      value: '',
    };
  }

  if (!isSimpleKeyToken(candidateKey)) {
    return {
      indent,
      hasDash,
      restAfterDash: content,
      key: '',
      value: '',
    };
  }

  return {
    indent,
    hasDash,
    restAfterDash: content,
    key: candidateKey,
    value: afterColon.trim(),
  };
}

/**
 * Evaluates whether a YAML document is Ansible using `@ansible-lens/core` plus
 * Smart Hybrid Activation guards that explicitly exclude Kubernetes, Docker Compose,
 * and GitHub Actions files.
 */
export function evaluateAnsibleHeuristic(
  uri: string,
  text: string,
  hasWorkspaceAnsibleCfg: boolean,
): AnsibleHeuristicResult {
  const normalizedPath = uriToFsPath(uri).replaceAll('\\', '/').toLowerCase();
  if (normalizedPath.endsWith('.j2')) {
    return {
      isAnsible: true,
      kind: 'template',
      reason: 'Jinja2 template (.j2)',
    };
  }
  const lines = text.replaceAll('\r\n', '\n').split('\n');

  let hasApiVersion = false;
  let hasKind = false;
  let hasServices = false;
  let hasComposeCompanion = false;
  let hasGhaOn = false;
  let hasGhaJobs = false;
  let hasGhaCompanion = false;
  let hasDashNameOrHosts = false;
  let hasPlaybookSection = false;
  let hasDashName = false;
  let hasTaskContent = false;

  for (const rawLine of lines) {
    const parsed = parseLineStructure(rawLine);
    if (!parsed) {
      continue;
    }
    const { key, hasDash } = parsed;
    if (key === 'apiVersion') {
      hasApiVersion = true;
    } else if (key === 'kind') {
      hasKind = true;
    } else if (key === 'services') {
      hasServices = true;
    } else if (key === 'volumes' || key === 'networks' || key === 'version') {
      hasComposeCompanion = true;
    } else if (key === 'on' || key === "'on'" || key === '"on"') {
      hasGhaOn = true;
    } else if (key === 'jobs') {
      hasGhaJobs = true;
    } else if (key === 'runs-on' || key === 'steps' || key === 'uses') {
      hasGhaCompanion = true;
    }

    if (hasDash && (key === 'name' || key === 'hosts')) {
      hasDashNameOrHosts = true;
    }
    if (hasDash && key === 'name') {
      hasDashName = true;
    }
    if (
      key === 'hosts' ||
      key === 'tasks' ||
      key === 'pre_tasks' ||
      key === 'post_tasks' ||
      key === 'roles' ||
      key === 'handlers'
    ) {
      hasPlaybookSection = true;
    }
    if (
      key.startsWith('ansible.builtin.') ||
      key === 'register' ||
      key === 'when' ||
      key === 'notify' ||
      key === 'become'
    ) {
      hasTaskContent = true;
    }
  }

  if (hasApiVersion && hasKind) {
    return {
      isAnsible: false,
      kind: 'unknown',
      reason: 'Excluded Kubernetes manifest (apiVersion + kind)',
    };
  }

  if (
    hasServices &&
    (hasComposeCompanion ||
      normalizedPath.endsWith('docker-compose.yml') ||
      normalizedPath.endsWith('docker-compose.yaml') ||
      normalizedPath.endsWith('compose.yml') ||
      normalizedPath.endsWith('compose.yaml'))
  ) {
    return {
      isAnsible: false,
      kind: 'unknown',
      reason: 'Excluded Docker Compose manifest (services)',
    };
  }

  if (
    hasGhaOn &&
    hasGhaJobs &&
    (hasGhaCompanion || normalizedPath.includes('/.github/workflows/'))
  ) {
    return {
      isAnsible: false,
      kind: 'unknown',
      reason: 'Excluded GitHub Actions workflow (on + jobs)',
    };
  }

  const coreResult = detectAnsibleDocument(uri, text, hasWorkspaceAnsibleCfg);

  const kindFromPath = inferKindFromPath(normalizedPath);
  if (kindFromPath !== 'unknown') {
    return {
      isAnsible: true,
      kind: kindFromPath,
      reason: `Matched Ansible path convention (${kindFromPath})`,
    };
  }

  if (hasDashNameOrHosts && hasPlaybookSection) {
    return {
      isAnsible: true,
      kind: 'playbook',
      reason: 'Matched Ansible playbook structure (hosts/tasks/roles)',
    };
  }

  if (hasDashName && hasTaskContent) {
    return {
      isAnsible: true,
      kind: 'tasks',
      reason: 'Matched Ansible task list content',
    };
  }

  if (coreResult.isAnsible && coreResult.reason !== 'stub') {
    return coreResult;
  }

  if (
    hasWorkspaceAnsibleCfg &&
    (normalizedPath.endsWith('.yml') || normalizedPath.endsWith('.yaml'))
  ) {
    const inferred = inferPlayOrVarKind(lines);
    return {
      isAnsible: true,
      kind: inferred,
      reason: 'Workspace contains ansible.cfg and document is YAML',
    };
  }

  return coreResult;
}

function isYamlFileName(name: string): boolean {
  return name.endsWith('.yml') || name.endsWith('.yaml');
}

function inferKindFromPath(normalizedPath: string): AnsibleDocumentKind {
  const segments = normalizedPath.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    return 'unknown';
  }
  const base = segments[segments.length - 1] ?? '';
  const dirSegments = segments.slice(0, -1);
  const isYaml = isYamlFileName(base);

  const rolesIdx = dirSegments.lastIndexOf('roles');
  if (isYaml && rolesIdx !== -1 && rolesIdx + 2 < segments.length) {
    const section = segments[rolesIdx + 2];
    if (section === 'tasks') {
      return 'tasks';
    }
    if (section === 'handlers') {
      return 'handlers';
    }
    if (section === 'defaults') {
      return 'role-defaults';
    }
    if (section === 'vars') {
      return 'role-vars';
    }
  }

  if (isYaml && segments.length >= 2) {
    const parent = segments[segments.length - 2];
    if (parent === 'tasks') {
      return 'tasks';
    }
    if (parent === 'handlers') {
      return 'handlers';
    }
  }

  if (
    dirSegments.includes('group_vars') &&
    (isYaml || dirSegments.indexOf('group_vars') < dirSegments.length - 1)
  ) {
    return 'group-vars';
  }
  if (
    dirSegments.includes('host_vars') &&
    (isYaml || dirSegments.indexOf('host_vars') < dirSegments.length - 1)
  ) {
    return 'host-vars';
  }

  if (
    base === 'site.yml' ||
    base === 'site.yaml' ||
    base === 'playbook.yml' ||
    base === 'playbook.yaml' ||
    (isYaml && dirSegments.includes('playbooks'))
  ) {
    return 'playbook';
  }

  if (
    base === 'hosts.ini' ||
    base === 'inventory.ini' ||
    (isYaml && dirSegments.includes('inventory'))
  ) {
    return 'inventory';
  }

  return 'unknown';
}

function inferPlayOrVarKind(rawLines: readonly string[]): AnsibleDocumentKind {
  let hasName = false;
  for (const rawLine of rawLines) {
    const parsed = parseLineStructure(rawLine);
    if (!parsed) {
      continue;
    }
    if (parsed.key === 'hosts') {
      return 'playbook';
    }
    if (parsed.hasDash && parsed.key === 'name') {
      hasName = true;
    }
  }
  return hasName ? 'tasks' : 'unknown';
}

function makePos(line: number, column: number, lineStarts: readonly number[]): SourcePosition {
  const lineStart = lineStarts[line] ?? 0;
  return { line, column, offset: lineStart + column };
}

function makeRange(
  line: number,
  startCol: number,
  endCol: number,
  lineStarts: readonly number[],
): SourceRange {
  return {
    start: makePos(line, startCol, lineStarts),
    end: makePos(line, endCol, lineStarts),
  };
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isIntegerString(trimmed: string): boolean {
  if (trimmed.length === 0) {
    return false;
  }
  const start = trimmed.startsWith('-') ? 1 : 0;
  if (start >= trimmed.length) {
    return false;
  }
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i);
    if (c < 48 || c > 57) {
      return false;
    }
  }
  return true;
}

function isFloatString(trimmed: string): boolean {
  const dotIdx = trimmed.indexOf('.');
  if (dotIdx <= 0 || dotIdx === trimmed.length - 1) {
    return false;
  }
  return isIntegerString(trimmed.slice(0, dotIdx)) && isIntegerString(trimmed.slice(dotIdx + 1));
}

function parseScalarValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '~' || trimmed === 'null') {
    return null;
  }
  if (trimmed === 'true' || trimmed === 'True' || trimmed === 'yes') {
    return true;
  }
  if (trimmed === 'false' || trimmed === 'False' || trimmed === 'no') {
    return false;
  }
  if (isIntegerString(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  if (isFloatString(trimmed) && !trimmed.slice(trimmed.indexOf('.') + 1).startsWith('-')) {
    return Number.parseFloat(trimmed);
  }
  return stripQuotes(trimmed);
}

/**
 * Ensures we always have a populated `AnsibleDocumentAst` even when `@ansible-lens/core`'s
 * `parseAnsibleDocument` returns an empty structure on incomplete lines.
 */
export function parseDocumentWithFallback(
  uri: string,
  text: string,
  kindHint?: AnsibleDocumentKind,
  registry?: IMetadataRegistry,
): AnsibleDocumentAst {
  const coreAst = parseAnsibleDocument(uri, text, kindHint);
  if (coreAst.kind === 'template' || kindHint === 'template') {
    return coreAst;
  }
  const coreHasContent =
    coreAst.plays.length > 0 ||
    coreAst.tasks.length > 0 ||
    coreAst.handlers.length > 0 ||
    coreAst.variables.length > 0;

  if (coreHasContent) {
    return coreAst;
  }

  return fallbackExtractAst(uri, text, kindHint ?? coreAst.kind, registry);
}

interface MutableTask {
  name?: string;
  nameRange?: SourceRange;
  moduleName?: string;
  moduleRange?: SourceRange;
  params: TaskParamNode[];
  register?: string;
  registerRange?: SourceRange;
  loop?: unknown;
  loopKind?: TaskNode['loopKind'];
  when?: string;
  whenRange?: SourceRange;
  changedWhen?: string | boolean;
  changedWhenRange?: SourceRange;
  notify?: string[];
  notifyRange?: SourceRange;
  become?: boolean;
  startLine: number;
  endLine: number;
  indent: number;
  section: 'tasks' | 'pre_tasks' | 'post_tasks' | 'handlers' | 'top';
}

interface MutablePlay {
  name?: string;
  hosts?: string;
  hostsRange?: SourceRange;
  become?: boolean;
  vars: Record<string, unknown>;
  varsFiles: Array<{ path: string; range: SourceRange }>;
  roles: Array<{ name: string; range: SourceRange }>;
  preTasks: TaskNode[];
  tasks: TaskNode[];
  postTasks: TaskNode[];
  handlers: TaskNode[];
  startLine: number;
  endLine: number;
}

function finalizeTask(
  task: MutableTask,
  lineStarts: readonly number[],
  lines: readonly string[],
): TaskNode | undefined {
  if (!task.moduleName || !task.moduleRange) {
    return undefined;
  }
  const endLineLen = (lines[task.endLine] ?? '').length;
  const base: TaskNode = {
    moduleName: task.moduleName,
    moduleRange: task.moduleRange,
    isFqcn: task.moduleName.includes('.'),
    params: task.params,
    duplicateKeys: [],
    rawTruthyKeys: [],
    range: {
      start: makePos(task.startLine, 0, lineStarts),
      end: makePos(task.endLine, endLineLen, lineStarts),
    },
  };
  return {
    ...base,
    ...(task.name !== undefined ? { name: task.name } : {}),
    ...(task.nameRange !== undefined ? { nameRange: task.nameRange } : {}),
    ...(task.register !== undefined ? { register: task.register } : {}),
    ...(task.registerRange !== undefined ? { registerRange: task.registerRange } : {}),
    ...(task.loop !== undefined ? { loop: task.loop } : {}),
    ...(task.loopKind !== undefined ? { loopKind: task.loopKind } : {}),
    ...(task.when !== undefined ? { when: task.when } : {}),
    ...(task.whenRange !== undefined ? { whenRange: task.whenRange } : {}),
    ...(task.changedWhen !== undefined ? { changedWhen: task.changedWhen } : {}),
    ...(task.changedWhenRange !== undefined ? { changedWhenRange: task.changedWhenRange } : {}),
    ...(task.notify !== undefined ? { notify: task.notify } : {}),
    ...(task.notifyRange !== undefined ? { notifyRange: task.notifyRange } : {}),
    ...(task.become !== undefined ? { become: task.become } : {}),
  };
}

const PLAY_SECTION_KEYS = new Set([
  'vars',
  'vars_files',
  'roles',
  'pre_tasks',
  'tasks',
  'post_tasks',
  'handlers',
]);

function fallbackExtractAst(
  uri: string,
  text: string,
  kind: AnsibleDocumentKind,
  registry?: IMetadataRegistry,
): AnsibleDocumentAst {
  const normalizedPath = uriToFsPath(uri).replaceAll('\\', '/').toLowerCase();
  const effectiveKind = kind !== 'unknown' ? kind : inferKindFromPath(normalizedPath);
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const lineStarts = computeLineStarts(text);

  const plays: PlayNode[] = [];
  const topTasks: TaskNode[] = [];
  const topHandlers: TaskNode[] = [];
  const variables: VariableDeclNode[] = [];

  const varSourceKind = mapDocKindToVarSource(effectiveKind, normalizedPath);
  if (
    effectiveKind === 'group-vars' ||
    effectiveKind === 'host-vars' ||
    effectiveKind === 'role-defaults' ||
    effectiveKind === 'role-vars'
  ) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const parsed = parseLineStructure(line);
      if (!parsed || parsed.indent !== 0 || parsed.hasDash || !isIdentifierToken(parsed.key)) {
        continue;
      }
      const key = parsed.key;
      const rawVal = parsed.value;
      const valStart = line.indexOf(':') + 1;
      const valCol = rawVal.length > 0 ? line.indexOf(rawVal, valStart) : valStart;
      variables.push({
        name: key,
        value: parseScalarValue(rawVal),
        rawValue: rawVal,
        keyRange: makeRange(i, 0, key.length, lineStarts),
        valueRange: makeRange(i, Math.max(valCol, 0), line.length, lineStarts),
        sourceKind: varSourceKind,
      });
    }
    return {
      uri,
      kind: effectiveKind,
      text,
      plays,
      tasks: topTasks,
      handlers: topHandlers,
      variables,
      jinjaBlocks: [],
      duplicateKeys: [],
      rawTruthyValues: [],
      syntaxErrors: [],
    };
  }

  type PlaySection =
    'none' | 'vars' | 'vars_files' | 'roles' | 'pre_tasks' | 'tasks' | 'post_tasks' | 'handlers';
  let currentPlay: MutablePlay | undefined;
  let playSection: PlaySection = 'none';
  let currentTask: MutableTask | undefined;
  let activeModuleKeyIndent = -1;
  let inNotifyList = false;
  let inLoopList = false;

  const flushTask = () => {
    if (!currentTask) {
      return;
    }
    const built = finalizeTask(currentTask, lineStarts, lines);
    if (built) {
      if (currentPlay) {
        if (currentTask.section === 'handlers') {
          currentPlay.handlers.push(built);
        } else if (currentTask.section === 'pre_tasks') {
          currentPlay.preTasks.push(built);
        } else if (currentTask.section === 'post_tasks') {
          currentPlay.postTasks.push(built);
        } else {
          currentPlay.tasks.push(built);
        }
      } else if (effectiveKind === 'handlers') {
        topHandlers.push(built);
      } else {
        topTasks.push(built);
      }
    }
    currentTask = undefined;
    activeModuleKeyIndent = -1;
    inNotifyList = false;
    inLoopList = false;
  };

  const flushPlay = (endLine: number) => {
    flushTask();
    if (!currentPlay) {
      return;
    }
    const endCol = (lines[endLine] ?? '').length;
    plays.push({
      ...(currentPlay.name !== undefined ? { name: currentPlay.name } : {}),
      ...(currentPlay.hosts !== undefined ? { hosts: currentPlay.hosts } : {}),
      ...(currentPlay.hostsRange !== undefined ? { hostsRange: currentPlay.hostsRange } : {}),
      ...(currentPlay.become !== undefined ? { become: currentPlay.become } : {}),
      vars: currentPlay.vars,
      varsFiles: currentPlay.varsFiles,
      roles: currentPlay.roles,
      preTasks: currentPlay.preTasks,
      tasks: currentPlay.tasks,
      postTasks: currentPlay.postTasks,
      handlers: currentPlay.handlers,
      range: {
        start: makePos(currentPlay.startLine, 0, lineStarts),
        end: makePos(endLine, endCol, lineStarts),
      },
    });
    currentPlay = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const parsed = parseLineStructure(line);
    if (!parsed) {
      continue;
    }

    const leadingSpaces = parsed.indent;

    if (parsed.hasDash) {
      const indent = parsed.indent;
      const rest = parsed.restAfterDash;

      if (
        indent === 0 &&
        (effectiveKind === 'playbook' ||
          parsed.key === 'hosts' ||
          (playSection === 'none' && hasPlayKeywordsAhead(lines, i)))
      ) {
        flushPlay(Math.max(0, i - 1));
        currentPlay = {
          vars: {},
          varsFiles: [],
          roles: [],
          preTasks: [],
          tasks: [],
          postTasks: [],
          handlers: [],
          startLine: i,
          endLine: i,
        };
        playSection = 'none';
        if (parsed.key === 'name') {
          currentPlay.name = stripQuotes(parsed.value);
        } else if (parsed.key === 'hosts') {
          currentPlay.hosts = stripQuotes(parsed.value);
          const col = line.indexOf(parsed.value, line.indexOf(':') + 1);
          currentPlay.hostsRange = makeRange(i, Math.max(0, col), line.length, lineStarts);
        }
        continue;
      }

      if (currentPlay && playSection === 'vars_files' && indent >= 2) {
        const val = stripQuotes(rest);
        const col = line.indexOf(rest);
        currentPlay.varsFiles.push({
          path: val,
          range: makeRange(i, Math.max(0, col), line.length, lineStarts),
        });
        continue;
      }

      if (
        currentPlay &&
        playSection === 'roles' &&
        indent >= 2 &&
        !PLAY_SECTION_KEYS.has(parsed.key)
      ) {
        const roleName = stripQuotes(parsed.key === 'role' ? parsed.value : rest);
        const col = line.indexOf(roleName);
        if (roleName && !roleName.includes(':')) {
          currentPlay.roles.push({
            name: roleName,
            range: makeRange(i, Math.max(0, col), Math.max(0, col) + roleName.length, lineStarts),
          });
        }
        continue;
      }

      if (currentTask && inNotifyList && indent > currentTask.indent) {
        currentTask.endLine = i;
        currentTask.notify = currentTask.notify ?? [];
        currentTask.notify.push(stripQuotes(rest));
        continue;
      }

      if (currentTask && inLoopList && indent > currentTask.indent) {
        currentTask.endLine = i;
        const arr = Array.isArray(currentTask.loop) ? currentTask.loop : [];
        arr.push(parseScalarValue(rest));
        currentTask.loop = arr;
        continue;
      }

      if (
        !currentPlay ||
        playSection === 'tasks' ||
        playSection === 'pre_tasks' ||
        playSection === 'post_tasks' ||
        playSection === 'handlers'
      ) {
        flushTask();
        const section: MutableTask['section'] = currentPlay
          ? playSection === 'pre_tasks' ||
            playSection === 'post_tasks' ||
            playSection === 'handlers'
            ? playSection
            : 'tasks'
          : 'top';
        currentTask = {
          params: [],
          startLine: i,
          endLine: i,
          indent: indent + 2,
          section,
        };
        if (parsed.key.length > 0) {
          const key = parsed.key;
          const val = parsed.value;
          const keyCol = line.indexOf(key, indent);
          applyTaskKeyValue(currentTask, key, val, i, keyCol, line, lineStarts, registry);
          if (!TASK_LEVEL_NON_MODULE_KEYS.has(key) && isLikelyModuleKey(key, registry)) {
            activeModuleKeyIndent = indent + 2;
          }
        }
        continue;
      }
    }

    if (currentPlay && leadingSpaces <= 4 && !currentTask && parsed.key.length > 0) {
      const key = parsed.key;
      const val = parsed.value;
      if (key === 'hosts') {
        currentPlay.hosts = stripQuotes(val);
        const col = line.indexOf(val, line.indexOf(':') + 1);
        currentPlay.hostsRange = makeRange(i, Math.max(0, col), line.length, lineStarts);
        playSection = 'none';
        continue;
      }
      if (key === 'name') {
        currentPlay.name = stripQuotes(val);
        continue;
      }
      if (key === 'become') {
        currentPlay.become = parseScalarValue(val) === true;
        continue;
      }
      if (
        key === 'vars' ||
        key === 'vars_files' ||
        key === 'roles' ||
        key === 'pre_tasks' ||
        key === 'tasks' ||
        key === 'post_tasks' ||
        key === 'handlers'
      ) {
        playSection = key;
        continue;
      }
    }

    if (
      currentPlay &&
      leadingSpaces <= 2 &&
      parsed.value.length === 0 &&
      PLAY_SECTION_KEYS.has(parsed.key)
    ) {
      flushTask();
      playSection = parsed.key as PlaySection;
      continue;
    }

    if (
      currentPlay &&
      playSection === 'vars' &&
      leadingSpaces >= 4 &&
      isIdentifierToken(parsed.key)
    ) {
      const key = parsed.key;
      const rawVal = parsed.value;
      const keyCol = line.indexOf(key);
      const valCol = rawVal.length > 0 ? line.indexOf(rawVal, line.indexOf(':') + 1) : line.length;
      currentPlay.vars[key] = parseScalarValue(rawVal);
      variables.push({
        name: key,
        value: parseScalarValue(rawVal),
        rawValue: rawVal,
        keyRange: makeRange(i, keyCol, keyCol + key.length, lineStarts),
        valueRange: makeRange(i, Math.max(0, valCol), line.length, lineStarts),
        sourceKind: 'play-vars',
      });
      continue;
    }

    if (currentTask) {
      currentTask.endLine = i;
      if (parsed.key.length > 0) {
        const key = parsed.key;
        const rawVal = parsed.value;
        const keyCol = line.indexOf(key);

        if (activeModuleKeyIndent >= 0 && leadingSpaces > activeModuleKeyIndent) {
          inNotifyList = false;
          inLoopList = false;
          const valCol =
            rawVal.length > 0 ? line.indexOf(rawVal, line.indexOf(':') + 1) : line.length;
          currentTask.params.push({
            name: key,
            keyRange: makeRange(i, keyCol, keyCol + key.length, lineStarts),
            valueRange: makeRange(i, Math.max(0, valCol), line.length, lineStarts),
            rawText: rawVal,
            value: parseScalarValue(rawVal),
            jinjaBlocks: [],
          });
          if (
            currentTask.moduleName === 'ansible.builtin.set_fact' ||
            currentTask.moduleName === 'set_fact'
          ) {
            if (key !== 'cacheable') {
              variables.push({
                name: key,
                value: parseScalarValue(rawVal),
                rawValue: rawVal,
                keyRange: makeRange(i, keyCol, keyCol + key.length, lineStarts),
                valueRange: makeRange(i, Math.max(0, valCol), line.length, lineStarts),
                sourceKind: 'set-fact',
              });
            }
          }
          continue;
        }

        inNotifyList = key === 'notify' && rawVal === '';
        inLoopList = (key === 'loop' || key.startsWith('with_')) && rawVal === '';
        applyTaskKeyValue(currentTask, key, rawVal, i, keyCol, line, lineStarts, registry);
        if (!TASK_LEVEL_NON_MODULE_KEYS.has(key) && isLikelyModuleKey(key, registry)) {
          activeModuleKeyIndent = leadingSpaces;
        }
      }
    }
  }

  flushPlay(Math.max(0, lines.length - 1));

  return {
    uri,
    kind: effectiveKind,
    text,
    plays,
    tasks: topTasks,
    handlers: topHandlers,
    variables,
    jinjaBlocks: [],
    duplicateKeys: [],
    rawTruthyValues: [],
    syntaxErrors: [],
  };
}

function hasPlayKeywordsAhead(lines: readonly string[], startIdx: number): boolean {
  for (let i = startIdx; i < Math.min(lines.length, startIdx + 12); i++) {
    const line = lines[i] ?? '';
    const parsed = parseLineStructure(line);
    if (!parsed) {
      continue;
    }
    if (
      parsed.key === 'hosts' ||
      parsed.key === 'tasks' ||
      parsed.key === 'pre_tasks' ||
      parsed.key === 'post_tasks' ||
      parsed.key === 'roles' ||
      parsed.key === 'handlers'
    ) {
      return true;
    }
    if (i > startIdx && parsed.indent === 0 && parsed.hasDash) {
      return false;
    }
  }
  return false;
}

function isLikelyModuleKey(key: string, registry?: IMetadataRegistry): boolean {
  if (TASK_LEVEL_NON_MODULE_KEYS.has(key)) {
    return false;
  }
  if (key.includes('.')) {
    return true;
  }
  if (registry?.getModule(key)) {
    return true;
  }
  return true;
}

function applyTaskKeyValue(
  task: MutableTask,
  key: string,
  rawVal: string,
  lineIdx: number,
  keyCol: number,
  line: string,
  lineStarts: readonly number[],
  registry?: IMetadataRegistry,
): void {
  const valCol = rawVal.length > 0 ? line.indexOf(rawVal, line.indexOf(':') + 1) : line.length;
  if (key === 'name') {
    task.name = stripQuotes(rawVal);
    task.nameRange = makeRange(lineIdx, Math.max(0, valCol), line.length, lineStarts);
    return;
  }
  if (key === 'register') {
    task.register = stripQuotes(rawVal);
    task.registerRange = makeRange(lineIdx, Math.max(0, valCol), line.length, lineStarts);
    return;
  }
  if (key === 'when') {
    task.when = stripQuotes(rawVal);
    task.whenRange = makeRange(lineIdx, Math.max(0, valCol), line.length, lineStarts);
    return;
  }
  if (key === 'changed_when') {
    const parsed = parseScalarValue(rawVal);
    task.changedWhen = typeof parsed === 'boolean' ? parsed : stripQuotes(rawVal);
    task.changedWhenRange = makeRange(lineIdx, Math.max(0, valCol), line.length, lineStarts);
    return;
  }
  if (key === 'notify') {
    if (rawVal.length > 0) {
      task.notify = [stripQuotes(rawVal)];
      task.notifyRange = makeRange(lineIdx, Math.max(0, valCol), line.length, lineStarts);
    } else {
      task.notify = [];
      task.notifyRange = makeRange(lineIdx, keyCol, keyCol + key.length, lineStarts);
    }
    return;
  }
  if (
    key === 'loop' ||
    key === 'with_items' ||
    key === 'with_dict' ||
    key === 'with_list' ||
    key === 'with_flattened' ||
    key === 'with_subelements' ||
    key === 'with_sequence'
  ) {
    task.loopKind = key;
    task.loop = rawVal.length > 0 ? parseScalarValue(rawVal) : [];
    return;
  }
  if (key === 'become') {
    task.become = parseScalarValue(rawVal) === true;
    return;
  }
  if (!TASK_LEVEL_NON_MODULE_KEYS.has(key) && isLikelyModuleKey(key, registry)) {
    task.moduleName = key;
    task.moduleRange = makeRange(lineIdx, keyCol, keyCol + key.length, lineStarts);
  }
}

function mapDocKindToVarSource(
  kind: AnsibleDocumentKind,
  normalizedPath: string,
): VariableSourceKind {
  if (kind === 'role-defaults') {
    return 'role-defaults';
  }
  if (kind === 'role-vars') {
    return 'role-vars';
  }
  if (kind === 'host-vars') {
    return normalizedPath.includes('/inventory/') ? 'inventory-host-vars' : 'playbook-host-vars';
  }
  if (kind === 'group-vars') {
    if (path.posix.basename(normalizedPath).startsWith('all.')) {
      return 'playbook-group-vars-all';
    }
    return normalizedPath.includes('/inventory/') ? 'inventory-group-vars' : 'playbook-group-vars';
  }
  return 'play-vars';
}

export function getPrecedenceMeta(sourceKind: VariableSourceKind): {
  readonly level: number;
  readonly label: string;
} {
  switch (sourceKind) {
    case 'role-defaults':
      return { level: 2, label: 'role defaults (defaults/main.yml)' };
    case 'inventory-file':
      return { level: 3, label: 'inventory file or script group vars' };
    case 'inventory-group-vars':
      return { level: 4, label: 'inventory group_vars/*' };
    case 'playbook-group-vars-all':
      return { level: 5, label: 'playbook group_vars/all' };
    case 'playbook-group-vars':
      return { level: 6, label: 'playbook group_vars/*' };
    case 'inventory-host-vars':
      return { level: 8, label: 'inventory host_vars/*' };
    case 'playbook-host-vars':
      return { level: 9, label: 'playbook host_vars/*' };
    case 'host-facts':
      return { level: 11, label: 'host facts / cached set_facts' };
    case 'play-vars':
      return { level: 12, label: 'play vars' };
    case 'play-vars-prompt':
      return { level: 13, label: 'play vars_prompt' };
    case 'play-vars-files':
      return { level: 14, label: 'play vars_files' };
    case 'role-vars':
      return { level: 15, label: 'role vars (vars/main.yml)' };
    case 'block-vars':
      return { level: 16, label: 'block vars' };
    case 'task-vars':
      return { level: 17, label: 'task vars' };
    case 'include-vars':
      return { level: 18, label: 'include_vars' };
    case 'set-fact':
      return { level: 19, label: 'set_facts / registered vars' };
    case 'register':
      return { level: 19, label: 'set_facts / registered vars' };
    case 'role-params':
      return { level: 20, label: 'role params' };
    case 'include-params':
      return { level: 21, label: 'include params' };
    case 'extra-vars':
      return { level: 22, label: 'extra vars (-e)' };
  }
}

/**
 * Fallback helper converting AST variable declarations into `VariableDefinition`s
 * when core's `WorkspaceVariableGraph.indexDocument` is a stub.
 */
export function extractVariableDefinitionsFromAst(
  ast: AnsibleDocumentAst,
): readonly VariableDefinition[] {
  return ast.variables.map((v) => {
    const meta = getPrecedenceMeta(v.sourceKind);
    return {
      name: v.name,
      value: v.value,
      rawValue: v.rawValue,
      precedenceLevel: meta.level,
      precedenceLabel: meta.label,
      sourceKind: v.sourceKind,
      uri: ast.uri,
      range: v.keyRange,
    };
  });
}

function convertReturnField(spec: ModuleReturnFieldSpec, docUrl: string): InferredReturnField {
  const children: Record<string, InferredReturnField> = {};
  if (spec.contains) {
    for (const [k, child] of Object.entries(spec.contains)) {
      children[k] = convertReturnField(child, `${docUrl}#return-${spec.name}/${k}`);
    }
  }
  return {
    name: spec.name,
    type: spec.type,
    description: spec.description,
    returned: spec.returned,
    docUrl: `${docUrl}#return-${spec.name}`,
    ...(spec.sample !== undefined ? { sample: spec.sample } : {}),
    ...(Object.keys(children).length > 0 ? { children } : {}),
  };
}

/**
 * Collects all tasks across an AST (plays + standalone tasks + handlers).
 */
export function collectAllTasks(ast: AnsibleDocumentAst): readonly TaskNode[] {
  const result: TaskNode[] = [];
  for (const play of ast.plays) {
    result.push(...play.preTasks, ...play.tasks, ...play.postTasks, ...play.handlers);
  }
  result.push(...ast.tasks, ...ast.handlers);
  return result;
}

/**
 * Fallback inference for `register:` variables when core's `inferRegisteredVariables`
 * returns an empty map in this worktree.
 */
export function inferRegisteredVariablesFallback(
  ast: AnsibleDocumentAst,
  registry: IMetadataRegistry,
): ReadonlyMap<string, InferredRegisteredVariable> {
  const result = new Map<string, InferredRegisteredVariable>();
  for (const task of collectAllTasks(ast)) {
    if (!task.register || !task.registerRange) {
      continue;
    }
    const mod = registry.getModule(task.moduleName);
    const fields: Record<string, InferredReturnField> = {
      changed: {
        name: 'changed',
        type: 'bool',
        description: 'Whether the task made changes on the target.',
        returned: 'always',
        sample: true,
      },
      failed: {
        name: 'failed',
        type: 'bool',
        description: 'Whether the task failed.',
        returned: 'always',
        sample: false,
      },
      skipped: {
        name: 'skipped',
        type: 'bool',
        description: 'Whether the task was skipped.',
        returned: 'always',
        sample: false,
      },
    };
    if (mod) {
      for (const [key, spec] of Object.entries(mod.returnFields)) {
        fields[key] = convertReturnField(spec, mod.docUrl);
      }
    }
    if (task.loop !== undefined) {
      fields['results'] = {
        name: 'results',
        type: 'list',
        description: 'List of iteration result objects when the task uses loop/with_*.',
        returned: 'when loop is used',
        ...(mod ? { docUrl: mod.docUrl } : {}),
      };
    }

    result.set(task.register, {
      name: task.register,
      ...(task.name !== undefined ? { taskName: task.name } : {}),
      moduleFqcn: mod?.fqcn ?? task.moduleName,
      uri: ast.uri,
      range: task.registerRange,
      isLoop: task.loop !== undefined,
      fields,
    });
  }
  return result;
}

/**
 * Clean-room fallback linter when `@ansible-lens/core`'s `lintAnsibleDocument`
 * returns empty in an isolated worktree.
 */
export function fallbackLintDocument(
  ast: AnsibleDocumentAst,
  registry: IMetadataRegistry,
): readonly LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  for (const task of collectAllTasks(ast)) {
    if (!task.name) {
      diagnostics.push({
        ruleId: 'name-missing',
        message: 'Task is missing a descriptive "name:" attribute.',
        severity: 'warning',
        range: task.moduleRange,
        docUrl: 'https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_intro.html',
        quickFixes: [],
      });
    }

    const resolvedMod = registry.getModule(task.moduleName);
    if (!task.isFqcn && resolvedMod) {
      diagnostics.push({
        ruleId: 'fqcn',
        message: `Use FQCN "${resolvedMod.fqcn}" instead of short module name "${task.moduleName}".`,
        severity: 'warning',
        range: task.moduleRange,
        docUrl: resolvedMod.docUrl,
        quickFixes: [
          {
            title: `Replace "${task.moduleName}" with "${resolvedMod.fqcn}"`,
            ruleId: 'fqcn',
            isPreferred: true,
            edits: [
              {
                range: task.moduleRange,
                newText: resolvedMod.fqcn,
              },
            ],
          },
        ],
      });
    }

    if (
      resolvedMod &&
      (resolvedMod.fqcn === 'ansible.builtin.command' ||
        resolvedMod.fqcn === 'ansible.builtin.shell') &&
      task.changedWhen === undefined
    ) {
      diagnostics.push({
        ruleId: 'no-changed-when',
        message: `Task using "${resolvedMod.fqcn}" should specify "changed_when" for idempotency.`,
        severity: 'warning',
        range: task.moduleRange,
        docUrl: resolvedMod.docUrl,
        quickFixes: [],
      });
    }

    if (resolvedMod) {
      const providedParams = new Set(task.params.map((p) => p.name));
      for (const param of task.params) {
        const option = findModuleOption(resolvedMod.options, param.name);
        if (!option) {
          diagnostics.push({
            ruleId: 'unknown-param',
            message: `Unknown parameter "${param.name}" for module "${resolvedMod.fqcn}".`,
            severity: 'error',
            range: param.keyRange,
            docUrl: resolvedMod.docUrl,
            quickFixes: [],
          });
          continue;
        }
        if (option.choices && option.choices.length > 0 && typeof param.value === 'string') {
          const valStr = param.value;
          if (!valStr.includes('{{') && !option.choices.map(String).includes(valStr)) {
            diagnostics.push({
              ruleId: 'invalid-choice',
              message: `Invalid choice "${valStr}" for "${param.name}". Expected one of: ${option.choices.join(', ')}.`,
              severity: 'error',
              range: param.valueRange,
              docUrl: `${resolvedMod.docUrl}#parameter-${option.name}`,
              quickFixes: [],
            });
          }
        }
      }

      for (const [optName, optSpec] of Object.entries(resolvedMod.options)) {
        if (optSpec.required) {
          const hasMainOrAlias =
            providedParams.has(optName) ||
            (optSpec.aliases?.some((a) => providedParams.has(a)) ?? false);
          if (!hasMainOrAlias) {
            diagnostics.push({
              ruleId: 'missing-required-param',
              message: `Missing required parameter "${optName}" for module "${resolvedMod.fqcn}".`,
              severity: 'error',
              range: task.moduleRange,
              docUrl: `${resolvedMod.docUrl}#parameter-${optName}`,
              quickFixes: [],
            });
          }
        }
      }
    }
  }
  return diagnostics;
}

function findModuleOption(
  options: Readonly<
    Record<
      string,
      {
        readonly name: string;
        readonly choices?: readonly (string | number | boolean)[];
        readonly aliases?: readonly string[];
      }
    >
  >,
  paramName: string,
) {
  const direct = options[paramName];
  if (direct) {
    return direct;
  }
  for (const spec of Object.values(options)) {
    if (spec.aliases?.includes(paramName)) {
      return spec;
    }
  }
  return undefined;
}
