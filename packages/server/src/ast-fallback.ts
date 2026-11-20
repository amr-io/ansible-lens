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
  const normalizedPath = uriToFsPath(uri).replace(/\\/g, '/').toLowerCase();

  // Explicit negative guards for non-Ansible YAML formats
  const hasK8s = /(?:^|\n)\s*apiVersion\s*:/m.test(text) && /(?:^|\n)\s*kind\s*:/m.test(text);
  if (hasK8s) {
    return {
      isAnsible: false,
      kind: 'unknown',
      reason: 'Excluded Kubernetes manifest (apiVersion + kind)',
    };
  }

  const hasDockerCompose =
    /(?:^|\n)\s*services\s*:/m.test(text) &&
    (/(?:^|\n)\s*(?:volumes|networks|version)\s*:/m.test(text) ||
      normalizedPath.endsWith('docker-compose.yml') ||
      normalizedPath.endsWith('docker-compose.yaml') ||
      normalizedPath.endsWith('compose.yml') ||
      normalizedPath.endsWith('compose.yaml'));
  if (hasDockerCompose) {
    return {
      isAnsible: false,
      kind: 'unknown',
      reason: 'Excluded Docker Compose manifest (services)',
    };
  }

  const hasGitHubActions =
    /(?:^|\n)\s*on\s*:/m.test(text) &&
    /(?:^|\n)\s*jobs\s*:/m.test(text) &&
    (/(?:^|\n)\s*(?:runs-on|steps|uses)\s*:/m.test(text) ||
      normalizedPath.includes('/.github/workflows/'));
  if (hasGitHubActions) {
    return {
      isAnsible: false,
      kind: 'unknown',
      reason: 'Excluded GitHub Actions workflow (on + jobs)',
    };
  }

  // Ask core first
  const coreResult = detectAnsibleDocument(uri, text, hasWorkspaceAnsibleCfg);

  const kindFromPath = inferKindFromPath(normalizedPath);
  if (kindFromPath !== 'unknown') {
    return {
      isAnsible: true,
      kind: kindFromPath,
      reason: `Matched Ansible path convention (${kindFromPath})`,
    };
  }

  // Content heuristics for playbooks & task lists
  const isPlaybookContent =
    /(?:^|\n)\s*-\s*(?:name\s*:|hosts\s*:)/m.test(text) &&
    /(?:^|\n)\s*(?:hosts|tasks|pre_tasks|post_tasks|roles|handlers)\s*:/m.test(text);
  if (isPlaybookContent) {
    return {
      isAnsible: true,
      kind: 'playbook',
      reason: 'Matched Ansible playbook structure (hosts/tasks/roles)',
    };
  }

  const isTaskListContent =
    /(?:^|\n)\s*-\s*name\s*:/m.test(text) &&
    /(?:^|\n)\s*(?:ansible\.builtin\.|register\s*:|when\s*:|notify\s*:|become\s*:)/m.test(text);
  if (isTaskListContent) {
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
    const inferred = inferPlayOrVarKind(text);
    return {
      isAnsible: true,
      kind: inferred,
      reason: 'Workspace contains ansible.cfg and document is YAML',
    };
  }

  return coreResult;
}

