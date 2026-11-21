import type {
  AnsibleDocumentAst,
  IMetadataRegistry,
  LintDiagnostic,
  ModuleMetadataSpec,
  ModuleOptionSpec,
  ModuleOptionType,
  QuickFixAction,
  SourceRange,
  TaskNode,
  TaskParamNode,
} from '../contracts/types.js';
import { findClosestMatch } from '../intelligence/similarity.js';

const DEFAULT_FQCN_MAP: Readonly<Record<string, string>> = {
  apt: 'ansible.builtin.apt',
  assert: 'ansible.builtin.assert',
  blockinfile: 'ansible.builtin.blockinfile',
  command: 'ansible.builtin.command',
  copy: 'ansible.builtin.copy',
  cron: 'ansible.builtin.cron',
  debug: 'ansible.builtin.debug',
  dnf: 'ansible.builtin.dnf',
  fail: 'ansible.builtin.fail',
  fetch: 'ansible.builtin.fetch',
  file: 'ansible.builtin.file',
  find: 'ansible.builtin.find',
  get_url: 'ansible.builtin.get_url',
  git: 'ansible.builtin.git',
  group: 'ansible.builtin.group',
  import_playbook: 'ansible.builtin.import_playbook',
  import_role: 'ansible.builtin.import_role',
  import_tasks: 'ansible.builtin.import_tasks',
  include_role: 'ansible.builtin.include_role',
  include_tasks: 'ansible.builtin.include_tasks',
  include_vars: 'ansible.builtin.include_vars',
  lineinfile: 'ansible.builtin.lineinfile',
  meta: 'ansible.builtin.meta',
  package: 'ansible.builtin.package',
  pause: 'ansible.builtin.pause',
  ping: 'ansible.builtin.ping',
  raw: 'ansible.builtin.raw',
  replace: 'ansible.builtin.replace',
  script: 'ansible.builtin.script',
  service: 'ansible.builtin.service',
  set_fact: 'ansible.builtin.set_fact',
  setup: 'ansible.builtin.setup',
  shell: 'ansible.builtin.shell',
  slurp: 'ansible.builtin.slurp',
  stat: 'ansible.builtin.stat',
  systemd: 'ansible.builtin.systemd',
  systemd_service: 'ansible.builtin.systemd_service',
  tempfile: 'ansible.builtin.tempfile',
  template: 'ansible.builtin.template',
  unarchive: 'ansible.builtin.unarchive',
  uri: 'ansible.builtin.uri',
  user: 'ansible.builtin.user',
  wait_for: 'ansible.builtin.wait_for',
  yum: 'ansible.builtin.yum',
};

const COMMAND_MODULES = new Set([
  'command',
  'ansible.builtin.command',
  'shell',
  'ansible.builtin.shell',
  'raw',
  'ansible.builtin.raw',
]);

const PACKAGE_MODULES = new Set([
  'apt',
  'ansible.builtin.apt',
  'yum',
  'ansible.builtin.yum',
  'dnf',
  'ansible.builtin.dnf',
  'package',
  'ansible.builtin.package',
  'pip',
  'ansible.builtin.pip',
  'apk',
  'community.general.apk',
]);

const FILE_PERMISSION_MODULES = new Set([
  'file',
  'ansible.builtin.file',
  'copy',
  'ansible.builtin.copy',
  'template',
  'ansible.builtin.template',
  'lineinfile',
  'ansible.builtin.lineinfile',
]);

interface CommandReplacementRule {
  readonly pattern: RegExp;
  readonly suggestedModule: string;
  readonly reason: string;
}

