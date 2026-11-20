import type {
  AnsibleDocumentAst,
  IMetadataRegistry,
  IWorkspaceFs,
  InferredRegisteredVariable,
  LintDiagnostic,
  ResolvedVariable,
  VariableDefinition,
} from '../contracts/types.js';

/**
 * Infers return-value schemas for all `register:` variables declared in an Ansible document AST.
 */
export function inferRegisteredVariables(
  _ast: AnsibleDocumentAst,
  _registry: IMetadataRegistry,
): ReadonlyMap<string, InferredRegisteredVariable> {
  return new Map<string, InferredRegisteredVariable>();
}

/**
 * Cross-file Workspace Variable Graph & 22-level Ansible Variable Precedence Resolver.
 */
export class WorkspaceVariableGraph {
  private readonly definitionsByName = new Map<string, VariableDefinition[]>();

  public addDefinition(def: VariableDefinition): void {
    const existing = this.definitionsByName.get(def.name) ?? [];
    existing.push(def);
    this.definitionsByName.set(def.name, existing);
  }

  public indexDocument(_ast: AnsibleDocumentAst): void {
    // Implemented by core-intelligence-linter worker
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

/**
 * Checks cross-file project integrity (missing roles, missing tasks/main.yml, broken notify handlers,
 * missing copy/template src files, unknown inventory hosts).
 */
export function checkProjectIntegrity(
  _ast: AnsibleDocumentAst,
  _workspaceRoot: string,
  _fs: IWorkspaceFs,
): readonly LintDiagnostic[] {
  return [];
}
