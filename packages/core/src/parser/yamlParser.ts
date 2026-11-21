import { isMap, isPair, isScalar, isSeq, parseDocument } from 'yaml';
import type { Node as YamlNode, Pair as YamlPair, Scalar as YamlScalar, YAMLMap } from 'yaml';
import type {
  AnsibleDocumentAst,
  AnsibleDocumentKind,
  DuplicateKeyOccurrence,
  JinjaBlockNode,
  ParseSyntaxError,
  PlayNode,
  RawTruthyOccurrence,
  RoleRefNode,
  SourceRange,
  TaskLoopKind,
  TaskNode,
  TaskParamNode,
  VariableDeclNode,
  VariableSourceKind,
  VarsFileRefNode,
} from '../contracts/types.js';
import { detectAnsibleDocument } from './heuristics.js';
import { extractJinjaBlocksFromText, tokenizeJinjaBlock } from './jinja.js';
import { OffsetIndex } from './sourceMap.js';

const NON_STANDARD_TRUTHY_LITERALS = new Set([
  'yes',
  'no',
  'on',
  'off',
  'y',
  'n',
  'Yes',
  'No',
  'On',
  'Off',
  'YES',
  'NO',
  'ON',
  'OFF',
  'True',
  'False',
  'TRUE',
  'FALSE',
]);

const TASK_DIRECTIVE_KEYS = new Set([
  'name',
  'action',
  'local_action',
  'any_errors_fatal',
  'args',
  'async',
  'become',
  'become_exe',
  'become_flags',
  'become_method',
  'become_user',
  'changed_when',
  'check_mode',
  'collections',
  'connection',
  'debugger',
  'delay',
  'delegate_facts',
  'delegate_to',
  'diff',
  'environment',
  'failed_when',
  'ignore_errors',
  'ignore_unreachable',
  'listen',
  'loop',
  'loop_control',
  'module_defaults',
  'no_log',
  'notify',
  'poll',
  'port',
  'register',
  'remote_user',
  'retries',
  'run_once',
  'tags',
  'throttle',
  'timeout',
  'until',
  'vars',
  'when',
  'with_items',
  'with_dict',
  'with_list',
  'with_flattened',
  'with_subelements',
  'with_sequence',
  'with_together',
  'with_indexed_items',
  'with_random_choice',
  'with_first_found',
  'with_lines',
  'with_file',
  'with_fileglob',
  'with_ini',
  'with_inventory_hostnames',
  'with_nested',
  'block',
  'rescue',
  'always',
]);

const LOOP_KEYWORDS: readonly TaskLoopKind[] = [
  'loop',
  'with_items',
  'with_dict',
  'with_list',
  'with_flattened',
  'with_subelements',
  'with_sequence',
];

const PLAY_DIRECTIVE_KEYS = new Set([
  'name',
  'hosts',
  'become',
  'become_exe',
  'become_flags',
  'become_method',
  'become_user',
  'check_mode',
  'collections',
  'connection',
  'debugger',
  'diff',
  'environment',
  'fact_path',
  'force_handlers',
  'gather_facts',
  'gather_subset',
  'gather_timeout',
  'handlers',
  'ignore_errors',
  'ignore_unreachable',
  'max_fail_percentage',
  'module_defaults',
  'no_log',
  'order',
  'port',
  'post_tasks',
  'pre_tasks',
  'remote_user',
  'roles',
  'run_once',
  'serial',
  'strategy',
  'tags',
  'tasks',
  'throttle',
  'timeout',
  'vars',
  'vars_files',
  'vars_prompt',
  'import_playbook',
]);

function getNodeOffsets(node: unknown): [number, number] {
  if (node !== null && typeof node === 'object') {
    const candidate = node as {
      range?: [number, number, number] | [number, number];
      srcToken?: { offset?: number; source?: string };
    };
    if (Array.isArray(candidate.range) && candidate.range.length >= 2) {
      const start = candidate.range[0] ?? 0;
      const end = candidate.range[1] ?? start;
      return [start, Math.max(start, end)];
    }
    if (candidate.srcToken && typeof candidate.srcToken.offset === 'number') {
      const start = candidate.srcToken.offset;
      const len =
        typeof candidate.srcToken.source === 'string' ? candidate.srcToken.source.length : 0;
      return [start, start + len];
    }
  }
  return [0, 0];
}

function getNodeRange(node: unknown, index: OffsetIndex): SourceRange {
  const [start, end] = getNodeOffsets(node);
  return index.rangeAt(start, end);
}

function getScalarRawText(node: YamlScalar, text: string): string {
  const srcToken = (node as { srcToken?: { source?: string } }).srcToken;
  if (srcToken && typeof srcToken.source === 'string') {
    return srcToken.source;
  }
  const [start, end] = getNodeOffsets(node);
  if (end > start) {
    return text.slice(start, end);
  }
  return node.value === null || node.value === undefined ? '' : String(node.value);
}