const COMMAND_REPLACEMENTS: readonly CommandReplacementRule[] = [
  {
    pattern: /^\s*(?:\/usr\/bin\/|\/bin\/)?git\b/i,
    suggestedModule: 'ansible.builtin.git',
    reason: 'Use the idempotent git module instead of running git via command/shell.',
  },
  {
    pattern: /^\s*(?:\/usr\/bin\/|\/bin\/)?(?:curl|wget)\b/i,
    suggestedModule: 'ansible.builtin.get_url',
    reason: 'Use ansible.builtin.get_url or ansible.builtin.uri instead of curl/wget.',
  },
  {
    pattern: /^\s*(?:\/usr\/bin\/|\/bin\/)?(?:apt-get|apt)\b/i,
    suggestedModule: 'ansible.builtin.apt',
    reason: 'Use ansible.builtin.apt instead of invoking apt/apt-get directly.',
  },
  {
    pattern: /^\s*(?:\/usr\/bin\/|\/bin\/)?(?:yum|dnf)\b/i,
    suggestedModule: 'ansible.builtin.dnf',
    reason: 'Use ansible.builtin.dnf or ansible.builtin.yum instead of shell package commands.',
  },
  {
    pattern: /^\s*(?:\/usr\/bin\/|\/bin\/)?(?:systemctl|service)\b/i,
    suggestedModule: 'ansible.builtin.service',
    reason: 'Use ansible.builtin.service or ansible.builtin.systemd instead of systemctl/service.',
  },
  {
    pattern: /^\s*(?:\/usr\/bin\/|\/bin\/)?(?:mkdir|chmod|chown)\b/i,
    suggestedModule: 'ansible.builtin.file',
    reason:
      'Use ansible.builtin.file to manage directories, permissions, and ownership declaratively.',
  },
  {
    pattern: /^\s*(?:\/usr\/bin\/|\/bin\/)?(?:tar|unzip)\b/i,
    suggestedModule: 'ansible.builtin.unarchive',
    reason: 'Use ansible.builtin.unarchive instead of tar/unzip.',
  },
];

const SECRET_PARAM_PATTERN =
  /(?:password|passwd|secret|token|api_?key|private_?key|auth_?token|access_?key|secret_?key|passphrase)/i;

const SECRET_EXEMPT_PARAM_NAMES = new Set([
  'password_lock',
  'password_expire_max',
  'password_expire_min',
  'update_password',
  'secret_type',
  'key_file',
  'private_key_file',
]);

const TRUTHY_REPLACEMENTS: Readonly<Record<string, string>> = {
  yes: 'true',
  Yes: 'true',
  YES: 'true',
  on: 'true',
  On: 'true',
  ON: 'true',
  TRUE: 'true',
  True: 'true',
  no: 'false',
  No: 'false',
  NO: 'false',
  off: 'false',
  Off: 'false',
  OFF: 'false',
  FALSE: 'false',
  False: 'false',
};

function shortModuleName(moduleName: string): string {
  const idx = moduleName.lastIndexOf('.');
  return idx === -1 ? moduleName : moduleName.slice(idx + 1);
}

function containsJinja(value: string): boolean {
  return value.includes('{{') || value.includes('{%');
}

function isDynamicParamValue(param: TaskParamNode): boolean {
  if (param.jinjaBlocks.length > 0) {
    return true;
  }
  return typeof param.value === 'string' && containsJinja(param.value);
}

function isVaultEncrypted(rawText: string, value: unknown): boolean {
  if (rawText.includes('!vault')) {
    return true;
  }
  return typeof value === 'string' && value.includes('$ANSIBLE_VAULT;');
}

function collectAllTasks(ast: AnsibleDocumentAst): readonly TaskNode[] {
  const tasks: TaskNode[] = [];
  const seenOffsets = new Set<number>();

  const pushTask = (task: TaskNode): void => {
    if (seenOffsets.has(task.range.start.offset)) {
      return;
    }
    seenOffsets.add(task.range.start.offset);
    tasks.push(task);
  };

  for (const task of ast.tasks) {
    pushTask(task);
  }
  for (const handler of ast.handlers) {
    pushTask(handler);
  }
  for (const play of ast.plays) {
    for (const task of play.preTasks) {
      pushTask(task);
    }
    for (const task of play.tasks) {
      pushTask(task);
    }
    for (const task of play.postTasks) {
      pushTask(task);
    }
    for (const handler of play.handlers) {
      pushTask(handler);
    }
  }

  return tasks;
}

