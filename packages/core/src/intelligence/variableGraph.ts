import type {
  AnsibleDocumentAst,
  AnsibleDocumentKind,
  ResolvedVariable,
  SourceRange,
  TaskNode,
  VariableDefinition,
  VariableSourceKind,
} from '../contracts/types.js';

/** Precedence metadata entry for one of the 22 official Ansible variable precedence levels. */
export interface PrecedenceSpec {
  readonly level: number;
  readonly label: string;
}

/**
 * Official 22-level Ansible variable precedence table (from lowest 1 to highest 22).
 *
 * 1. command line values (e.g., `-u my_user`, not variables)
 * 2. role defaults (`roles/<role>/defaults/main.yml`)
 * 3. inventory file or script group vars
 * 4. inventory `group_vars/all`
 * 5. playbook `group_vars/all`
 * 6. inventory `group_vars/*`
 * 7. playbook `group_vars/*`
 * 8. inventory file or script host vars
 * 9. inventory `host_vars/*`
 * 10. playbook `host_vars/*`
 * 11. host facts / cached `set_facts`
 * 12. play `vars`
 * 13. play `vars_prompt`
 * 14. play `vars_files`
 * 15. role `vars` (`roles/<role>/vars/main.yml`)
 * 16. block `vars`
 * 17. task `vars`
 * 18. `include_vars`
 * 19. `set_facts` / `registered` vars
 * 20. role params
 * 21. include params
 * 22. extra vars (`-e`)
 */
export const PRECEDENCE_TABLE: Readonly<Record<VariableSourceKind, PrecedenceSpec>> = {
  'role-defaults': { level: 2, label: 'role defaults (defaults/main.yml)' },
  'inventory-file': { level: 3, label: 'inventory file or script group vars' },
  'inventory-group-vars': { level: 6, label: 'inventory group_vars/*' },
  'playbook-group-vars-all': { level: 5, label: 'playbook group_vars/all' },
  'playbook-group-vars': { level: 7, label: 'playbook group_vars/*' },
  'inventory-host-vars': { level: 9, label: 'inventory host_vars/*' },
  'playbook-host-vars': { level: 10, label: 'playbook host_vars/*' },
  'host-facts': { level: 11, label: 'host facts / cached set_facts' },
  'play-vars': { level: 12, label: 'play vars' },
  'play-vars-prompt': { level: 13, label: 'play vars_prompt' },
  'play-vars-files': { level: 14, label: 'play vars_files' },
  'role-vars': { level: 15, label: 'role vars (vars/main.yml)' },
  'block-vars': { level: 16, label: 'block vars' },
  'task-vars': { level: 17, label: 'task vars' },
  'include-vars': { level: 18, label: 'include_vars' },
  'set-fact': { level: 19, label: 'set_fact / registered vars' },
  register: { level: 19, label: 'register / set_fact' },
  'role-params': { level: 20, label: 'role params' },
  'include-params': { level: 21, label: 'include params' },
  'extra-vars': { level: 22, label: 'extra vars (-e)' },
};

/**
 * Full 1..22 Ansible variable precedence reference table ordered from lowest (1) to highest (22).
 */
export const ANSIBLE_PRECEDENCE_LEVELS: readonly PrecedenceSpec[] = [
  { level: 1, label: 'command line values (-u, etc.)' },
  { level: 2, label: 'role defaults (defaults/main.yml)' },
  { level: 3, label: 'inventory file or script group vars' },
  { level: 4, label: 'inventory group_vars/all' },
  { level: 5, label: 'playbook group_vars/all' },
  { level: 6, label: 'inventory group_vars/*' },
  { level: 7, label: 'playbook group_vars/*' },
  { level: 8, label: 'inventory file or script host vars' },
  { level: 9, label: 'inventory host_vars/*' },
  { level: 10, label: 'playbook host_vars/*' },
  { level: 11, label: 'host facts / cached set_facts' },
  { level: 12, label: 'play vars' },
  { level: 13, label: 'play vars_prompt' },
  { level: 14, label: 'play vars_files' },
  { level: 15, label: 'role vars (vars/main.yml)' },
  { level: 16, label: 'block vars' },
  { level: 17, label: 'task vars' },
  { level: 18, label: 'include_vars' },
  { level: 19, label: 'set_fact / registered vars' },
  { level: 20, label: 'role params' },
  { level: 21, label: 'include params' },
  { level: 22, label: 'extra vars (-e)' },
];

export interface ClassifiedVariableSource {
  readonly sourceKind: VariableSourceKind;
  readonly precedenceLevel: number;
  readonly precedenceLabel: string;
}

function normalizePathForClassification(uri: string): string {
  return uri.replaceAll('\\', '/').toLowerCase();
}