function getNodeRawText(node: unknown, text: string): string {
  if (isScalar(node)) {
    return getScalarRawText(node, text);
  }
  const [start, end] = getNodeOffsets(node);
  if (end > start) {
    return text.slice(start, end);
  }
  return '';
}

function keyToString(keyNode: unknown, text: string): string | undefined {
  if (isScalar(keyNode)) {
    if (keyNode.value === null || keyNode.value === undefined) {
      return undefined;
    }
    return String(keyNode.value);
  }
  const raw = getNodeRawText(keyNode, text).trim();
  return raw.length > 0 ? raw : undefined;
}

function scalarToBoolean(node: unknown): boolean | undefined {
  if (!isScalar(node)) {
    return undefined;
  }
  if (typeof node.value === 'boolean') {
    return node.value;
  }
  if (typeof node.value === 'string') {
    const lower = node.value.toLowerCase();
    if (lower === 'yes' || lower === 'true' || lower === 'on') {
      return true;
    }
    if (lower === 'no' || lower === 'false' || lower === 'off') {
      return false;
    }
  }
  return undefined;
}

function scalarToString(node: unknown): string | undefined {
  if (!isScalar(node) || node.value === null || node.value === undefined) {
    return undefined;
  }
  return String(node.value);
}

function toPlainJsValue(node: unknown): unknown {
  if (node === null || node === undefined) {
    return undefined;
  }
  if (isScalar(node)) {
    return node.value;
  }
  if (isSeq(node)) {
    return node.items.map((item) => toPlainJsValue(item));
  }
  if (isMap(node)) {
    const obj: Record<string, unknown> = {};
    for (const pair of node.items) {
      if (!isPair(pair)) {
        continue;
      }
      const k =
        isScalar(pair.key) && pair.key.value !== null && pair.key.value !== undefined
          ? String(pair.key.value)
          : undefined;
      if (k !== undefined) {
        obj[k] = toPlainJsValue(pair.value);
      }
    }
    return obj;
  }
  return undefined;
}

function collectMapToRecord(mapNode: unknown): Record<string, unknown> | undefined {
  if (!isMap(mapNode)) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const pair of mapNode.items) {
    if (!isPair(pair)) {
      continue;
    }
    if (isScalar(pair.key) && pair.key.value !== null && pair.key.value !== undefined) {
      result[String(pair.key.value)] = toPlainJsValue(pair.value);
    }
  }
  return result;
}

function isNonStandardPlainTruthyScalar(node: YamlScalar): string | undefined {
  // Only plain (unquoted) YAML scalars are ambiguous under YAML 1.1 vs 1.2
  if (node.type !== 'PLAIN') {
    return undefined;
  }
  const srcToken = (node as { srcToken?: { source?: string } }).srcToken;
  const raw =
    srcToken?.source ?? (node.value !== null && node.value !== undefined ? String(node.value) : '');
  if (NON_STANDARD_TRUTHY_LITERALS.has(raw)) {
    return raw;
  }
  return undefined;
}

function collectJinjaFromNode(
  node: unknown,
  text: string,
  index: OffsetIndex,
  allJinjaBlocks: JinjaBlockNode[],
): JinjaBlockNode[] {
  const localBlocks: JinjaBlockNode[] = [];

  const visit = (n: unknown): void => {
    if (isScalar(n)) {
      const [startOffset] = getNodeOffsets(n);
      const startPos = index.positionAt(startOffset);
      const rawText = getScalarRawText(n, text);
      if (rawText.includes('{{') || rawText.includes('{%') || rawText.includes('{#')) {
        const blocks = extractJinjaBlocksFromText(
          rawText,
          startPos.offset,
          startPos.line,
          startPos.column,
        );
        for (const b of blocks) {
          localBlocks.push(b);
          allJinjaBlocks.push(b);
        }
      }
      return;
    }
    if (isSeq(n)) {
      for (const item of n.items) {
        visit(item);
      }
      return;
    }
    if (isMap(n)) {
      for (const pair of n.items) {
        if (isPair(pair)) {
          visit(pair.key);
          visit(pair.value);
        }
      }
    }
  };

  visit(node);
  return localBlocks;
}

interface ParseContext {
  readonly text: string;
  readonly index: OffsetIndex;
  readonly jinjaBlocks: JinjaBlockNode[];
  readonly duplicateKeys: DuplicateKeyOccurrence[];
  readonly rawTruthyValues: RawTruthyOccurrence[];
  readonly variables: VariableDeclNode[];
  readonly syntaxErrors: ParseSyntaxError[];
}

const PLAY_DELEGATED_TASK_KEYS = new Set(['pre_tasks', 'tasks', 'post_tasks', 'handlers']);

const BLOCK_DELEGATED_TASK_KEYS = new Set(['block', 'rescue', 'always']);