function inferKindFromPath(normalizedPath: string): AnsibleDocumentKind {
  if (
    /\/roles\/[^/]+\/tasks\/.*\.ya?ml$/.test(normalizedPath) ||
    /\/tasks\/[^/]+\.ya?ml$/.test(normalizedPath)
  ) {
    return 'tasks';
  }
  if (
    /\/roles\/[^/]+\/handlers\/.*\.ya?ml$/.test(normalizedPath) ||
    /\/handlers\/[^/]+\.ya?ml$/.test(normalizedPath)
  ) {
    return 'handlers';
  }
  if (/\/roles\/[^/]+\/defaults\/.*\.ya?ml$/.test(normalizedPath)) {
    return 'role-defaults';
  }
  if (/\/roles\/[^/]+\/vars\/.*\.ya?ml$/.test(normalizedPath)) {
    return 'role-vars';
  }
  if (
    /\/group_vars\/[^/]+\.ya?ml$/.test(normalizedPath) ||
    /\/group_vars\/[^/]+\//.test(normalizedPath)
  ) {
    return 'group-vars';
  }
  if (
    /\/host_vars\/[^/]+\.ya?ml$/.test(normalizedPath) ||
    /\/host_vars\/[^/]+\//.test(normalizedPath)
  ) {
    return 'host-vars';
  }
  const base = path.posix.basename(normalizedPath);
  if (
    base === 'site.yml' ||
    base === 'site.yaml' ||
    base === 'playbook.yml' ||
    base === 'playbook.yaml' ||
    (base === 'main.yml' && /\/playbooks\//.test(normalizedPath)) ||
    /\/playbooks\/[^/]+\.ya?ml$/.test(normalizedPath)
  ) {
    return 'playbook';
  }
  if (
    base === 'hosts.ini' ||
    base === 'inventory.ini' ||
    /\/inventory\/[^/]+\.ya?ml$/.test(normalizedPath)
  ) {
    return 'inventory';
  }
  return 'unknown';
}

function inferPlayOrVarKind(text: string): AnsibleDocumentKind {
  if (/(?:^|\n)\s*-\s*hosts\s*:/m.test(text) || /(?:^|\n)\s*hosts\s*:/m.test(text)) {
    return 'playbook';
  }
  if (/(?:^|\n)\s*-\s*name\s*:/m.test(text)) {
    return 'tasks';
  }
  return 'unknown';
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
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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
  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }
  return stripQuotes(trimmed);
}

/**
 * Ensures we always have a populated `AnsibleDocumentAst` even when `@ansible-lens/core`'s
 * `parseAnsibleDocument` is still a stub in an isolated worktree.
 */