function isYamlFileName(name: string): boolean {
  return name.endsWith('.yml') || name.endsWith('.yaml');
}

function isInventoryScopedPath(normalizedPath: string): boolean {
  const segments = normalizedPath.split('/').filter((s) => s.length > 0);
  const invIdx = Math.max(segments.indexOf('inventory'), segments.indexOf('inventories'));
  return invIdx !== -1 && invIdx < segments.length - 2;
}

function isGroupVarsAll(normalizedPath: string): boolean {
  const segments = normalizedPath.split('/').filter((s) => s.length > 0);
  const gIdx = segments.lastIndexOf('group_vars');
  if (gIdx === -1 || gIdx + 1 >= segments.length) {
    return false;
  }
  const next = segments[gIdx + 1] ?? '';
  if (gIdx + 2 === segments.length) {
    return next === 'all' || next === 'all.yml' || next === 'all.yaml';
  }
  if (gIdx + 3 === segments.length) {
    return next === 'all';
  }
  return false;
}

const DEFAULT_FALLBACK_RANGE: SourceRange = {
  start: { line: 0, column: 0, offset: 0 },
  end: { line: 0, column: 0, offset: 0 },
};

function shortModuleName(moduleName: string): string {
  const idx = moduleName.lastIndexOf('.');
  return idx === -1 ? moduleName : moduleName.slice(idx + 1);
}

function formatRawValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(err);
  }
}

/**
 * Cross-file Workspace Variable Graph & 22-level Ansible Variable Precedence Resolver.
 */
export class WorkspaceVariableGraph {
  private readonly definitionsByName = new Map<string, VariableDefinition[]>();
  private readonly variableNamesByUri = new Map<string, Set<string>>();

  /**
   * Classifies a document URI and kind into its Ansible variable source kind and 1..22 precedence level.
   */
  public classifyVariableSource(
    uri: string,
    docKind: AnsibleDocumentKind,
  ): ClassifiedVariableSource {
    const normalized = normalizePathForClassification(uri);
    const segments = normalized.split('/').filter((s) => s.length > 0);
    const fileName = segments[segments.length - 1] ?? '';
    const parentDir = segments.length >= 2 ? (segments[segments.length - 2] ?? '') : '';
    const dirSegments = segments.slice(0, -1);
    const isYaml = isYamlFileName(fileName);
    const inInventoryDir = isInventoryScopedPath(normalized);

    if (docKind === 'role-defaults' || (isYaml && parentDir === 'defaults')) {
      const spec = PRECEDENCE_TABLE['role-defaults'];
      return {
        sourceKind: 'role-defaults',
        precedenceLevel: spec.level,
        precedenceLabel: spec.label,
      };
    }

    if (
      docKind === 'role-vars' ||
      (isYaml &&
        segments.length >= 4 &&
        segments[segments.length - 4] === 'roles' &&
        parentDir === 'vars')
    ) {
      const spec = PRECEDENCE_TABLE['role-vars'];
      return {
        sourceKind: 'role-vars',
        precedenceLevel: spec.level,
        precedenceLabel: spec.label,
      };
    }

    if (docKind === 'group-vars' || dirSegments.includes('group_vars')) {
      if (isGroupVarsAll(normalized)) {
        if (inInventoryDir) {
          return {
            sourceKind: 'inventory-group-vars',
            precedenceLevel: 4,
            precedenceLabel: 'inventory group_vars/all',
          };
        }
        return {
          sourceKind: 'playbook-group-vars-all',
          precedenceLevel: 5,
          precedenceLabel: PRECEDENCE_TABLE['playbook-group-vars-all'].label,
        };
      }
      if (inInventoryDir) {
        return {
          sourceKind: 'inventory-group-vars',
          precedenceLevel: 6,
          precedenceLabel: PRECEDENCE_TABLE['inventory-group-vars'].label,
        };
      }
      return {
        sourceKind: 'playbook-group-vars',
        precedenceLevel: 7,
        precedenceLabel: PRECEDENCE_TABLE['playbook-group-vars'].label,
      };
    }

    if (docKind === 'host-vars' || dirSegments.includes('host_vars')) {
      if (inInventoryDir) {
        return {
          sourceKind: 'inventory-host-vars',
          precedenceLevel: 9,
          precedenceLabel: PRECEDENCE_TABLE['inventory-host-vars'].label,
        };
      }
      return {
        sourceKind: 'playbook-host-vars',
        precedenceLevel: 10,
        precedenceLabel: PRECEDENCE_TABLE['playbook-host-vars'].label,
      };
    }

    if (docKind === 'inventory') {
      return {
        sourceKind: 'inventory-file',
        precedenceLevel: 3,
        precedenceLabel: PRECEDENCE_TABLE['inventory-file'].label,
      };
    }

    if (docKind === 'include-vars') {
      const spec = PRECEDENCE_TABLE['include-vars'];
      return {
        sourceKind: 'include-vars',
        precedenceLevel: spec.level,
        precedenceLabel: spec.label,
      };
    }

    if (docKind === 'vars-files' || (isYaml && parentDir === 'vars')) {
      const spec = PRECEDENCE_TABLE['play-vars-files'];
      return {
        sourceKind: 'play-vars-files',
        precedenceLevel: spec.level,
        precedenceLabel: spec.label,
      };
    }

    const spec = PRECEDENCE_TABLE['play-vars'];
    return {
      sourceKind: 'play-vars',
      precedenceLevel: spec.level,
      precedenceLabel: spec.label,
    };
  }