const optionLookupCache = new WeakMap<
  Readonly<Record<string, ModuleOptionSpec>>,
  ReadonlyMap<string, ModuleOptionSpec>
>();

function buildOptionLookup(
  options: Readonly<Record<string, ModuleOptionSpec>>,
): ReadonlyMap<string, ModuleOptionSpec> {
  const cached = optionLookupCache.get(options);
  if (cached) {
    return cached;
  }
  const map = new Map<string, ModuleOptionSpec>();
  for (const [key, spec] of Object.entries(options)) {
    map.set(key, spec);
    if (spec.name !== key) {
      map.set(spec.name, spec);
    }
    if (spec.aliases) {
      for (const alias of spec.aliases) {
        map.set(alias, spec);
      }
    }
  }
  optionLookupCache.set(options, map);
  return map;
}

function collectOptionNamesAndAliases(
  options: Readonly<Record<string, ModuleOptionSpec>>,
): readonly string[] {
  const names = new Set<string>();
  for (const [key, spec] of Object.entries(options)) {
    names.add(key);
    names.add(spec.name);
    if (spec.aliases) {
      for (const alias of spec.aliases) {
        names.add(alias);
      }
    }
  }
  return Array.from(names);
}

function isOptionPresent(
  spec: ModuleOptionSpec,
  canonicalKey: string,
  presentNames: ReadonlySet<string>,
): boolean {
  if (presentNames.has(canonicalKey) || presentNames.has(spec.name)) {
    return true;
  }
  if (spec.aliases) {
    for (const alias of spec.aliases) {
      if (presentNames.has(alias)) {
        return true;
      }
    }
  }
  return false;
}

function matchesOptionType(value: unknown, expectedType: ModuleOptionType): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  switch (expectedType) {
    case 'int':
      return typeof value === 'number' && Number.isInteger(value);
    case 'float':
      return typeof value === 'number' && Number.isFinite(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'list':
      return Array.isArray(value);
    case 'dict':
      return typeof value === 'object' && !Array.isArray(value);
    case 'str':
    case 'path':
    case 'raw':
    case 'jsonarg':
    case 'sid':
    case 'bits':
    case 'bytes':
      return true;
  }
}

function describeActualType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'list';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'int' : 'float';
  }
  if (typeof value === 'boolean') {
    return 'bool';
  }
  if (typeof value === 'object') {
    return 'dict';
  }
  return typeof value;
}

