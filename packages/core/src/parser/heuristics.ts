import type { AnsibleDocumentKind, AnsibleHeuristicResult } from '../contracts/types.js';

const PLAYBOOK_FILENAMES = new Set([
  'site.yml',
  'site.yaml',
  'playbook.yml',
  'playbook.yaml',
  'main.yml',
  'main.yaml',
  'deploy.yml',
  'deploy.yaml',
  'provision.yml',
  'provision.yaml',
  'setup.yml',
  'setup.yaml',
]);

const TASK_SIGNATURE_DIRECTIVES = new Set([
  'name',
  'block',
  'rescue',
  'always',
  'register',
  'when',
  'changed_when',
  'failed_when',
  'notify',
  'loop',
  'with_items',
  'with_dict',
  'with_list',
  'become',
  'delegate_to',
  'import_tasks',
  'include_tasks',
  'include_role',
  'import_role',
]);

const KNOWN_COLLECTION_PREFIXES = [
  'ansible.builtin.',
  'ansible.posix.',
  'community.general.',
  'community.docker.',
  'community.crypto.',
  'ansible.windows.',
  'amazon.aws.',
  'kubernetes.core.',
  'community.mysql.',
  'community.postgresql.',
  'ansible.utils.',
] as const;

function normalizePath(uri: string): string {
  let withoutScheme = uri;
  const lower = uri.toLowerCase();
  if (lower.startsWith('file:///')) {
    withoutScheme = `/${uri.slice('file:///'.length)}`;
  } else if (lower.startsWith('file://')) {
    withoutScheme = uri.slice('file://'.length);
  }
  return withoutScheme.replaceAll('\\', '/').toLowerCase();
}

function isYamlUri(normalizedPath: string): boolean {
  return normalizedPath.endsWith('.yml') || normalizedPath.endsWith('.yaml');
}

function classifyByPath(normalizedPath: string): AnsibleDocumentKind | undefined {
  const segments = normalizedPath.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    return undefined;
  }

  const fileName = segments[segments.length - 1] ?? '';
  const dirSegments = segments.slice(0, -1);
  if (fileName.endsWith('.j2')) {
    return 'template';
  }
  const isYaml = isYamlUri(fileName);

  if (isYaml && segments.length >= 4 && segments[segments.length - 4] === 'roles') {
    const roleSubdir = segments[segments.length - 2];
    if (roleSubdir === 'tasks') {
      return 'tasks';
    }
    if (roleSubdir === 'handlers') {
      return 'handlers';
    }
    if (roleSubdir === 'defaults') {
      return 'role-defaults';
    }
    if (roleSubdir === 'vars') {
      return 'role-vars';
    }
  }

  if (dirSegments.includes('group_vars')) {
    return 'group-vars';
  }
  if (dirSegments.includes('host_vars')) {
    return 'host-vars';
  }

  if (
    isYaml &&
    (dirSegments.includes('inventory') ||
      dirSegments.includes('inventories') ||
      fileName === 'hosts.yml' ||
      fileName === 'hosts.yaml' ||
      fileName === 'inventory.yml' ||
      fileName === 'inventory.yaml')
  ) {
    return 'inventory';
  }

  if (isYaml && segments.length >= 2) {
    const parentDir = segments[segments.length - 2];
    if (parentDir === 'handlers') {
      return 'handlers';
    }
    if (parentDir === 'tasks') {
      return 'tasks';
    }
  }

  if (isYaml && (PLAYBOOK_FILENAMES.has(fileName) || dirSegments.includes('playbooks'))) {
    return 'playbook';
  }

  return undefined;
}

interface ParsedLineKey {
  readonly indent: number;
  readonly hasDash: boolean;
  readonly key: string;
}

function parseLineKey(rawLine: string): ParsedLineKey | undefined {
  let indent = 0;
  while (indent < rawLine.length) {
    const ch = rawLine.charCodeAt(indent);
    if (ch !== 32 && ch !== 9) {
      break;
    }
    indent++;
  }
  if (indent >= rawLine.length) {
    return undefined;
  }

  const afterIndent = rawLine.slice(indent);
  if (afterIndent.startsWith('#') || afterIndent === '---' || afterIndent === '...') {
    return undefined;
  }

  let hasDash = false;
  let content = afterIndent;
  if (afterIndent === '-' || afterIndent.startsWith('- ') || afterIndent.startsWith('-\t')) {
    hasDash = true;
    content = afterIndent.slice(1).trimStart();
  }

  const colonIdx = content.indexOf(':');
  if (colonIdx <= 0) {
    return hasDash ? { indent, hasDash: true, key: '' } : undefined;
  }

  const afterColon = content.slice(colonIdx + 1);
  if (afterColon.length > 0 && afterColon[0] !== ' ' && afterColon[0] !== '\t') {
    return undefined;
  }

  const key = content.slice(0, colonIdx).trim();
  return { indent, hasDash, key };
}

function scanDocumentLines(text: string): readonly ParsedLineKey[] {
  const rawLines = text.replaceAll('\r\n', '\n').split('\n');
  const parsed: ParsedLineKey[] = [];
  for (const rawLine of rawLines) {
    const entry = parseLineKey(rawLine);
    if (entry !== undefined) {
      parsed.push(entry);
    }
  }
  return parsed;
}