function scanMapDuplicatesAndTruthy(
  mapNode: YAMLMap,
  ctx: ParseContext,
  skipKeys?: ReadonlySet<string>,
): { localDuplicates: DuplicateKeyOccurrence[]; localTruthy: RawTruthyOccurrence[] } {
  const seenKeys = new Set<string>();
  const localDuplicates: DuplicateKeyOccurrence[] = [];
  const localTruthy: RawTruthyOccurrence[] = [];

  for (const pair of mapNode.items) {
    if (!isPair(pair)) {
      continue;
    }
    const keyName = keyToString(pair.key, ctx.text);
    if (keyName !== undefined) {
      if (seenKeys.has(keyName)) {
        const dup: DuplicateKeyOccurrence = {
          key: keyName,
          range: getNodeRange(pair.key, ctx.index),
        };
        localDuplicates.push(dup);
        ctx.duplicateKeys.push(dup);
      } else {
        seenKeys.add(keyName);
      }
    }

    if (keyName !== undefined && skipKeys?.has(keyName)) {
      continue;
    }

    const inspectValueForTruthy = (val: unknown, associatedKey: string | undefined): void => {
      if (isScalar(val)) {
        const rawTruthy = isNonStandardPlainTruthyScalar(val);
        if (rawTruthy !== undefined) {
          const occ: RawTruthyOccurrence =
            associatedKey !== undefined
              ? { key: associatedKey, rawValue: rawTruthy, range: getNodeRange(val, ctx.index) }
              : { rawValue: rawTruthy, range: getNodeRange(val, ctx.index) };
          localTruthy.push(occ);
          ctx.rawTruthyValues.push(occ);
        }
      } else if (isSeq(val)) {
        for (const item of val.items) {
          inspectValueForTruthy(item, associatedKey);
        }
      } else if (isMap(val)) {
        const nested = scanMapDuplicatesAndTruthy(val, ctx);
        localDuplicates.push(...nested.localDuplicates);
        localTruthy.push(...nested.localTruthy);
      }
    };

    inspectValueForTruthy(pair.value, keyName);
  }

  return { localDuplicates, localTruthy };
}

function parseTaskParamsFromMap(mapNode: YAMLMap, ctx: ParseContext): TaskParamNode[] {
  const params: TaskParamNode[] = [];
  for (const pair of mapNode.items) {
    if (!isPair(pair)) {
      continue;
    }
    const name = keyToString(pair.key, ctx.text);
    if (name === undefined) {
      continue;
    }
    const keyRange = getNodeRange(pair.key, ctx.index);
    const valueRange = pair.value ? getNodeRange(pair.value, ctx.index) : keyRange;
    const rawText = pair.value ? getNodeRawText(pair.value, ctx.text) : '';
    const value = toPlainJsValue(pair.value);
    const jinjaBlocks = collectJinjaFromNode(pair.value, ctx.text, ctx.index, ctx.jinjaBlocks);
    const suboptions = isMap(pair.value) ? parseTaskParamsFromMap(pair.value, ctx) : undefined;

    const param: TaskParamNode =
      suboptions !== undefined
        ? {
            name,
            keyRange,
            valueRange,
            rawText,
            value,
            suboptions,
            jinjaBlocks,
          }
        : {
            name,
            keyRange,
            valueRange,
            rawText,
            value,
            jinjaBlocks,
          };
    params.push(param);
  }
  return params;
}

function parseImplicitJinjaNode(
  valueNode: unknown,
  ctx: ParseContext,
): string | boolean | undefined {
  if (isScalar(valueNode)) {
    const val = valueNode.value;
    if (typeof val === 'boolean') {
      return val;
    }
    const str = scalarToString(valueNode);
    if (str !== undefined) {
      const [startOffset] = getNodeOffsets(valueNode);
      const startPos = ctx.index.positionAt(startOffset);
      const rawText = getScalarRawText(valueNode, ctx.text);
      // If it contains explicit {{ }}, extract those; otherwise tokenize entire scalar as implicit Jinja
      if (rawText.includes('{{') || rawText.includes('{%')) {
        const blocks = extractJinjaBlocksFromText(
          rawText,
          startPos.offset,
          startPos.line,
          startPos.column,
        );
        ctx.jinjaBlocks.push(...blocks);
      } else if (str.trim().length > 0) {
        const block = tokenizeJinjaBlock(
          str,
          'implicit',
          startPos.offset,
          startPos.line,
          startPos.column,
        );
        ctx.jinjaBlocks.push(block);
      }
      return str;
    }
    return undefined;
  }

  if (isSeq(valueNode)) {
    const parts: string[] = [];
    for (const item of valueNode.items) {
      if (isScalar(item)) {
        const s = scalarToString(item);
        if (s !== undefined && s.trim().length > 0) {
          parts.push(s);
          const [startOffset] = getNodeOffsets(item);
          const startPos = ctx.index.positionAt(startOffset);
          ctx.jinjaBlocks.push(
            tokenizeJinjaBlock(s, 'implicit', startPos.offset, startPos.line, startPos.column),
          );
        }
      }
    }
    return parts.length > 0 ? parts.join(' and ') : undefined;
  }

  return undefined;
}

