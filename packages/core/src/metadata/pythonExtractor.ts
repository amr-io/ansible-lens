import { parse as parseYaml } from 'yaml';
import type {
  ModuleDeprecationInfo,
  ModuleMetadataSpec,
  ModuleOptionSpec,
  ModuleOptionType,
  ModuleReturnFieldSpec,
} from '../contracts/types.js';

const VALID_OPTION_TYPES = new Set<ModuleOptionType>([
  'str',
  'int',
  'float',
  'bool',
  'list',
  'dict',
  'path',
  'raw',
  'jsonarg',
  'sid',
  'bits',
  'bytes',
]);

function normalizeOptionType(raw: unknown): ModuleOptionType {
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase();
    if (lower === 'string') return 'str';
    if (lower === 'integer') return 'int';
    if (lower === 'boolean') return 'bool';
    if (lower === 'array') return 'list';
    if (lower === 'hash' || lower === 'map') return 'dict';
    if (VALID_OPTION_TYPES.has(lower as ModuleOptionType)) {
      return lower as ModuleOptionType;
    }
  }
  return 'str';
}

function normalizeDescription(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is string => typeof item === 'string')
      .map((s) => s.trim())
      .join('\n');
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOptionsRecord(rawOptions: unknown): Record<string, ModuleOptionSpec> {
  if (!isRecord(rawOptions)) {
    return {};
  }
  const result: Record<string, ModuleOptionSpec> = {};
  for (const [name, rawSpec] of Object.entries(rawOptions)) {
    if (!isRecord(rawSpec)) {
      continue;
    }
    const type = normalizeOptionType(rawSpec['type']);
    const elements =
      rawSpec['elements'] !== undefined ? normalizeOptionType(rawSpec['elements']) : undefined;
    const required = typeof rawSpec['required'] === 'boolean' ? rawSpec['required'] : undefined;
    const hasDefault = Object.prototype.hasOwnProperty.call(rawSpec, 'default');
    const choices = Array.isArray(rawSpec['choices'])
      ? rawSpec['choices'].filter(
          (c): c is string | number | boolean =>
            typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean',
        )
      : undefined;
    const aliases = Array.isArray(rawSpec['aliases'])
      ? rawSpec['aliases'].filter((a): a is string => typeof a === 'string')
      : undefined;
    const versionAdded =
      typeof rawSpec['version_added'] === 'string' ? rawSpec['version_added'] : undefined;
    const suboptions = isRecord(rawSpec['suboptions'])
      ? parseOptionsRecord(rawSpec['suboptions'])
      : undefined;

    result[name] = {
      name,
      type,
      ...(elements !== undefined ? { elements } : {}),
      ...(required !== undefined ? { required } : {}),
      ...(hasDefault ? { default: rawSpec['default'] } : {}),
      ...(choices !== undefined && choices.length > 0 ? { choices } : {}),
      ...(aliases !== undefined && aliases.length > 0 ? { aliases } : {}),
      description: normalizeDescription(rawSpec['description']),
      ...(versionAdded !== undefined ? { versionAdded } : {}),
      ...(suboptions !== undefined && Object.keys(suboptions).length > 0 ? { suboptions } : {}),
    };
  }
  return result;
}

function parseReturnRecord(rawReturn: unknown): Record<string, ModuleReturnFieldSpec> {
  if (!isRecord(rawReturn)) {
    return {};
  }
  const result: Record<string, ModuleReturnFieldSpec> = {};
  for (const [name, rawSpec] of Object.entries(rawReturn)) {
    if (!isRecord(rawSpec)) {
      continue;
    }
    const type = normalizeOptionType(rawSpec['type']);
    const returned = typeof rawSpec['returned'] === 'string' ? rawSpec['returned'] : 'always';
    const hasSample = Object.prototype.hasOwnProperty.call(rawSpec, 'sample');
    const contains = isRecord(rawSpec['contains'])
      ? parseReturnRecord(rawSpec['contains'])
      : undefined;

    result[name] = {
      name,
      type,
      returned,
      description: normalizeDescription(rawSpec['description']),
      ...(hasSample ? { sample: rawSpec['sample'] } : {}),
      ...(contains !== undefined && Object.keys(contains).length > 0 ? { contains } : {}),
    };
  }
  return result;
}