  /**
   * Resolves precedence level and label for an explicit `VariableSourceKind`, taking optional URI context
   * into account for `group_vars/all` (level 4 vs 5) or inventory host vars (level 8 vs 9).
   */
  public resolvePrecedenceForSourceKind(
    sourceKind: VariableSourceKind,
    uri?: string,
  ): PrecedenceSpec {
    if (sourceKind === 'inventory-group-vars' && uri !== undefined) {
      const normalized = normalizePathForClassification(uri);
      if (isGroupVarsAll(normalized)) {
        return { level: 4, label: 'inventory group_vars/all' };
      }
    }
    return PRECEDENCE_TABLE[sourceKind];
  }

  public addDefinition(def: VariableDefinition): void {
    const existing = this.definitionsByName.get(def.name) ?? [];
    existing.push(def);
    this.definitionsByName.set(def.name, existing);

    let uriVars = this.variableNamesByUri.get(def.uri);
    if (!uriVars) {
      uriVars = new Set<string>();
      this.variableNamesByUri.set(def.uri, uriVars);
    }
    uriVars.add(def.name);
  }

  /**
   * Removes all indexed variable definitions originating from `uri`.
   */
  public removeDocument(uri: string): void {
    const names = this.variableNamesByUri.get(uri);
    if (!names) {
      return;
    }

    for (const name of names) {
      const defs = this.definitionsByName.get(name);
      if (!defs) {
        continue;
      }
      const remaining = defs.filter((d) => d.uri !== uri);
      if (remaining.length === 0) {
        this.definitionsByName.delete(name);
      } else {
        this.definitionsByName.set(name, remaining);
      }
    }

    this.variableNamesByUri.delete(uri);
  }