function extractVariablesFromMap(
  mapNode: YAMLMap,
  sourceKind: VariableSourceKind,
  ctx: ParseContext,
): void {
  for (const pair of mapNode.items) {
    if (!isPair(pair)) {
      continue;
    }
    const name = keyToString(pair.key, ctx.text);
    if (name === undefined) {
      continue;
    }
    const keyRange = getNodeRange(pair.key, ctx.index);
    const valueRange = pair.value ? getNodeRange(pair.value, ctx.index) : keyRange;
    const rawValue = pair.value ? getNodeRawText(pair.value, ctx.text) : '';
    const value = toPlainJsValue(pair.value);

    ctx.variables.push({
      name,
      value,
      rawValue,
      keyRange,
      valueRange,
      sourceKind,
    });

    collectJinjaFromNode(pair.value, ctx.text, ctx.index, ctx.jinjaBlocks);
  }
}

function parseTaskList(seqNode: unknown, ctx: ParseContext): TaskNode[] {
  if (!isSeq(seqNode)) {
    return [];
  }
  const tasks: TaskNode[] = [];
  for (const item of seqNode.items) {
    if (!isMap(item)) {
      continue;
    }
    tasks.push(...parseTaskOrBlockMap(item, ctx));
  }
  return tasks;
}

function isBlockTask(mapNode: YAMLMap): boolean {
  for (const pair of mapNode.items) {
    if (!isPair(pair)) {
      continue;
    }
    const key = keyToString(pair.key, '');
    if (key === 'block') {
      return true;
    }
  }
  return false;
}

