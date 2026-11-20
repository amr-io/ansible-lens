import type {
  AnsibleDocumentAst,
  IMetadataRegistry,
  InferredRegisteredVariable,
  InferredReturnField,
  ModuleReturnFieldSpec,
  TaskNode,
} from '../contracts/types.js';

/**
 * Common Ansible return fields populated on registered task results.
 */
const COMMON_RETURN_FIELDS: Readonly<Record<string, InferredReturnField>> = {
  failed: {
    name: 'failed',
    type: 'bool',
    description: 'True if the task failed.',
    returned: 'always',
  },
  changed: {
    name: 'changed',
    type: 'bool',
    description: 'True if the task made changes on the target.',
    returned: 'always',
  },
  skipped: {
    name: 'skipped',
    type: 'bool',
    description: 'True if the task was skipped due to a conditional.',
    returned: 'always',
  },
  msg: {
    name: 'msg',
    type: 'str',
    description: 'Human-readable status or error message from the module.',
    returned: 'when applicable',
  },
  rc: {
    name: 'rc',
    type: 'int',
    description: 'Exit return code of the executed command.',
    returned: 'when applicable',
  },
  stdout: {
    name: 'stdout',
    type: 'str',
    description: 'Standard output captured from the executed command.',
    returned: 'when applicable',
  },
  stdout_lines: {
    name: 'stdout_lines',
    type: 'list',
    description: 'Standard output split into a list of lines.',
    returned: 'when applicable',
  },
  stderr: {
    name: 'stderr',
    type: 'str',
    description: 'Standard error output captured from the executed command.',
    returned: 'when applicable',
  },
  stderr_lines: {
    name: 'stderr_lines',
    type: 'list',
    description: 'Standard error output split into a list of lines.',
    returned: 'when applicable',
  },
};

const LOOP_ITEM_FIELD: InferredReturnField = {
  name: 'item',
  type: 'raw',
  description: 'Current loop item',
  returned: 'always',
};

function convertReturnField(
  spec: ModuleReturnFieldSpec,
  moduleDocUrl: string | undefined,
  fieldPath: string,
): InferredReturnField {
  let children: Record<string, InferredReturnField> | undefined;
  if (spec.contains) {
    children = {};
    for (const [childKey, childSpec] of Object.entries(spec.contains)) {
      children[childKey] = convertReturnField(childSpec, moduleDocUrl, `${fieldPath}/${childKey}`);
    }
  }

  return {
    name: spec.name,
    type: spec.type,
    description: spec.description,
    returned: spec.returned,
    ...(moduleDocUrl !== undefined && moduleDocUrl.length > 0
      ? { docUrl: `${moduleDocUrl}#return-${fieldPath}` }
      : {}),
    ...(spec.sample !== undefined ? { sample: spec.sample } : {}),
    ...(children !== undefined ? { children } : {}),
  };
}

const convertedReturnFieldsCache = new WeakMap<
  ModuleReturnFieldSpec | object,
  Readonly<Record<string, InferredReturnField>>
>();

function buildModuleReturnFields(
  task: TaskNode,
  registry: IMetadataRegistry,
): {
  readonly moduleFqcn: string;
  readonly perIterationFields: Readonly<Record<string, InferredReturnField>>;
} {
  const moduleSpec = registry.getModule(task.moduleName);
  const moduleFqcn = moduleSpec ? moduleSpec.fqcn : task.moduleName;
  if (!moduleSpec) {
    return { moduleFqcn, perIterationFields: COMMON_RETURN_FIELDS };
  }

  const cached = convertedReturnFieldsCache.get(moduleSpec);
  if (cached) {
    return { moduleFqcn, perIterationFields: cached };
  }

  const perIterationFields: Record<string, InferredReturnField> = {
    ...COMMON_RETURN_FIELDS,
  };
  for (const [fieldKey, fieldSpec] of Object.entries(moduleSpec.returnFields)) {
    perIterationFields[fieldKey] = convertReturnField(fieldSpec, moduleSpec.docUrl, fieldKey);
  }
  convertedReturnFieldsCache.set(moduleSpec, perIterationFields);

  return { moduleFqcn, perIterationFields };
}