function parseDeprecation(rawDoc: Record<string, unknown>): ModuleDeprecationInfo | undefined {
  const rawDeprecated = rawDoc['deprecated'];
  if (!isRecord(rawDeprecated)) {
    return undefined;
  }
  const why =
    typeof rawDeprecated['why'] === 'string' ? rawDeprecated['why'] : 'This module is deprecated.';
  const removedIn =
    typeof rawDeprecated['removed_in'] === 'string'
      ? rawDeprecated['removed_in']
      : typeof rawDeprecated['removed_at_date'] === 'string'
        ? rawDeprecated['removed_at_date']
        : undefined;
  const alternative =
    typeof rawDeprecated['alternative'] === 'string' ? rawDeprecated['alternative'] : undefined;

  return {
    why,
    ...(removedIn !== undefined ? { removedIn } : {}),
    ...(alternative !== undefined ? { alternative } : {}),
  };
}

/**
 * Extracts a Python top-level triple-quoted string literal assigned to `varName`
 * (e.g., `DOCUMENTATION = r'''...'''`, `DOCUMENTATION = """..."""`, `RETURN = r'''...'''`)
 * without ever executing Python.
 */
function extractPythonTripleQuotedLiteral(source: string, varName: string): string | undefined {
  const assignPattern = new RegExp(`^\\s*${varName}\\s*=\\s*(?:[rRuUbBfF]{0,2})('''|""")`, 'm');
  const match = assignPattern.exec(source);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const delimiter = match[1];
  if (!delimiter) {
    return undefined;
  }
  const contentStart = match.index + match[0].length;
  const closeIdx = source.indexOf(delimiter, contentStart);
  if (closeIdx === -1) {
    return undefined;
  }
  return source.slice(contentStart, closeIdx);
}

function buildDocUrl(fqcn: string, collection: string, shortName: string): string {
  const parts = collection.split('.');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return `https://docs.ansible.com/ansible/latest/collections/${parts[0]}/${parts[1]}/${shortName}_module.html`;
  }
  return `https://docs.ansible.com/ansible/latest/collections/${fqcn.replace(/\./g, '/')}_module.html`;
}

/**
 * Statically extracts `ModuleMetadataSpec` from an Ansible Python module's
 * `DOCUMENTATION` and `RETURN` YAML docstrings without executing Python.
 *
 * Returns `undefined` if no valid `DOCUMENTATION` block is present or YAML parsing fails.
 */
export function extractPythonModuleMetadata(
  pythonSource: string,
  fqcn: string,
  collection: string,
): ModuleMetadataSpec | undefined {
  const docYamlText = extractPythonTripleQuotedLiteral(pythonSource, 'DOCUMENTATION');
  if (!docYamlText) {
    return undefined;
  }

  let parsedDoc: unknown;
  try {
    parsedDoc = parseYaml(docYamlText, { strict: false });
  } catch (err) {
    void err;
    return undefined;
  }

  if (!isRecord(parsedDoc)) {
    return undefined;
  }

  const returnYamlText = extractPythonTripleQuotedLiteral(pythonSource, 'RETURN');
  let parsedReturn: unknown;
  if (returnYamlText) {
    try {
      parsedReturn = parseYaml(returnYamlText, { strict: false });
    } catch (err) {
      void err;
      parsedReturn = undefined;
    }
  }

  const moduleField = typeof parsedDoc['module'] === 'string' ? parsedDoc['module'] : undefined;
  const fqcnParts = fqcn.split('.');
  const shortName = moduleField ?? fqcnParts[fqcnParts.length - 1] ?? fqcn;
  const shortDescription = normalizeDescription(parsedDoc['short_description']);
  const description = normalizeDescription(parsedDoc['description']) || shortDescription;
  const deprecated = parseDeprecation(parsedDoc);

  return {
    fqcn,
    shortName,
    collection,
    shortDescription,
    description,
    docUrl: buildDocUrl(fqcn, collection, shortName),
    ...(deprecated !== undefined ? { deprecated } : {}),
    options: parseOptionsRecord(parsedDoc['options']),
    returnFields: parseReturnRecord(parsedReturn),
  };
}