function parseTaskOrBlockMap(mapNode: YAMLMap, ctx: ParseContext): TaskNode[] {
  if (isBlockTask(mapNode)) {
    const collected: TaskNode[] = [];
    scanMapDuplicatesAndTruthy(mapNode, ctx, BLOCK_DELEGATED_TASK_KEYS);

    for (const pair of mapNode.items) {
      if (!isPair(pair)) {
        continue;
      }
      const key = keyToString(pair.key, ctx.text);
      if (key === 'block' || key === 'rescue' || key === 'always') {
        collected.push(...parseTaskList(pair.value, ctx));
      } else if (key === 'vars' && isMap(pair.value)) {
        extractVariablesFromMap(pair.value, 'block-vars', ctx);
      } else if (
        key === 'when' ||
        key === 'changed_when' ||
        key === 'failed_when' ||
        key === 'until'
      ) {
        parseImplicitJinjaNode(pair.value, ctx);
      } else {
        collectJinjaFromNode(pair.value, ctx.text, ctx.index, ctx.jinjaBlocks);
      }
    }
    return collected;
  }

  const { localDuplicates, localTruthy } = scanMapDuplicatesAndTruthy(mapNode, ctx);

  let name: string | undefined;
  let nameRange: SourceRange | undefined;
  let modulePair: YamlPair | undefined;
  let moduleName: string | undefined;
  let register: string | undefined;
  let registerRange: SourceRange | undefined;
  let loop: unknown;
  let loopKind: TaskLoopKind | undefined;
  let loopVar: string | undefined;
  let whenStr: string | undefined;
  let whenRange: SourceRange | undefined;
  let changedWhen: string | boolean | undefined;
  let changedWhenRange: SourceRange | undefined;
  let failedWhen: string | boolean | undefined;
  let failedWhenRange: SourceRange | undefined;
  let notify: string[] | undefined;
  let notifyRange: SourceRange | undefined;
  let noLog: boolean | undefined;
  let become: boolean | undefined;
  let tags: string[] | undefined;
  let vars: Record<string, unknown> | undefined;
  let argsMap: YAMLMap | undefined;

  for (const pair of mapNode.items) {
    if (!isPair(pair)) {
      continue;
    }
    const key = keyToString(pair.key, ctx.text);
    if (key === undefined) {
      continue;
    }

    if (key === 'name') {
      name = scalarToString(pair.value);
      nameRange = getNodeRange(pair.key, ctx.index);
      collectJinjaFromNode(pair.value, ctx.text, ctx.index, ctx.jinjaBlocks);
      continue;
    }

    if (key === 'register') {
      register = scalarToString(pair.value);
      registerRange = pair.value
        ? getNodeRange(pair.value, ctx.index)
        : getNodeRange(pair.key, ctx.index);
      continue;
    }

    if ((LOOP_KEYWORDS as readonly string[]).includes(key)) {
      loopKind = key as TaskLoopKind;
      loop = toPlainJsValue(pair.value);
      collectJinjaFromNode(pair.value, ctx.text, ctx.index, ctx.jinjaBlocks);
      continue;
    }

    if (key === 'loop_control' && isMap(pair.value)) {
      for (const lcPair of pair.value.items) {
        if (!isPair(lcPair)) {
          continue;
        }
        const lcKey = keyToString(lcPair.key, ctx.text);
        if (lcKey === 'loop_var') {
          loopVar = scalarToString(lcPair.value);
        }
      }
      collectJinjaFromNode(pair.value, ctx.text, ctx.index, ctx.jinjaBlocks);
      continue;
    }

    if (key === 'when') {
      const parsed = parseImplicitJinjaNode(pair.value, ctx);
      whenStr = typeof parsed === 'boolean' ? String(parsed) : parsed;
      whenRange = pair.value
        ? getNodeRange(pair.value, ctx.index)
        : getNodeRange(pair.key, ctx.index);
      continue;
    }

    if (key === 'changed_when') {
      changedWhen = parseImplicitJinjaNode(pair.value, ctx);
      changedWhenRange = pair.value
        ? getNodeRange(pair.value, ctx.index)
        : getNodeRange(pair.key, ctx.index);
      continue;
    }

    if (key === 'failed_when') {
      failedWhen = parseImplicitJinjaNode(pair.value, ctx);
      failedWhenRange = pair.value
        ? getNodeRange(pair.value, ctx.index)
        : getNodeRange(pair.key, ctx.index);
      continue;
    }

    if (key === 'until') {
      parseImplicitJinjaNode(pair.value, ctx);
      continue;
    }

    if (key === 'notify') {
      notifyRange = pair.value
        ? getNodeRange(pair.value, ctx.index)
        : getNodeRange(pair.key, ctx.index);
      if (isScalar(pair.value)) {
        const s = scalarToString(pair.value);
        if (s !== undefined) {
          notify = [s];
        }
      } else if (isSeq(pair.value)) {
        notify = pair.value.items
          .map((it) => scalarToString(it))
          .filter((s): s is string => s !== undefined);
      }
      continue;
    }

    if (key === 'no_log') {
      noLog = scalarToBoolean(pair.value);
      continue;
    }

    if (key === 'become') {
      become = scalarToBoolean(pair.value);
      continue;
    }

    if (key === 'tags') {
      if (isScalar(pair.value)) {
        const s = scalarToString(pair.value);
        if (s !== undefined) {
          tags = [s];
        }
      } else if (isSeq(pair.value)) {
        tags = pair.value.items
          .map((it) => scalarToString(it))
          .filter((s): s is string => s !== undefined);
      }
      continue;
    }

    if (key === 'vars' && isMap(pair.value)) {
      vars = collectMapToRecord(pair.value);
      extractVariablesFromMap(pair.value, 'task-vars', ctx);
      continue;
    }

    if (key === 'args' && isMap(pair.value)) {
      argsMap = pair.value;
      continue;
    }

    if (TASK_DIRECTIVE_KEYS.has(key)) {
      collectJinjaFromNode(pair.value, ctx.text, ctx.index, ctx.jinjaBlocks);
      continue;
    }

    // First non-directive key is treated as the Ansible module invocation
    if (modulePair === undefined) {
      modulePair = pair;
      moduleName = key;
    }
  }

  if (modulePair === undefined || moduleName === undefined) {
    // Task might be incomplete while typing (e.g. only `- name: install nginx`)
    const taskRange = getNodeRange(mapNode, ctx.index);
    const fallbackRange = nameRange ?? taskRange;
    const syntheticTask: TaskNode = {
      ...(name !== undefined ? { name } : {}),
      ...(nameRange !== undefined ? { nameRange } : {}),
      moduleName: '',
      moduleRange: fallbackRange,
      isFqcn: false,
      params: [],
      ...(register !== undefined ? { register } : {}),
      ...(registerRange !== undefined ? { registerRange } : {}),
      ...(loop !== undefined ? { loop } : {}),
      ...(loopKind !== undefined ? { loopKind } : {}),
      ...(loopVar !== undefined ? { loopVar } : {}),
      ...(whenStr !== undefined ? { when: whenStr } : {}),
      ...(whenRange !== undefined ? { whenRange } : {}),
      ...(changedWhen !== undefined ? { changedWhen } : {}),
      ...(changedWhenRange !== undefined ? { changedWhenRange } : {}),
      ...(failedWhen !== undefined ? { failedWhen } : {}),
      ...(failedWhenRange !== undefined ? { failedWhenRange } : {}),
      ...(notify !== undefined ? { notify } : {}),
      ...(notifyRange !== undefined ? { notifyRange } : {}),
      ...(noLog !== undefined ? { noLog } : {}),
      ...(become !== undefined ? { become } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(vars !== undefined ? { vars } : {}),
      duplicateKeys: localDuplicates,
      rawTruthyKeys: localTruthy,
      range: taskRange,
    };
    return [syntheticTask];
  }

  const moduleRange = getNodeRange(modulePair.key, ctx.index);
  const isFqcn = /^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/i.test(moduleName);

  let params: TaskParamNode[] = [];
  let freeFormArg: string | undefined;

  if (isMap(modulePair.value)) {
    params = parseTaskParamsFromMap(modulePair.value, ctx);

    // Special-case `set_fact`: record declared variables into `ctx.variables`
    if (moduleName === 'set_fact' || moduleName === 'ansible.builtin.set_fact') {
      extractVariablesFromMap(modulePair.value, 'set-fact', ctx);
    }
  } else if (isScalar(modulePair.value)) {
    freeFormArg = scalarToString(modulePair.value);
    collectJinjaFromNode(modulePair.value, ctx.text, ctx.index, ctx.jinjaBlocks);
  } else if (modulePair.value !== null && modulePair.value !== undefined) {
    collectJinjaFromNode(modulePair.value, ctx.text, ctx.index, ctx.jinjaBlocks);
  }

  if (argsMap !== undefined) {
    params = [...params, ...parseTaskParamsFromMap(argsMap, ctx)];
  }

  const taskNode: TaskNode = {
    ...(name !== undefined ? { name } : {}),
    ...(nameRange !== undefined ? { nameRange } : {}),
    moduleName,
    moduleRange,
    isFqcn,
    params,
    ...(freeFormArg !== undefined ? { freeFormArg } : {}),
    ...(register !== undefined ? { register } : {}),
    ...(registerRange !== undefined ? { registerRange } : {}),
    ...(loop !== undefined ? { loop } : {}),
    ...(loopKind !== undefined ? { loopKind } : {}),
    ...(loopVar !== undefined ? { loopVar } : {}),
    ...(whenStr !== undefined ? { when: whenStr } : {}),
    ...(whenRange !== undefined ? { whenRange } : {}),
    ...(changedWhen !== undefined ? { changedWhen } : {}),
    ...(changedWhenRange !== undefined ? { changedWhenRange } : {}),
    ...(failedWhen !== undefined ? { failedWhen } : {}),
    ...(failedWhenRange !== undefined ? { failedWhenRange } : {}),
    ...(notify !== undefined ? { notify } : {}),
    ...(notifyRange !== undefined ? { notifyRange } : {}),
    ...(noLog !== undefined ? { noLog } : {}),
    ...(become !== undefined ? { become } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(vars !== undefined ? { vars } : {}),
    duplicateKeys: localDuplicates,
    rawTruthyKeys: localTruthy,
    range: getNodeRange(mapNode, ctx.index),
  };

  return [taskNode];
}

function parseRolesList(seqNode: unknown, ctx: ParseContext): RoleRefNode[] {
  if (!isSeq(seqNode)) {
    return [];
  }
  const roles: RoleRefNode[] = [];
  for (const item of seqNode.items) {
    if (isScalar(item)) {
      const name = scalarToString(item);
      if (name !== undefined && name.length > 0) {
        roles.push({
          name,
          range: getNodeRange(item, ctx.index),
        });
      }
      continue;
    }
    if (isMap(item)) {
      let roleName: string | undefined;
      let roleRange: SourceRange | undefined;
      let roleVars: Record<string, unknown> | undefined;
      const extraVars: Record<string, unknown> = {};

      for (const pair of item.items) {
        if (!isPair(pair)) {
          continue;
        }
        const k = keyToString(pair.key, ctx.text);
        if (k === undefined) {
          continue;
        }
        if (k === 'role' || k === 'name') {
          roleName = scalarToString(pair.value);
          roleRange = pair.value
            ? getNodeRange(pair.value, ctx.index)
            : getNodeRange(pair.key, ctx.index);
        } else if (k === 'vars' && isMap(pair.value)) {
          roleVars = collectMapToRecord(pair.value);
          extractVariablesFromMap(pair.value, 'role-params', ctx);
        } else {
          extraVars[k] = toPlainJsValue(pair.value);
        }
      }

      if (roleName !== undefined && roleRange !== undefined) {
        const mergedVars =
          roleVars || Object.keys(extraVars).length > 0 ? { ...extraVars, ...roleVars } : undefined;
        roles.push(
          mergedVars !== undefined
            ? { name: roleName, range: roleRange, vars: mergedVars }
            : { name: roleName, range: roleRange },
        );
      }
    }
  }
  return roles;
}

function parseVarsFilesList(seqNode: unknown, ctx: ParseContext): VarsFileRefNode[] {
  if (!isSeq(seqNode)) {
    return [];
  }
  const files: VarsFileRefNode[] = [];
  for (const item of seqNode.items) {
    if (isScalar(item)) {
      const p = scalarToString(item);
      if (p !== undefined && p.length > 0) {
        files.push({ path: p, range: getNodeRange(item, ctx.index) });
      }
    } else if (isSeq(item)) {
      for (const sub of item.items) {
        const p = scalarToString(sub);
        if (p !== undefined && p.length > 0) {
          files.push({ path: p, range: getNodeRange(sub, ctx.index) });
        }
      }
    }
  }
  return files;
}

function isPlayMap(mapNode: YAMLMap, text: string): boolean {
  let hasPlayKey = false;
  for (const pair of mapNode.items) {
    if (!isPair(pair)) {
      continue;
    }
    const k = keyToString(pair.key, text);
    if (
      k === 'hosts' ||
      k === 'tasks' ||
      k === 'pre_tasks' ||
      k === 'post_tasks' ||
      k === 'roles' ||
      k === 'handlers' ||
      k === 'import_playbook' ||
      k === 'gather_facts'
    ) {
      hasPlayKey = true;
      break;
    }
  }
  return hasPlayKey;
}

function parsePlayMap(mapNode: YAMLMap, ctx: ParseContext): PlayNode {
  scanMapDuplicatesAndTruthy(mapNode, ctx, PLAY_DELEGATED_TASK_KEYS);

  let name: string | undefined;
  let hosts: string | undefined;
  let hostsRange: SourceRange | undefined;
  let become: boolean | undefined;
  let vars: Record<string, unknown> | undefined;
  let varsFiles: VarsFileRefNode[] = [];
  let roles: RoleRefNode[] = [];
  let preTasks: TaskNode[] = [];
  let tasks: TaskNode[] = [];
  let postTasks: TaskNode[] = [];
  let handlers: TaskNode[] = [];

  for (const pair of mapNode.items) {
    if (!isPair(pair)) {
      continue;
    }
    const key = keyToString(pair.key, ctx.text);
    if (key === undefined) {
      continue;
    }

    if (key === 'name') {
      name = scalarToString(pair.value);
      collectJinjaFromNode(pair.value, ctx.text, ctx.index, ctx.jinjaBlocks);
    } else if (key === 'hosts') {
      hosts = scalarToString(pair.value);
      hostsRange = pair.value
        ? getNodeRange(pair.value, ctx.index)
        : getNodeRange(pair.key, ctx.index);
      collectJinjaFromNode(pair.value, ctx.text, ctx.index, ctx.jinjaBlocks);
    } else if (key === 'become') {
      become = scalarToBoolean(pair.value);
    } else if (key === 'vars' && isMap(pair.value)) {
      vars = collectMapToRecord(pair.value);
      extractVariablesFromMap(pair.value, 'play-vars', ctx);
    } else if (key === 'vars_files') {
      varsFiles = parseVarsFilesList(pair.value, ctx);
    } else if (key === 'roles') {
      roles = parseRolesList(pair.value, ctx);
    } else if (key === 'pre_tasks') {
      preTasks = parseTaskList(pair.value, ctx);
    } else if (key === 'tasks') {
      tasks = parseTaskList(pair.value, ctx);
    } else if (key === 'post_tasks') {
      postTasks = parseTaskList(pair.value, ctx);
    } else if (key === 'handlers') {
      handlers = parseTaskList(pair.value, ctx);
    } else if (!PLAY_DIRECTIVE_KEYS.has(key)) {
      collectJinjaFromNode(pair.value, ctx.text, ctx.index, ctx.jinjaBlocks);
    }
  }

  return {
    ...(name !== undefined ? { name } : {}),
    ...(hosts !== undefined ? { hosts } : {}),
    ...(hostsRange !== undefined ? { hostsRange } : {}),
    ...(become !== undefined ? { become } : {}),
    ...(vars !== undefined ? { vars } : {}),
    varsFiles,
    roles,
    preTasks,
    tasks,
    postTasks,
    handlers,
    range: getNodeRange(mapNode, ctx.index),
  };
}

function variableSourceKindForDocKind(kind: AnsibleDocumentKind): VariableSourceKind {
  switch (kind) {
    case 'role-defaults':
      return 'role-defaults';
    case 'role-vars':
      return 'role-vars';
    case 'group-vars':
      return 'playbook-group-vars';
    case 'host-vars':
      return 'playbook-host-vars';
    case 'inventory':
      return 'inventory-file';
    case 'vars-files':
      return 'play-vars-files';
    case 'include-vars':
      return 'include-vars';
    default:
      return 'play-vars';
  }
}

function collectSyntaxErrors(
  errors: readonly { message: string; pos?: [number, number]; code?: string }[],
  index: OffsetIndex,
  out: ParseSyntaxError[],
): void {
  for (const err of errors) {
    // Duplicate keys are tracked structurally in `duplicateKeys` rather than fatal YAML errors,
    // though keeping non-duplicate YAML syntax errors in `syntaxErrors`.
    const startOffset = Array.isArray(err.pos) ? (err.pos[0] ?? 0) : 0;
    const endOffset = Array.isArray(err.pos) ? (err.pos[1] ?? startOffset + 1) : startOffset + 1;
    out.push({
      message: err.message,
      range: index.rangeAt(startOffset, Math.max(startOffset + 1, endOffset)),
      code: err.code ?? 'YAML_SYNTAX_ERROR',
    });
  }
}

function fallbackJinjaScan(text: string, index: OffsetIndex, out: JinjaBlockNode[]): void {
  const blocks = extractJinjaBlocksFromText(text, 0, 0, 0);
  for (const b of blocks) {
    // Avoid duplicating blocks already recorded at identical offset
    const exists = out.some(
      (existing) =>
        existing.range.start.offset === b.range.start.offset &&
        existing.range.end.offset === b.range.end.offset,
    );
    if (!exists) {
      out.push(b);
    }
  }
  void index;
}

/**
 * Fault-tolerant YAML CST + Jinja2 parser producing an `AnsibleDocumentAst`.
 * Never throws on malformed, truncated, or half-typed YAML/Jinja2 inputs.
 */
export function parseAnsibleDocument(
  uri: string,
  text: string,
  forcedKind?: AnsibleDocumentKind,
): AnsibleDocumentAst {
  const index = new OffsetIndex(text);
  const detectedKind = forcedKind ?? detectAnsibleDocument(uri, text, false).kind;

  const ctx: ParseContext = {
    text,
    index,
    jinjaBlocks: [],
    duplicateKeys: [],
    rawTruthyValues: [],
    variables: [],
    syntaxErrors: [],
  };

  const plays: PlayNode[] = [];
  const topTasks: TaskNode[] = [];
  const topHandlers: TaskNode[] = [];

  if (text.trim().length === 0 || detectedKind === 'template') {
    if (detectedKind === 'template' && text.length > 0) {
      fallbackJinjaScan(text, index, ctx.jinjaBlocks);
    }
    return {
      uri,
      kind: detectedKind,
      text,
      plays,
      tasks: topTasks,
      handlers: topHandlers,
      variables: ctx.variables,
      jinjaBlocks: ctx.jinjaBlocks,
      duplicateKeys: ctx.duplicateKeys,
      rawTruthyValues: ctx.rawTruthyValues,
      syntaxErrors: ctx.syntaxErrors,
    };
  }

  let effectiveKind: AnsibleDocumentKind = detectedKind;

  try {
    const doc = parseDocument(text, {
      keepSourceTokens: true,
      strict: false,
      prettyErrors: false,
    });

    collectSyntaxErrors(doc.errors, index, ctx.syntaxErrors);

    const root: YamlNode | null = doc.contents;

    if (isSeq(root)) {
      const looksLikePlaybook =
        effectiveKind === 'playbook' ||
        (effectiveKind === 'unknown' &&
          root.items.some((item) => isMap(item) && isPlayMap(item, text)));

      if (looksLikePlaybook) {
        if (effectiveKind === 'unknown') {
          effectiveKind = 'playbook';
        }
        for (const item of root.items) {
          if (isMap(item)) {
            const play = parsePlayMap(item, ctx);
            plays.push(play);
            topTasks.push(...play.preTasks, ...play.tasks, ...play.postTasks);
            topHandlers.push(...play.handlers);
          }
        }
      } else if (effectiveKind === 'handlers') {
        const parsed = parseTaskList(root, ctx);
        topHandlers.push(...parsed);
      } else {
        if (effectiveKind === 'unknown') {
          effectiveKind = 'tasks';
        }
        const parsed = parseTaskList(root, ctx);
        topTasks.push(...parsed);
      }
    } else if (isMap(root)) {
      scanMapDuplicatesAndTruthy(root, ctx);
      const varSourceKind = variableSourceKindForDocKind(effectiveKind);
      extractVariablesFromMap(root, varSourceKind, ctx);
    } else if (isScalar(root)) {
      collectJinjaFromNode(root, text, index, ctx.jinjaBlocks);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown YAML parse error';
    ctx.syntaxErrors.push({
      message,
      range: index.rangeAt(0, Math.min(text.length, 1)),
      code: 'YAML_FATAL_RECOVERED',
    });
  }

  // Ensure any Jinja2 blocks in malformed/unparsed lines are still captured for completion & hover
  fallbackJinjaScan(text, index, ctx.jinjaBlocks);

  return {
    uri,
    kind: effectiveKind,
    text,
    plays,
    tasks: topTasks,
    handlers: topHandlers,
    variables: ctx.variables,
    jinjaBlocks: ctx.jinjaBlocks,
    duplicateKeys: ctx.duplicateKeys,
    rawTruthyValues: ctx.rawTruthyValues,
    syntaxErrors: ctx.syntaxErrors,
  };
}