  /**
   * Indexes all variable declarations, play/role/task `vars:`, `set_fact` facts, and `register:`
   * bindings from an AST, replacing any prior definitions from `ast.uri`.
   */
  public indexDocument(ast: AnsibleDocumentAst): void {
    this.removeDocument(ast.uri);

    const docClassification = this.classifyVariableSource(ast.uri, ast.kind);

    for (const decl of ast.variables) {
      const isDocLevelSource =
        decl.sourceKind === 'play-vars' &&
        (ast.kind === 'role-defaults' ||
          ast.kind === 'role-vars' ||
          ast.kind === 'group-vars' ||
          ast.kind === 'host-vars' ||
          ast.kind === 'inventory' ||
          ast.kind === 'vars-files' ||
          ast.kind === 'include-vars');

      const sourceKind = isDocLevelSource ? docClassification.sourceKind : decl.sourceKind;
      const spec = isDocLevelSource
        ? { level: docClassification.precedenceLevel, label: docClassification.precedenceLabel }
        : this.resolvePrecedenceForSourceKind(sourceKind, ast.uri);

      this.addDefinition({
        name: decl.name,
        value: decl.value,
        rawValue: decl.rawValue,
        precedenceLevel: spec.level,
        precedenceLabel: spec.label,
        sourceKind,
        uri: ast.uri,
        range: decl.keyRange,
      });
    }

    const indexedTaskOffsets = new Set<number>();

    const indexTask = (task: TaskNode): void => {
      if (indexedTaskOffsets.has(task.range.start.offset)) {
        return;
      }
      indexedTaskOffsets.add(task.range.start.offset);

      if (task.vars) {
        const spec = PRECEDENCE_TABLE['task-vars'];
        for (const [varName, varVal] of Object.entries(task.vars)) {
          this.addDefinition({
            name: varName,
            value: varVal,
            rawValue: formatRawValue(varVal),
            precedenceLevel: spec.level,
            precedenceLabel: spec.label,
            sourceKind: 'task-vars',
            uri: ast.uri,
            range: task.range,
          });
        }
      }

      if (task.register !== undefined && task.register.trim().length > 0) {
        const spec = PRECEDENCE_TABLE['register'];
        this.addDefinition({
          name: task.register,
          value: `<registered from ${task.moduleName}>`,
          rawValue: task.register,
          precedenceLevel: spec.level,
          precedenceLabel: spec.label,
          sourceKind: 'register',
          uri: ast.uri,
          range: task.registerRange ?? task.range,
        });
      }

      const shortMod = shortModuleName(task.moduleName);
      if (shortMod === 'set_fact') {
        const spec = PRECEDENCE_TABLE['set-fact'];
        for (const param of task.params) {
          if (param.name === 'cacheable') {
            continue;
          }
          this.addDefinition({
            name: param.name,
            value: param.value,
            rawValue: param.rawText,
            precedenceLevel: spec.level,
            precedenceLabel: spec.label,
            sourceKind: 'set-fact',
            uri: ast.uri,
            range: param.keyRange,
          });
        }
      } else if (shortMod === 'include_role' || shortMod === 'import_role') {
        const spec = PRECEDENCE_TABLE['role-params'];
        for (const param of task.params) {
          if (param.name !== 'vars' && param.suboptions === undefined) {
            continue;
          }
          if (param.name === 'vars' && param.suboptions) {
            for (const sub of param.suboptions) {
              this.addDefinition({
                name: sub.name,
                value: sub.value,
                rawValue: sub.rawText,
                precedenceLevel: spec.level,
                precedenceLabel: spec.label,
                sourceKind: 'role-params',
                uri: ast.uri,
                range: sub.keyRange,
              });
            }
          }
        }
      } else if (shortMod === 'include_tasks' || shortMod === 'import_tasks') {
        const spec = PRECEDENCE_TABLE['include-params'];
        for (const param of task.params) {
          if (param.name === 'vars' && param.suboptions) {
            for (const sub of param.suboptions) {
              this.addDefinition({
                name: sub.name,
                value: sub.value,
                rawValue: sub.rawText,
                precedenceLevel: spec.level,
                precedenceLabel: spec.label,
                sourceKind: 'include-params',
                uri: ast.uri,
                range: sub.keyRange,
              });
            }
          }
        }
      }
    };

    for (const play of ast.plays) {
      if (play.vars) {
        const spec = PRECEDENCE_TABLE['play-vars'];
        for (const [varName, varVal] of Object.entries(play.vars)) {
          const alreadyDeclared = ast.variables.some(
            (v) => v.name === varName && v.sourceKind === 'play-vars',
          );
          if (!alreadyDeclared) {
            this.addDefinition({
              name: varName,
              value: varVal,
              rawValue: formatRawValue(varVal),
              precedenceLevel: spec.level,
              precedenceLabel: spec.label,
              sourceKind: 'play-vars',
              uri: ast.uri,
              range: play.range ?? DEFAULT_FALLBACK_RANGE,
            });
          }
        }
      }

      for (const role of play.roles) {
        if (role.vars) {
          const spec = PRECEDENCE_TABLE['role-params'];
          for (const [varName, varVal] of Object.entries(role.vars)) {
            this.addDefinition({
              name: varName,
              value: varVal,
              rawValue: formatRawValue(varVal),
              precedenceLevel: spec.level,
              precedenceLabel: spec.label,
              sourceKind: 'role-params',
              uri: ast.uri,
              range: role.range,
            });
          }
        }
      }

      for (const task of play.preTasks) {
        indexTask(task);
      }
      for (const task of play.tasks) {
        indexTask(task);
      }
      for (const task of play.postTasks) {
        indexTask(task);
      }
      for (const handler of play.handlers) {
        indexTask(handler);
      }
    }

    for (const task of ast.tasks) {
      indexTask(task);
    }
    for (const handler of ast.handlers) {
      indexTask(handler);
    }
  }

  public resolveVariable(name: string): ResolvedVariable | undefined {
    const defs = this.definitionsByName.get(name);
    if (!defs || defs.length === 0) {
      return undefined;
    }
    const sorted = [...defs].sort((a, b) => b.precedenceLevel - a.precedenceLevel);
    const winning = sorted[0];
    if (!winning) {
      return undefined;
    }
    return {
      name,
      winningDefinition: winning,
      shadowedDefinitions: sorted.slice(1),
      allDefinitions: sorted,
    };
  }

  public listVariables(): readonly ResolvedVariable[] {
    const results: ResolvedVariable[] = [];
    for (const name of this.definitionsByName.keys()) {
      const resolved = this.resolveVariable(name);
      if (resolved) {
        results.push(resolved);
      }
    }
    return results;
  }
}
