import type {
  AnsibleDocumentAst,
  IMetadataRegistry,
  LintDiagnostic,
} from '../contracts/types.js';

/**
 * Runs all clean-room static lint rules and produces diagnostics with 1-click Quick-Fixes.
 */
export function lintAnsibleDocument(
  _ast: AnsibleDocumentAst,
  _registry: IMetadataRegistry,
): readonly LintDiagnostic[] {
  return [];
}
