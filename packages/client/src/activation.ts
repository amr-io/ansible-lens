import path from 'node:path';
import type { AnsibleHeuristicResult } from '@ansible-lens/core';
import { evaluateAnsibleHeuristic } from '@ansible-lens/server';

export interface DocumentCandidate {
  readonly uri: string;
  readonly languageId: string;
  readonly text: string;
}

/**
 * Smart Hybrid Activation evaluator for VS Code documents.
 *
 * Dynamically evaluates `yaml` and `ansible` documents using Ansible path and
 * content heuristics while explicitly ignoring Kubernetes, Docker Compose, and
 * GitHub Actions YAML files so `redhat.vscode-yaml` continues uninterrupted.
 */
export function shouldActivateForDocument(
  doc: DocumentCandidate,
  hasWorkspaceAnsibleCfg: boolean,
): AnsibleHeuristicResult {
  if (doc.languageId === 'ansible') {
    const result = evaluateAnsibleHeuristic(doc.uri, doc.text, hasWorkspaceAnsibleCfg);
    if (result.isAnsible) {
      return result;
    }
    return {
      isAnsible: true,
      kind: 'playbook',
      reason: 'Explicit ansible languageId',
    };
  }

  if (doc.languageId !== 'yaml') {
    return {
      isAnsible: false,
      kind: 'unknown',
      reason: `Ignored non-YAML languageId "${doc.languageId}"`,
    };
  }

  return evaluateAnsibleHeuristic(doc.uri, doc.text, hasWorkspaceAnsibleCfg);
}

/**
 * Checks if any provided workspace folder path contains an `ansible.cfg` file
 * via an injected existence predicate.
 */
export function workspaceHasAnsibleCfg(
  folderPaths: readonly string[],
  fileExists: (filePath: string) => boolean,
): boolean {
  for (const folder of folderPaths) {
    if (fileExists(path.join(folder, 'ansible.cfg'))) {
      return true;
    }
  }
  return false;
}