function hasNegativeYamlSignature(lines: readonly ParsedLineKey[]): string | undefined {
  let hasK8sApiVersion = false;
  let hasK8sKind = false;
  let hasServices = false;
  let hasComposeCompanion = false;
  let hasGhaOn = false;
  let hasGhaJobs = false;

  for (const line of lines) {
    if (!line.hasDash && line.indent === 0) {
      if (line.key === 'apiVersion') {
        hasK8sApiVersion = true;
      } else if (line.key === 'kind') {
        hasK8sKind = true;
      } else if (line.key === 'services') {
        hasServices = true;
      } else if (
        line.key === 'volumes' ||
        line.key === 'networks' ||
        line.key === 'version' ||
        line.key === 'configs' ||
        line.key === 'secrets'
      ) {
        hasComposeCompanion = true;
      } else if (line.key === 'on' || line.key === "'on'" || line.key === '"on"') {
        hasGhaOn = true;
      } else if (line.key === 'jobs') {
        hasGhaJobs = true;
      }
    } else if (!line.hasDash && line.indent >= 2) {
      if (
        line.key === 'image' ||
        line.key === 'build' ||
        line.key === 'ports' ||
        line.key === 'container_name'
      ) {
        hasComposeCompanion = true;
      }
    }
  }

  if (hasK8sApiVersion && hasK8sKind) {
    return 'negative-guard:kubernetes';
  }
  if (hasServices && hasComposeCompanion) {
    return 'negative-guard:docker-compose';
  }
  if (hasGhaOn && hasGhaJobs) {
    return 'negative-guard:github-actions';
  }
  return undefined;
}

function hasPlaybookContentSignature(lines: readonly ParsedLineKey[]): boolean {
  let hasDashHosts = false;
  let hasIndentedHosts = false;
  let hasPlayCompanion = false;

  for (const line of lines) {
    if (line.hasDash && line.key === 'hosts') {
      hasDashHosts = true;
    } else if (!line.hasDash && line.indent > 0 && line.key === 'hosts') {
      hasIndentedHosts = true;
    }
    if (
      (line.hasDash || line.indent > 0) &&
      (line.key === 'tasks' ||
        line.key === 'roles' ||
        line.key === 'pre_tasks' ||
        line.key === 'post_tasks' ||
        line.key === 'handlers' ||
        line.key === 'vars' ||
        line.key === 'vars_files' ||
        line.key === 'gather_facts' ||
        line.key === 'become' ||
        line.key === 'import_playbook')
    ) {
      hasPlayCompanion = true;
    }
  }

  return hasDashHosts || (hasIndentedHosts && hasPlayCompanion);
}

function isKnownFqcnKey(key: string): boolean {
  for (const prefix of KNOWN_COLLECTION_PREFIXES) {
    if (key.startsWith(prefix) && key.length > prefix.length) {
      return true;
    }
  }
  return false;
}

function hasTaskListContentSignature(lines: readonly ParsedLineKey[]): boolean {
  const first = lines[0];
  if (!first || !first.hasDash) {
    return false;
  }

  for (const line of lines) {
    if (line.hasDash || line.indent > 0) {
      if (TASK_SIGNATURE_DIRECTIVES.has(line.key) || isKnownFqcnKey(line.key)) {
        return true;
      }
    }
  }
  return false;
}

function hasInventoryContentSignature(lines: readonly ParsedLineKey[]): boolean {
  let hasTopAll = false;
  let hasSubKey = false;
  for (const line of lines) {
    if (!line.hasDash && line.indent === 0 && line.key === 'all') {
      hasTopAll = true;
    } else if (
      !line.hasDash &&
      line.indent > 0 &&
      (line.key === 'hosts' || line.key === 'children' || line.key === 'vars')
    ) {
      hasSubKey = true;
    }
  }
  return hasTopAll && hasSubKey;
}

/**
 * Classifies whether a YAML file/text is an Ansible document without false-positives
 * on Kubernetes manifests, Docker Compose files, or GitHub Actions workflows.
 */
export function detectAnsibleDocument(
  uri: string,
  text: string,
  hasWorkspaceAnsibleCfg = false,
): AnsibleHeuristicResult {
  const normalizedPath = normalizePath(uri);

  if (!isYamlUri(normalizedPath) && !normalizedPath.endsWith('.j2')) {
    const pathKindNoExt = classifyByPath(normalizedPath);
    if (!pathKindNoExt) {
      return {
        isAnsible: false,
        kind: 'unknown',
        reason: 'non-yaml-extension',
      };
    }
  }

  const parsedLines = scanDocumentLines(text);

  // 1. Fast negative guards always win over generic YAML filenames (even in ansible.cfg workspaces)
  const negativeReason = hasNegativeYamlSignature(parsedLines);
  if (negativeReason) {
    return {
      isAnsible: false,
      kind: 'unknown',
      reason: negativeReason,
    };
  }

  // 2. Content signatures (playbook / tasks / inventory) refine classification
  const pathKind = classifyByPath(normalizedPath);

  if (hasPlaybookContentSignature(parsedLines)) {
    return {
      isAnsible: true,
      kind: 'playbook',
      reason: pathKind ? `path+content:${pathKind}` : 'content:playbook',
    };
  }

  if (pathKind) {
    return {
      isAnsible: true,
      kind: pathKind,
      reason: `path:${pathKind}`,
    };
  }

  if (hasTaskListContentSignature(parsedLines)) {
    return {
      isAnsible: true,
      kind: 'tasks',
      reason: 'content:tasks',
    };
  }

  if (hasInventoryContentSignature(parsedLines)) {
    return {
      isAnsible: true,
      kind: 'inventory',
      reason: 'content:inventory',
    };
  }

  if (hasWorkspaceAnsibleCfg && isYamlUri(normalizedPath)) {
    return {
      isAnsible: true,
      kind: 'tasks',
      reason: 'workspace:ansible.cfg',
    };
  }

  return {
    isAnsible: false,
    kind: 'unknown',
    reason: 'no-ansible-signature',
  };
}
