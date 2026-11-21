export { inferRegisteredVariables, resolveRegisteredFieldPath } from './returnInference.js';
export {
  ANSIBLE_PRECEDENCE_LEVELS,
  PRECEDENCE_TABLE,
  WorkspaceVariableGraph,
  type ClassifiedVariableSource,
  type PrecedenceSpec,
} from './variableGraph.js';
export {
  checkProjectIntegrity,
  discoverAnsibleProjectContext,
  parseAnsibleCfg,
  type AnsibleProjectContext,
  type ParsedAnsibleCfg,
} from './projectIntegrity.js';
export { findClosestMatch, levenshteinDistance } from './similarity.js';
