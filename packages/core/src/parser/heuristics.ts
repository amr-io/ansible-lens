import type { AnsibleDocumentKind, AnsibleHeuristicResult } from '../contracts/types.js';

function normalizePath(uri: string): string {
  // Normalize Windows backslashes and strip file:// URI prefix + drive letters cleanly
  const withoutScheme = uri.replace(/^file:\/\/\//i, '/').replace(/^file:\/\//i, '');
  return withoutScheme.replace(/\\/g, '/').toLowerCase();
}

function isYamlUri(normalizedPath: string): boolean {
  return (
    normalizedPath.endsWith('.yml') ||
    normalizedPath.endsWith('.yaml') ||
    normalizedPath.endsWith('.ansible.yml') ||
    normalizedPath.endsWith('.ansible.yaml')
  );
}

function classifyByPath(normalizedPath: string): AnsibleDocumentKind | undefined {
  // Role files
  if (
    /\/roles\/[^/]+\/tasks\/[^/]+\.ya?ml$/.test(normalizedPath) ||
    /^roles\/[^/]+\/tasks\/[^/]+\.ya?ml$/.test(normalizedPath)
  ) {
    return 'tasks';
  }
  if (
    /\/roles\/[^/]+\/handlers\/[^/]+\.ya?ml$/.test(normalizedPath) ||
    /^roles\/[^/]+\/handlers\/[^/]+\.ya?ml$/.test(normalizedPath)
  ) {
    return 'handlers';
  }
  if (
    /\/roles\/[^/]+\/defaults\/[^/]+\.ya?ml$/.test(normalizedPath) ||
    /^roles\/[^/]+\/defaults\/[^/]+\.ya?ml$/.test(normalizedPath)
  ) {
    return 'role-defaults';
  }
  if (
    /\/roles\/[^/]+\/vars\/[^/]+\.ya?ml$/.test(normalizedPath) ||
    /^roles\/[^/]+\/vars\/[^/]+\.ya?ml$/.test(normalizedPath)
  ) {
    return 'role-vars';
  }

  // Group / Host vars
  if (/(?:^|\/)group_vars\/.+/.test(normalizedPath)) {
    return 'group-vars';
  }
  if (/(?:^|\/)host_vars\/.+/.test(normalizedPath)) {
    return 'host-vars';
  }

  // Inventory directories or explicit inventory YAML files
  if (
    /(?:^|\/)inventory\/.+\.ya?ml$/.test(normalizedPath) ||
    /(?:^|\/)inventories\/.+\.ya?ml$/.test(normalizedPath) ||
    /(?:^|\/)(?:hosts|inventory)\.ya?ml$/.test(normalizedPath)
  ) {
    return 'inventory';
  }

  // Handlers standalone directory
  if (/(?:^|\/)handlers\/[^/]+\.ya?ml$/.test(normalizedPath)) {
    return 'handlers';
  }

  // Tasks standalone directory
  if (/(?:^|\/)tasks\/[^/]+\.ya?ml$/.test(normalizedPath)) {
    return 'tasks';
  }

  // Common playbook filenames and directories
  if (
    /(?:^|\/)(?:site|playbook|main|deploy|provision|setup)\.ya?ml$/.test(normalizedPath) ||
    /(?:^|\/)playbooks\/.+\.ya?ml$/.test(normalizedPath)
  ) {
    return 'playbook';
  }

  return undefined;
}

function hasNegativeYamlSignature(text: string): string | undefined {
  // Kubernetes manifest: top-level `apiVersion:` and `kind:`
  const hasK8sApiVersion = /^apiVersion\s*:/m.test(text);
  const hasK8sKind = /^kind\s*:/m.test(text);
  if (hasK8sApiVersion && hasK8sKind) {
    return 'negative-guard:kubernetes';
  }

  // Docker Compose: top-level `services:` paired with `volumes:`, `networks:`, or `version:` (or `services:` with `image:`/`build:`)
  const hasServices = /^services\s*:/m.test(text);
  const hasComposeCompanion =
    /^(?:volumes|networks|version|configs|secrets)\s*:/m.test(text) ||
    /^\s{2,}(?:image|build|ports|container_name)\s*:/m.test(text);
  if (hasServices && hasComposeCompanion) {
    return 'negative-guard:docker-compose';
  }

  // GitHub Actions workflow: top-level `on:` (or `'on':`) paired with `jobs:`
  const hasGhaOn = /^(?:on|'on'|"on")\s*:/m.test(text);
  const hasGhaJobs = /^jobs\s*:/m.test(text);
  if (hasGhaOn && hasGhaJobs) {
    return 'negative-guard:github-actions';
  }

  return undefined;
}

function hasPlaybookContentSignature(text: string): boolean {
  const hasHosts = /^(?:\s*-\s+hosts\s*:|\s+hosts\s*:)/m.test(text);
  if (!hasHosts) {
    return false;
  }
  return (
    /^(?:\s*-\s+|\s+)(?:tasks|roles|pre_tasks|post_tasks|handlers|vars|vars_files|gather_facts|become|import_playbook)\s*:/m.test(
      text,
    ) || /^(?:\s*-\s+hosts\s*:)/m.test(text)
  );
}

function hasTaskListContentSignature(text: string): boolean {
  const startsWithSeq = /^\s*(?:---(?:\s|$)\s*)?-\s+/m.test(text);
  if (!startsWithSeq) {
    return false;
  }

  // Look for common Ansible task directives or FQCN module calls
  const hasAnsibleTaskDirective =
    /^(?:\s*-\s+|\s+)(?:name|block|rescue|always|register|when|changed_when|failed_when|notify|loop|with_items|with_dict|with_list|become|delegate_to|import_tasks|include_tasks|include_role|import_role)\s*:/m.test(
      text,
    );
  const hasFqcnModule =
    /^(?:\s*-\s+|\s+)(?:ansible\.builtin|ansible\.posix|community\.general|community\.docker|community\.crypto|ansible\.windows|amazon\.aws|kubernetes\.core|community\.mysql|community\.postgresql|ansible\.utils)\.[a-z0-9_]+\s*:/m.test(
      text,
    );

  return hasAnsibleTaskDirective || hasFqcnModule;
}

function hasInventoryContentSignature(text: string): boolean {
  return /^all\s*:/m.test(text) && /^\s+(?:hosts|children|vars)\s*:/m.test(text);
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
    // Allow explicit `hosts` / `group_vars` / `host_vars` extensionless files when inside Ansible directories
    const pathKindNoExt = classifyByPath(normalizedPath);
    if (!pathKindNoExt) {
      return {
        isAnsible: false,
        kind: 'unknown',
        reason: 'non-yaml-extension',
      };
    }
  }

  // 1. Fast negative guards always win over generic YAML filenames (even in ansible.cfg workspaces)
  const negativeReason = hasNegativeYamlSignature(text);
  if (negativeReason) {
    return {
      isAnsible: false,
      kind: 'unknown',
      reason: negativeReason,
    };
  }

  // 2. Content signatures (playbook / tasks / inventory) refine classification
  const pathKind = classifyByPath(normalizedPath);

  if (hasPlaybookContentSignature(text)) {
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

  if (hasTaskListContentSignature(text)) {
    return {
      isAnsible: true,
      kind: 'tasks',
      reason: 'content:tasks',
    };
  }

  if (hasInventoryContentSignature(text)) {
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