function inferTaskRegistration(
  task: TaskNode,
  uri: string,
  registry: IMetadataRegistry,
): InferredRegisteredVariable | undefined {
  if (task.register === undefined || task.register.trim().length === 0) {
    return undefined;
  }

  const { moduleFqcn, perIterationFields } = buildModuleReturnFields(task, registry);
  const isLoop = task.loop !== undefined || task.loopKind !== undefined;

  let fields: Readonly<Record<string, InferredReturnField>>;
  if (isLoop) {
    const resultsField: InferredReturnField = {
      name: 'results',
      type: 'list',
      description: 'List of per-iteration task results produced by the loop.',
      returned: 'always',
      children: {
        ...perIterationFields,
        item: LOOP_ITEM_FIELD,
      },
    };
    fields = {
      results: resultsField,
      changed: COMMON_RETURN_FIELDS['changed']!,
      failed: COMMON_RETURN_FIELDS['failed']!,
      skipped: COMMON_RETURN_FIELDS['skipped']!,
      msg: COMMON_RETURN_FIELDS['msg']!,
    };
  } else {
    fields = perIterationFields;
  }

  return {
    name: task.register,
    ...(task.name !== undefined ? { taskName: task.name } : {}),
    moduleFqcn,
    uri,
    range: task.registerRange ?? task.range,
    isLoop,
    fields,
  };
}

function collectTasks(ast: AnsibleDocumentAst): readonly TaskNode[] {
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

/**
 * Infers return-value schemas for all `register:` variables declared in an Ansible document AST.
 */
export function inferRegisteredVariables(
  ast: AnsibleDocumentAst,
  registry: IMetadataRegistry,
): ReadonlyMap<string, InferredRegisteredVariable> {
  const result = new Map<string, InferredRegisteredVariable>();
  const allTasks = collectTasks(ast);

  for (const task of allTasks) {
    const inferred = inferTaskRegistration(task, ast.uri, registry);
    if (inferred) {
      result.set(inferred.name, inferred);
    }
  }

  return result;
}

function expandPathSegments(pathSegments: readonly string[]): readonly string[] {
  const expanded: string[] = [];
  for (const segment of pathSegments) {
    if (segment.length === 0) {
      continue;
    }
    const bracketIndex = segment.indexOf('[');
    if (bracketIndex === -1) {
      expanded.push(segment);
      continue;
    }
    if (bracketIndex > 0) {
      expanded.push(segment.slice(0, bracketIndex));
    }
    const rest = segment.slice(bracketIndex);
    const matches = rest.match(/\[[^\]]*\]/g);
    if (matches) {
      for (const m of matches) {
        expanded.push(m);
      }
    }
  }
  return expanded;
}

function isArrayIndexSegment(segment: string): boolean {
  return /^(\[\d*\]|\d+|\*)$/.test(segment);
}

/**
 * Resolves a dotted/indexed field path (e.g. `['results', '0', 'stdout']` or `['results[0]', 'stdout']`
 * or `['stat', 'exists']`) against an inferred registered variable schema.
 */
export function resolveRegisteredFieldPath(
  inferred: InferredRegisteredVariable,
  pathSegments: readonly string[],
): InferredReturnField | undefined {
  const segments = expandPathSegments(pathSegments);
  if (segments.length === 0) {
    return undefined;
  }

  let currentFields: Readonly<Record<string, InferredReturnField>> | undefined = inferred.fields;
  let currentField: InferredReturnField | undefined;

  for (const segment of segments) {
    if (currentFields !== undefined) {
      const matched: InferredReturnField | undefined = currentFields[segment];
      if (matched !== undefined) {
        currentField = matched;
        currentFields = matched.children;
        continue;
      }
    }

    if (
      currentField !== undefined &&
      currentField.type === 'list' &&
      currentField.children !== undefined &&
      isArrayIndexSegment(segment)
    ) {
      currentField = {
        name: `${currentField.name}[]`,
        type: 'dict',
        description: currentField.description,
        returned: currentField.returned,
        ...(currentField.docUrl !== undefined ? { docUrl: currentField.docUrl } : {}),
        children: currentField.children,
      };
      currentFields = currentField.children;
      continue;
    }

    return undefined;
  }

  return currentField;
}