export function parseDocumentWithFallback(
  uri: string,
  text: string,
  kindHint?: AnsibleDocumentKind,
  registry?: IMetadataRegistry,
): AnsibleDocumentAst {
  const coreAst = parseAnsibleDocument(uri, text, kindHint);
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

function fallbackExtractAst(
  uri: string,
  text: string,
  kind: AnsibleDocumentKind,
  registry?: IMetadataRegistry,
): AnsibleDocumentAst {
  const normalizedPath = uriToFsPath(uri).replace(/\\/g, '/').toLowerCase();
  const effectiveKind = kind !== 'unknown' ? kind : inferKindFromPath(normalizedPath);
  const lines = text.split(/\r?\n/);
  const lineStarts = computeLineStarts(text);

  const plays: PlayNode[] = [];
  const topTasks: TaskNode[] = [];
  const topHandlers: TaskNode[] = [];
  const variables: VariableDeclNode[] = [];

  // Variable file extraction (group_vars, host_vars, role-defaults, role-vars)
  const varSourceKind = mapDocKindToVarSource(effectiveKind, normalizedPath);
  if (
    effectiveKind === 'group-vars' ||
    effectiveKind === 'host-vars' ||
    effectiveKind === 'role-defaults' ||
    effectiveKind === 'role-vars'
  ) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (/^\s*(?:#|---|\.\.\.|\s*$)/.test(line)) {
        continue;
      }
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
      if (match) {
        const key = match[1] ?? '';
        const rawVal = (match[2] ?? '').trim();
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
    if (/^\s*(?:#.*|---|\.\.\.)?\s*$/.test(line)) {
      continue;
    }

    const leadingSpaces = /^(\s*)/.exec(line)?.[1]?.length ?? 0;

    // Play start at indent 0 (`- name:` or `- hosts:`) when in playbook mode or has hosts:
    const dashMatch = /^(\s*)-\s+(.*)$/.exec(line);
    if (dashMatch) {
      const indent = (dashMatch[1] ?? '').length;
      const rest = dashMatch[2] ?? '';

      // Top-level play item
      if (
        indent === 0 &&
        (effectiveKind === 'playbook' ||
          /^hosts\s*:/.test(rest) ||
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
        const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(rest);
        if (kv) {
          const key = kv[1] ?? '';
          const val = (kv[2] ?? '').trim();
          if (key === 'name') {
            currentPlay.name = stripQuotes(val);
          } else if (key === 'hosts') {
            currentPlay.hosts = stripQuotes(val);
            const col = line.indexOf(val, line.indexOf(':') + 1);
            currentPlay.hostsRange = makeRange(i, Math.max(0, col), line.length, lineStarts);
          }
        }
        continue;
      }

      // List item inside vars_files
      if (currentPlay && playSection === 'vars_files' && indent >= 2) {
        const val = stripQuotes(rest);
        const col = line.indexOf(rest);
        currentPlay.varsFiles.push({
          path: val,
          range: makeRange(i, col, line.length, lineStarts),
        });
        continue;
      }

      // List item inside roles
      if (
        currentPlay &&
        playSection === 'roles' &&
        indent >= 2 &&
        !/^(?:tasks|handlers|pre_tasks|post_tasks|vars|vars_files)\s*:/.test(rest)
      ) {
        const roleKv = /^role\s*:\s*(.+)$/.exec(rest);
        const roleName = stripQuotes(roleKv ? (roleKv[1] ?? '') : rest);
        const col = line.indexOf(roleName);
        if (roleName && !roleName.includes(':')) {
          currentPlay.roles.push({
            name: roleName,
            range: makeRange(i, Math.max(0, col), Math.max(0, col) + roleName.length, lineStarts),
          });
        }
        continue;
      }

      // List item inside notify:
      if (currentTask && inNotifyList && indent > currentTask.indent) {
        currentTask.endLine = i;
        currentTask.notify = currentTask.notify ?? [];
        currentTask.notify.push(stripQuotes(rest));
        continue;
      }

      // List item inside loop:
      if (currentTask && inLoopList && indent > currentTask.indent) {
        currentTask.endLine = i;
        const arr = Array.isArray(currentTask.loop) ? currentTask.loop : [];
        arr.push(parseScalarValue(rest));
        currentTask.loop = arr;
        continue;
      }

      // Task entry (`- name: ...` or `- ansible.builtin.xxx: ...`)
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
        const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(rest);
        if (kv) {
          const key = kv[1] ?? '';
          const val = (kv[2] ?? '').trim();
          const keyCol = line.indexOf(key, indent);
          applyTaskKeyValue(currentTask, key, val, i, keyCol, line, lineStarts, registry);
          if (!TASK_LEVEL_NON_MODULE_KEYS.has(key) && isLikelyModuleKey(key, registry)) {
            activeModuleKeyIndent = indent + 2;
          }
        }
        continue;
      }
    }

    // Play-level section header or key-value
    if (currentPlay && leadingSpaces <= 4 && !currentTask) {
      const kv = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) {
        const key = kv[1] ?? '';
        const val = (kv[2] ?? '').trim();
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
    }

    // Play-level section switch even if currentTask was active
    if (currentPlay && leadingSpaces <= 2) {
      const secMatch =
        /^\s*(vars|vars_files|roles|pre_tasks|tasks|post_tasks|handlers)\s*:\s*$/.exec(line);
      if (secMatch) {
        flushTask();
        const sec = secMatch[1] as PlaySection;
        playSection = sec;
        continue;
      }
    }

    // Play-level vars entries
    if (currentPlay && playSection === 'vars' && leadingSpaces >= 4) {
      const varKv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
      if (varKv) {
        const key = varKv[1] ?? '';
        const rawVal = (varKv[2] ?? '').trim();
        const keyCol = line.indexOf(key);
        const valCol =
          rawVal.length > 0 ? line.indexOf(rawVal, line.indexOf(':') + 1) : line.length;
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
    }

    // Inside a task
    if (currentTask) {
      currentTask.endLine = i;
      const kv = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) {
        const key = kv[1] ?? '';
        const rawVal = (kv[2] ?? '').trim();
        const keyCol = line.indexOf(key);

        if (activeModuleKeyIndent >= 0 && leadingSpaces > activeModuleKeyIndent) {
          // Parameter of the active module!
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

        // Task-level key
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
    if (/^\s*(?:hosts|tasks|pre_tasks|post_tasks|roles|handlers)\s*:/.test(line)) {
      return true;
    }
    if (i > startIdx && /^-\s+/.test(line)) {
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
 * returns empty in this isolated worktree, ensuring FQCN, unknown-param,
 * missing-required-param, invalid-choice, name-missing, and no-changed-when
 * diagnostics & Quick-Fixes work deterministically.
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