function validateTaskParams(
  task: TaskNode,
  params: readonly TaskParamNode[],
  options: Readonly<Record<string, ModuleOptionSpec>>,
  moduleDocUrl: string | undefined,
  parentRange: SourceRange,
  diagnostics: LintDiagnostic[],
): void {
  const optionLookup = buildOptionLookup(options);
  let allCandidateNames: readonly string[] | undefined;
  const presentNames = new Set(params.map((p) => p.name));

  for (const [optKey, optSpec] of Object.entries(options)) {
    if (optSpec.required === true && !isOptionPresent(optSpec, optKey, presentNames)) {
      diagnostics.push({
        ruleId: 'missing-required-param',
        message: `Missing required parameter '${optSpec.name}' for module '${task.moduleName}'.`,
        severity: 'error',
        range: parentRange,
        ...(moduleDocUrl ? { docUrl: moduleDocUrl } : {}),
        quickFixes: [],
      });
    }
  }

  for (const param of params) {
    // Skip Ansible meta/task keywords if they appear inside params
    if (param.name === 'free_form' || param.name === '_raw_params') {
      continue;
    }

    const spec = optionLookup.get(param.name);
    if (!spec) {
      allCandidateNames ??= collectOptionNamesAndAliases(options);
      const closest = findClosestMatch(param.name, allCandidateNames);
      const quickFixes: QuickFixAction[] = closest
        ? [
            {
              title: `Replace with '${closest}'`,
              ruleId: 'unknown-param',
              isPreferred: true,
              edits: [{ range: param.keyRange, newText: closest }],
            },
          ]
        : [];
      const hint = closest ? ` Did you mean '${closest}'?` : '';
      diagnostics.push({
        ruleId: 'unknown-param',
        message: `Unknown parameter '${param.name}' for module '${task.moduleName}'.${hint}`,
        severity: 'error',
        range: param.keyRange,
        ...(moduleDocUrl ? { docUrl: moduleDocUrl } : {}),
        quickFixes,
      });
      continue;
    }

    const isDynamic = isDynamicParamValue(param);
    if (!isDynamic && spec.choices && spec.choices.length > 0 && param.value !== undefined) {
      const choiceMatched = spec.choices.some((c) => c === param.value);
      if (!choiceMatched) {
        const stringValue = String(param.value);
        const stringChoices = spec.choices.map((c) => String(c));
        const closestChoice = findClosestMatch(stringValue, stringChoices);
        const quickFixes: QuickFixAction[] = closestChoice
          ? [
              {
                title: `Replace with '${closestChoice}'`,
                ruleId: 'invalid-choice',
                isPreferred: true,
                edits: [{ range: param.valueRange, newText: closestChoice }],
              },
            ]
          : [];
        diagnostics.push({
          ruleId: 'invalid-choice',
          message: `Invalid value '${stringValue}' for parameter '${param.name}'. Valid choices: ${stringChoices.join(', ')}.`,
          severity: 'error',
          range: param.valueRange,
          ...(moduleDocUrl ? { docUrl: moduleDocUrl } : {}),
          quickFixes,
        });
      }
    }

    if (!isDynamic && param.value !== undefined && !matchesOptionType(param.value, spec.type)) {
      diagnostics.push({
        ruleId: 'param-type-mismatch',
        message: `Parameter '${param.name}' expects type '${spec.type}', but got '${describeActualType(param.value)}'.`,
        severity: 'warning',
        range: param.valueRange,
        ...(moduleDocUrl ? { docUrl: moduleDocUrl } : {}),
        quickFixes: [],
      });
    }

    if (spec.suboptions && param.suboptions && param.suboptions.length > 0) {
      validateTaskParams(
        task,
        param.suboptions,
        spec.suboptions,
        moduleDocUrl,
        param.valueRange,
        diagnostics,
      );
    }
  }
}

function getCommandText(task: TaskNode): string | undefined {
  if (task.freeFormArg !== undefined && task.freeFormArg.trim().length > 0) {
    return task.freeFormArg.trim();
  }
  const cmdParam = task.params.find((p) => p.name === 'cmd' || p.name === '_raw_params');
  if (cmdParam && typeof cmdParam.value === 'string') {
    return cmdParam.value.trim();
  }
  return undefined;
}

function lintSyntaxAndYamlBasics(
  ast: AnsibleDocumentAst,
  tasks: readonly TaskNode[],
  diagnostics: LintDiagnostic[],
): void {
  for (const err of ast.syntaxErrors) {
    diagnostics.push({
      ruleId: 'yaml-syntax',
      message: err.message,
      severity: 'error',
      range: err.range,
      quickFixes: [],
    });
  }

  const seenDuplicateOffsets = new Set<string>();
  for (const dup of ast.duplicateKeys) {
    const key = `${dup.key}@${dup.range.start.offset}`;
    seenDuplicateOffsets.add(key);
    diagnostics.push({
      ruleId: 'duplicate-keys',
      message: `Duplicate YAML mapping key '${dup.key}'.`,
      severity: 'error',
      range: dup.range,
      quickFixes: [],
    });
  }
  for (const task of tasks) {
    for (const dup of task.duplicateKeys) {
      const key = `${dup.key}@${dup.range.start.offset}`;
      if (seenDuplicateOffsets.has(key)) {
        continue;
      }
      seenDuplicateOffsets.add(key);
      diagnostics.push({
        ruleId: 'duplicate-keys',
        message: `Duplicate YAML mapping key '${dup.key}'.`,
        severity: 'error',
        range: dup.range,
        quickFixes: [],
      });
    }
  }

  const seenTruthyOffsets = new Set<number>();
  const emitTruthy = (rawValue: string, range: SourceRange): void => {
    if (seenTruthyOffsets.has(range.start.offset)) {
      return;
    }
    seenTruthyOffsets.add(range.start.offset);
    const normalized = TRUTHY_REPLACEMENTS[rawValue];
    const quickFixes: QuickFixAction[] = normalized
      ? [
          {
            title: `Replace '${rawValue}' with '${normalized}'`,
            ruleId: 'yaml-truthy',
            isPreferred: true,
            edits: [{ range, newText: normalized }],
          },
        ]
      : [];
    diagnostics.push({
      ruleId: 'yaml-truthy',
      message: `Non-standard YAML truthy value '${rawValue}'. Use 'true' or 'false' instead.`,
      severity: 'warning',
      range,
      quickFixes,
    });
  };

  for (const truthy of ast.rawTruthyValues) {
    emitTruthy(truthy.rawValue, truthy.range);
  }
  for (const task of tasks) {
    for (const truthy of task.rawTruthyKeys) {
      emitTruthy(truthy.rawValue, truthy.range);
    }
  }
}

