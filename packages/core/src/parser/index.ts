import type {
  AnsibleDocumentAst,
  AnsibleDocumentKind,
  AnsibleHeuristicResult,
  JinjaBlockKind,
  JinjaBlockNode,
  SourcePosition,
} from '../contracts/types.js';

/**
 * Tokenizes a Jinja2 block or implicit conditional string into tokens, variables, filters, and tests.
 */
export function tokenizeJinjaBlock(
  raw: string,
  kind: JinjaBlockKind = 'expression',
  baseOffset = 0,
  baseLine = 0,
  baseColumn = 0,
): JinjaBlockNode {
  const start: SourcePosition = { line: baseLine, column: baseColumn, offset: baseOffset };
  const end: SourcePosition = {
    line: baseLine,
    column: baseColumn + raw.length,
    offset: baseOffset + raw.length,
  };
  return {
    kind,
    raw,
    content: raw,
    range: { start, end },
    tokens: [],
    variables: [],
    filters: [],
    tests: [],
    unclosed: false,
  };
}

/**
 * Classifies whether a YAML file/text is an Ansible document without false-positives on k8s/docker/github YAML.
 */
export function detectAnsibleDocument(
  uri: string,
  text: string,
  hasWorkspaceAnsibleCfg = false,
): AnsibleHeuristicResult {
  const kind: AnsibleDocumentKind = hasWorkspaceAnsibleCfg && uri.endsWith('.yml') ? 'tasks' : 'unknown';
  return {
    isAnsible: kind !== 'unknown' && text.length >= 0,
    kind,
    reason: 'stub',
  };
}

/**
 * Fault-tolerant YAML CST + Jinja2 parser producing an `AnsibleDocumentAst`.
 */
export function parseAnsibleDocument(
  uri: string,
  text: string,
  forcedKind?: AnsibleDocumentKind,
): AnsibleDocumentAst {
  return {
    uri,
    kind: forcedKind ?? 'unknown',
    text,
    plays: [],
    tasks: [],
    handlers: [],
    variables: [],
    jinjaBlocks: [],
    duplicateKeys: [],
    rawTruthyValues: [],
    syntaxErrors: [],
  };
}