function buildNoChangedWhenQuickFix(task: TaskNode): QuickFixAction | undefined {
  const indent = ' '.repeat(task.moduleRange.start.column);
  const insertPos = {
    line: task.moduleRange.start.line,
    column: task.moduleRange.start.column,
    offset: task.moduleRange.start.offset,
  };
  return {
    title: 'Add changed_when: false',
    ruleId: 'no-changed-when',
    isPreferred: false,
    edits: [
      {
        range: { start: insertPos, end: insertPos },
        newText: `changed_when: false\n${indent}`,
      },
    ],
  };
}

function buildNoLogQuickFix(task: TaskNode): QuickFixAction {
  const indent = ' '.repeat(task.moduleRange.start.column);
  const insertPos = {
    line: task.moduleRange.start.line,
    column: task.moduleRange.start.column,
    offset: task.moduleRange.start.offset,
  };
  return {
    title: 'Add no_log: true to task',
    ruleId: 'hardcoded-secret',
    isPreferred: false,
    edits: [
      {
        range: { start: insertPos, end: insertPos },
        newText: `no_log: true\n${indent}`,
      },
    ],
  };
}

function checkHardcodedSecrets(
  ast: AnsibleDocumentAst,
  tasks: readonly TaskNode[],
  diagnostics: LintDiagnostic[],
): void {
  for (const task of tasks) {
    if (task.noLog === true) {
      continue;
    }

    for (const param of task.params) {
      if (SECRET_EXEMPT_PARAM_NAMES.has(param.name)) {
        continue;
      }
      if (!SECRET_PARAM_PATTERN.test(param.name)) {
        continue;
      }
      if (typeof param.value !== 'string' || param.value.trim().length === 0) {
        continue;
      }
      if (isDynamicParamValue(param) || isVaultEncrypted(param.rawText, param.value)) {
        continue;
      }

      const varPlaceholder = `vault_${param.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
      diagnostics.push({
        ruleId: 'hardcoded-secret',
        message: `Potential hardcoded secret in parameter '${param.name}'. Use Ansible Vault ('!vault') or a Jinja2 variable and/or set 'no_log: true'.`,
        severity: 'warning',
        range: param.valueRange,
        quickFixes: [
          {
            title: `Replace with Jinja2 variable '{{ ${varPlaceholder} }}'`,
            ruleId: 'hardcoded-secret',
            isPreferred: true,
            edits: [{ range: param.valueRange, newText: `'{{ ${varPlaceholder} }}'` }],
          },
          buildNoLogQuickFix(task),
        ],
      });
    }
  }

  for (const variable of ast.variables) {
    if (SECRET_EXEMPT_PARAM_NAMES.has(variable.name)) {
      continue;
    }
    if (!SECRET_PARAM_PATTERN.test(variable.name)) {
      continue;
    }
    if (typeof variable.value !== 'string' || variable.value.trim().length === 0) {
      continue;
    }
    if (containsJinja(variable.value) || isVaultEncrypted(variable.rawValue, variable.value)) {
      continue;
    }
    const varPlaceholder = `vault_${variable.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
    diagnostics.push({
      ruleId: 'hardcoded-secret',
      message: `Potential hardcoded secret in variable '${variable.name}'. Encrypt with Ansible Vault ('!vault') or reference a vault variable.`,
      severity: 'warning',
      range: variable.valueRange,
      quickFixes: [
        {
          title: `Replace with Jinja2 variable '{{ ${varPlaceholder} }}'`,
          ruleId: 'hardcoded-secret',
          isPreferred: true,
          edits: [{ range: variable.valueRange, newText: `'{{ ${varPlaceholder} }}'` }],
        },
      ],
    });
  }
}

function resolveCanonicalFqcn(
  moduleName: string,
  registry: IMetadataRegistry,
  moduleSpec: ModuleMetadataSpec | undefined,
): string | undefined {
  if (moduleSpec) {
    return moduleSpec.fqcn;
  }
  const matches = registry.resolveFqcn(moduleName);
  if (matches.length > 0 && matches[0]) {
    const builtin = matches.find((m) => m.collection === 'ansible.builtin');
    return (builtin ?? matches[0]).fqcn;
  }
  return DEFAULT_FQCN_MAP[moduleName];
}

function isLowerIdentifierSegment(seg: string): boolean {
  if (seg.length === 0) {
    return false;
  }
  const first = seg.charCodeAt(0);
  if (!((first >= 97 && first <= 122) || first === 95)) {
    return false;
  }
  for (let i = 1; i < seg.length; i++) {
    const c = seg.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) {
      return false;
    }
  }
  return true;
}

function parseValidFqcnCollection(moduleName: string): string | undefined {
  const parts = moduleName.split('.');
  if (parts.length < 3) {
    return undefined;
  }
  for (const part of parts) {
    if (!isLowerIdentifierSegment(part)) {
      return undefined;
    }
  }
  return `${parts[0]}.${parts[1]}`;
}

function lintTask(
  task: TaskNode,
  registry: IMetadataRegistry,
  knownModuleNames: readonly string[],
  loadedCollections: ReadonlySet<string>,
  diagnostics: LintDiagnostic[],
): void {
  // 1. name-missing
  if (task.name === undefined || task.name.trim().length === 0) {
    const indent = ' '.repeat(task.moduleRange.start.column);
    const insertPos = {
      line: task.range.start.line,
      column: task.range.start.column,
      offset: task.range.start.offset,
    };
    diagnostics.push({
      ruleId: 'name-missing',
      message: `Task invoking '${task.moduleName}' is missing a descriptive 'name:'.`,
      severity: 'warning',
      range: task.moduleRange,
      quickFixes: [
        {
          title: `Add 'name:' to task`,
          ruleId: 'name-missing',
          edits: [
            {
              range: { start: insertPos, end: insertPos },
              newText: `name: Run ${shortModuleName(task.moduleName)}\n${indent}`,
            },
          ],
        },
      ],
    });
  }

  // 2. Module lookup, unknown-module, deprecated-module, fqcn, params
  const moduleSpec = registry.getModule(task.moduleName);

  if (!moduleSpec && knownModuleNames.length > 0) {
    const fqcnCollection = parseValidFqcnCollection(task.moduleName);
    if (
      fqcnCollection !== undefined &&
      !loadedCollections.has(fqcnCollection) &&
      fqcnCollection !== 'ansible.builtin' &&
      fqcnCollection !== 'ansible.legacy'
    ) {
      diagnostics.push({
        ruleId: 'unknown-module',
        message: `Collection metadata not loaded for '${fqcnCollection}' (module '${task.moduleName}').`,
        severity: 'info',
        range: task.moduleRange,
        quickFixes: [],
      });
    } else {
      const closest = findClosestMatch(task.moduleName, knownModuleNames);
      const quickFixes: QuickFixAction[] = closest
        ? [
            {
              title: `Replace with '${closest}'`,
              ruleId: 'unknown-module',
              isPreferred: true,
              edits: [{ range: task.moduleRange, newText: closest }],
            },
          ]
        : [];
      const hint = closest ? ` Did you mean '${closest}'?` : '';
      diagnostics.push({
        ruleId: 'unknown-module',
        message: `Unknown Ansible module '${task.moduleName}'.${hint}`,
        severity: 'error',
        range: task.moduleRange,
        quickFixes,
      });
    }
  }

  if (moduleSpec?.deprecated) {
    const alt = moduleSpec.deprecated.alternative;
    const quickFixes: QuickFixAction[] = alt
      ? [
          {
            title: `Replace with '${alt}'`,
            ruleId: 'deprecated-module',
            isPreferred: true,
            edits: [{ range: task.moduleRange, newText: alt }],
          },
        ]
      : [];
    const removedInfo = moduleSpec.deprecated.removedIn
      ? ` (scheduled for removal in ${moduleSpec.deprecated.removedIn})`
      : '';
    const altInfo = alt ? ` Use '${alt}' instead.` : '';
    diagnostics.push({
      ruleId: 'deprecated-module',
      message: `Module '${moduleSpec.fqcn}' is deprecated${removedInfo}: ${moduleSpec.deprecated.why}.${altInfo}`,
      severity: 'warning',
      range: task.moduleRange,
      docUrl: moduleSpec.docUrl,
      quickFixes,
    });
  }

  if (!task.isFqcn) {
    const canonicalFqcn = resolveCanonicalFqcn(task.moduleName, registry, moduleSpec);
    const quickFixes: QuickFixAction[] = canonicalFqcn
      ? [
          {
            title: `Expand to FQCN '${canonicalFqcn}'`,
            ruleId: 'fqcn',
            isPreferred: true,
            edits: [{ range: task.moduleRange, newText: canonicalFqcn }],
          },
        ]
      : [];
    diagnostics.push({
      ruleId: 'fqcn',
      message: canonicalFqcn
        ? `Use Fully Qualified Collection Name '${canonicalFqcn}' instead of short name '${task.moduleName}'.`
        : `Use a Fully Qualified Collection Name (FQCN) instead of short module name '${task.moduleName}'.`,
      severity: 'warning',
      range: task.moduleRange,
      ...(moduleSpec ? { docUrl: moduleSpec.docUrl } : {}),
      quickFixes,
    });
  }

  if (moduleSpec) {
    validateTaskParams(
      task,
      task.params,
      moduleSpec.options,
      moduleSpec.docUrl,
      task.moduleRange,
      diagnostics,
    );
  }

  // 3. no-changed-when & command-instead-of-module
  if (COMMAND_MODULES.has(task.moduleName)) {
    const hasCreatesOrRemoves = task.params.some(
      (p) => p.name === 'creates' || p.name === 'removes',
    );
    if (task.changedWhen === undefined && !hasCreatesOrRemoves) {
      const qf = buildNoChangedWhenQuickFix(task);
      diagnostics.push({
        ruleId: 'no-changed-when',
        message: `Task using '${task.moduleName}' should define 'changed_when:' (or 'creates:'/'removes:') to ensure idempotency.`,
        severity: 'warning',
        range: task.moduleRange,
        ...(moduleSpec ? { docUrl: moduleSpec.docUrl } : {}),
        quickFixes: qf ? [qf] : [],
      });
    }

    const cmdText = getCommandText(task);
    if (cmdText !== undefined) {
      for (const rule of COMMAND_REPLACEMENTS) {
        if (rule.pattern.test(cmdText)) {
          diagnostics.push({
            ruleId: 'command-instead-of-module',
            message: `${rule.reason} (Consider '${rule.suggestedModule}'.)`,
            severity: 'warning',
            range: task.moduleRange,
            quickFixes: [
              {
                title: `Replace module with '${rule.suggestedModule}'`,
                ruleId: 'command-instead-of-module',
                edits: [{ range: task.moduleRange, newText: rule.suggestedModule }],
              },
            ],
          });
          break;
        }
      }
    }
  }

  // 4. package-latest
  if (PACKAGE_MODULES.has(task.moduleName)) {
    const stateParam = task.params.find((p) => p.name === 'state');
    if (stateParam && stateParam.value === 'latest') {
      diagnostics.push({
        ruleId: 'package-latest',
        message: `Package task '${task.moduleName}' uses 'state: latest', which can produce non-deterministic builds. Prefer 'state: present'.`,
        severity: 'warning',
        range: stateParam.valueRange,
        ...(moduleSpec ? { docUrl: moduleSpec.docUrl } : {}),
        quickFixes: [
          {
            title: `Replace 'latest' with 'present'`,
            ruleId: 'package-latest',
            isPreferred: true,
            edits: [{ range: stateParam.valueRange, newText: 'present' }],
          },
        ],
      });
    }
  }

  // 5. risky-file-permissions
  if (FILE_PERMISSION_MODULES.has(task.moduleName)) {
    const stateParam = task.params.find((p) => p.name === 'state');
    const isDeletion = stateParam?.value === 'absent';
    if (!isDeletion) {
      const modeParam = task.params.find((p) => p.name === 'mode');
      if (!modeParam) {
        const indent = ' '.repeat(task.moduleRange.start.column + 2);
        const insertOffset =
          task.params[task.params.length - 1]?.valueRange.end ?? task.moduleRange.end;
        diagnostics.push({
          ruleId: 'risky-file-permissions',
          message: `File task '${task.moduleName}' does not specify explicit 'mode:' permissions.`,
          severity: 'warning',
          range: task.moduleRange,
          ...(moduleSpec ? { docUrl: moduleSpec.docUrl } : {}),
          quickFixes: [
            {
              title: `Add explicit 'mode: "0644"'`,
              ruleId: 'risky-file-permissions',
              edits: [
                {
                  range: { start: insertOffset, end: insertOffset },
                  newText: `\n${indent}mode: '0644'`,
                },
              ],
            },
          ],
        });
      } else {
        const rawMode = String(modeParam.value ?? modeParam.rawText)
          .replace(/['"]/g, '')
          .trim();
        if (rawMode === '0777' || rawMode === '777' || rawMode === 'a+rwx') {
          diagnostics.push({
            ruleId: 'risky-file-permissions',
            message: `Overly permissive file mode '${rawMode}' grants world-writable permissions.`,
            severity: 'warning',
            range: modeParam.valueRange,
            ...(moduleSpec ? { docUrl: moduleSpec.docUrl } : {}),
            quickFixes: [
              {
                title: `Restrict mode to '0755'`,
                ruleId: 'risky-file-permissions',
                isPreferred: true,
                edits: [{ range: modeParam.valueRange, newText: "'0755'" }],
              },
            ],
          });
        }
      }
    }
  }
}

/**
 * Runs all clean-room static lint rules and produces diagnostics with 1-click Quick-Fixes.
 */
export function lintAnsibleDocument(
  ast: AnsibleDocumentAst,
  registry: IMetadataRegistry,
): readonly LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const tasks = collectAllTasks(ast);

  lintSyntaxAndYamlBasics(ast, tasks, diagnostics);
  checkHardcodedSecrets(ast, tasks, diagnostics);

  const registeredModules = registry.listModules();
  const knownModuleNames: string[] = [];
  if (registeredModules.length > 0) {
    const seen = new Set<string>();
    for (const mod of registeredModules) {
      if (!seen.has(mod.fqcn)) {
        seen.add(mod.fqcn);
        knownModuleNames.push(mod.fqcn);
      }
      if (!seen.has(mod.shortName)) {
        seen.add(mod.shortName);
        knownModuleNames.push(mod.shortName);
      }
    }
  }

  const loadedCollections = new Set(registry.listCollections());
  for (const task of tasks) {
    lintTask(task, registry, knownModuleNames, loadedCollections, diagnostics);
  }

  return diagnostics;
}
