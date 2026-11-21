/**
 * Shared domain contracts for `@ansible-lens/core`.
 *
 * Pure TypeScript interfaces with zero VS Code dependencies.
 */

/** 0-indexed line, column, and character offset in a source document. */
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

/** Half-open `[start, end)` source span in a document. */
export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

/** Classification of a Jinja2 block. */
export type JinjaBlockKind = 'expression' | 'statement' | 'comment' | 'implicit';

/** Token kind emitted by the lightweight Jinja2 lexical scanner. */
export type JinjaTokenKind =
  'variable' | 'filter' | 'test' | 'operator' | 'literal' | 'keyword' | 'punctuation';

/** Individual lexical token inside a Jinja2 block. */
export interface JinjaToken {
  readonly kind: JinjaTokenKind;
  readonly value: string;
  readonly range: SourceRange;
}

/** Variable reference inside a Jinja2 expression (e.g. `res.results[0].item`). */
export interface JinjaVariableRef {
  readonly root: string;
  readonly path: readonly string[];
  readonly raw: string;
  readonly range: SourceRange;
}

/** Parsed Jinja2 expression, statement, comment, or implicit conditional expression. */
export interface JinjaBlockNode {
  readonly kind: JinjaBlockKind;
  readonly raw: string;
  readonly content: string;
  readonly range: SourceRange;
  readonly tokens: readonly JinjaToken[];
  readonly variables: readonly JinjaVariableRef[];
  readonly filters: readonly string[];
  readonly tests: readonly string[];
  readonly unclosed: boolean;
}

/** Classification of an Ansible or YAML document. */
export type AnsibleDocumentKind =
  | 'playbook'
  | 'tasks'
  | 'handlers'
  | 'role-vars'
  | 'role-defaults'
  | 'group-vars'
  | 'host-vars'
  | 'inventory'
  | 'unknown';

/** Duplicate mapping key occurrence detected in YAML CST/AST. */
export interface DuplicateKeyOccurrence {
  readonly key: string;
  readonly range: SourceRange;
}

/** Non-standard YAML 1.1 truthy literal occurrence (`yes`, `no`, `on`, `off`, `TRUE`, `FALSE`). */
export interface RawTruthyOccurrence {
  readonly key?: string;
  readonly rawValue: string;
  readonly range: SourceRange;
}

/** Parameter passed to an Ansible module invocation. */
export interface TaskParamNode {
  readonly name: string;
  readonly keyRange: SourceRange;
  readonly valueRange: SourceRange;
  readonly rawText: string;
  readonly value: unknown;
  readonly suboptions?: readonly TaskParamNode[];
  readonly jinjaBlocks: readonly JinjaBlockNode[];
}

/** Loop keyword flavors supported by Ansible tasks. */
export type TaskLoopKind =
  | 'loop'
  | 'with_items'
  | 'with_dict'
  | 'with_list'
  | 'with_flattened'
  | 'with_subelements'
  | 'with_sequence';

/** Parsed Ansible task or handler entry. */
export interface TaskNode {
  readonly name?: string;
  readonly nameRange?: SourceRange;
  readonly moduleName: string;
  readonly moduleRange: SourceRange;
  readonly isFqcn: boolean;
  readonly params: readonly TaskParamNode[];
  readonly freeFormArg?: string;
  readonly register?: string;
  readonly registerRange?: SourceRange;
  readonly loop?: unknown;
  readonly loopKind?: TaskLoopKind;
  readonly loopVar?: string;
  readonly when?: string;
  readonly whenRange?: SourceRange;
  readonly changedWhen?: string | boolean;
  readonly changedWhenRange?: SourceRange;
  readonly failedWhen?: string | boolean;
  readonly failedWhenRange?: SourceRange;
  readonly notify?: readonly string[];
  readonly notifyRange?: SourceRange;
  readonly noLog?: boolean;
  readonly become?: boolean;
  readonly tags?: readonly string[];
  readonly vars?: Readonly<Record<string, unknown>>;
  readonly duplicateKeys: readonly DuplicateKeyOccurrence[];
  readonly rawTruthyKeys: readonly RawTruthyOccurrence[];
  readonly range: SourceRange;
}

/** Role reference in a playbook's `roles:` section or `include_role`/`import_role`. */
export interface RoleRefNode {
  readonly name: string;
  readonly range: SourceRange;
  readonly vars?: Readonly<Record<string, unknown>>;
}

/** `vars_files:` entry inside a play. */
export interface VarsFileRefNode {
  readonly path: string;
  readonly range: SourceRange;
}

/** Parsed play within an Ansible playbook. */
export interface PlayNode {
  readonly name?: string;
  readonly hosts?: string;
  readonly hostsRange?: SourceRange;
  readonly become?: boolean;
  readonly vars?: Readonly<Record<string, unknown>>;
  readonly varsFiles: readonly VarsFileRefNode[];
  readonly roles: readonly RoleRefNode[];
  readonly preTasks: readonly TaskNode[];
  readonly tasks: readonly TaskNode[];
  readonly postTasks: readonly TaskNode[];
  readonly handlers: readonly TaskNode[];
  readonly range: SourceRange;
}

/** Origin classification of a variable declaration. */
export type VariableSourceKind =
  | 'role-defaults'
  | 'inventory-file'
  | 'inventory-group-vars'
  | 'playbook-group-vars-all'
  | 'playbook-group-vars'
  | 'inventory-host-vars'
  | 'playbook-host-vars'
  | 'host-facts'
  | 'play-vars'
  | 'play-vars-prompt'
  | 'play-vars-files'
  | 'role-vars'
  | 'block-vars'
  | 'task-vars'
  | 'include-vars'
  | 'set-fact'
  | 'register'
  | 'role-params'
  | 'include-params'
  | 'extra-vars';

/** Variable declaration node in any Ansible YAML or inventory file. */
export interface VariableDeclNode {
  readonly name: string;
  readonly value: unknown;
  readonly rawValue: string;
  readonly keyRange: SourceRange;
  readonly valueRange: SourceRange;
  readonly sourceKind: VariableSourceKind;
}

/** Non-fatal syntax error captured during fault-tolerant YAML or Jinja2 parsing. */
export interface ParseSyntaxError {
  readonly message: string;
  readonly range: SourceRange;
  readonly code: string;
}

/** Complete fault-tolerant AST produced for an Ansible YAML document. */
export interface AnsibleDocumentAst {
  readonly uri: string;
  readonly kind: AnsibleDocumentKind;
  readonly text: string;
  readonly plays: readonly PlayNode[];
  readonly tasks: readonly TaskNode[];
  readonly handlers: readonly TaskNode[];
  readonly variables: readonly VariableDeclNode[];
  readonly jinjaBlocks: readonly JinjaBlockNode[];
  readonly duplicateKeys: readonly DuplicateKeyOccurrence[];
  readonly rawTruthyValues: readonly RawTruthyOccurrence[];
  readonly syntaxErrors: readonly ParseSyntaxError[];
}

/** Heuristic evaluation result for Smart Hybrid Activation. */
export interface AnsibleHeuristicResult {
  readonly isAnsible: boolean;
  readonly kind: AnsibleDocumentKind;
  readonly reason: string;
}

/** Ansible module parameter data types. */
export type ModuleOptionType =
  | 'str'
  | 'int'
  | 'float'
  | 'bool'
  | 'list'
  | 'dict'
  | 'path'
  | 'raw'
  | 'jsonarg'
  | 'sid'
  | 'bits'
  | 'bytes';

/** Specification for a single module parameter or nested suboption. */
export interface ModuleOptionSpec {
  readonly name: string;
  readonly type: ModuleOptionType;
  readonly elements?: ModuleOptionType;
  readonly required?: boolean;
  readonly default?: unknown;
  readonly choices?: readonly (string | number | boolean)[];
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly versionAdded?: string;
  readonly suboptions?: Readonly<Record<string, ModuleOptionSpec>>;
}

/** Specification for a module return value field in `RETURN`. */
export interface ModuleReturnFieldSpec {
  readonly name: string;
  readonly type: ModuleOptionType;
  readonly returned: string;
  readonly description: string;
  readonly sample?: unknown;
  readonly contains?: Readonly<Record<string, ModuleReturnFieldSpec>>;
}

/** Deprecation metadata for a module. */
export interface ModuleDeprecationInfo {
  readonly removedIn?: string;
  readonly why: string;
  readonly alternative?: string;
}

/** Full static metadata specification for an Ansible module. */
export interface ModuleMetadataSpec {
  readonly fqcn: string;
  readonly shortName: string;
  readonly collection: string;
  readonly shortDescription: string;
  readonly description: string;
  readonly docUrl: string;
  readonly deprecated?: ModuleDeprecationInfo;
  readonly options: Readonly<Record<string, ModuleOptionSpec>>;
  readonly returnFields: Readonly<Record<string, ModuleReturnFieldSpec>>;
}

/** Compressed collection pack JSON structure (`<collection>.json.gz`). */
export interface CollectionMetadataPack {
  readonly schemaVersion: 1;
  readonly collection: string;
  readonly version: string;
  readonly generatedAt: string;
  readonly modules: Readonly<Record<string, ModuleMetadataSpec>>;
}

/** Single collection entry inside `manifest.json`. */
export interface CollectionPackManifestEntry {
  readonly collection: string;
  readonly version: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly moduleCount: number;
  readonly downloadUrl?: string;
}

/** Release manifest for verifying SHA-256 integrity and checking delta updates. */
export interface MetadataManifest {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly ansibleCoreVersion: string;
  readonly collections: Readonly<Record<string, CollectionPackManifestEntry>>;
}

/** Read-only query interface for looking up module schemas by FQCN or short name. */
export interface IMetadataRegistry {
  getModule(nameOrFqcn: string): ModuleMetadataSpec | undefined;
  resolveFqcn(shortOrFqcn: string): readonly ModuleMetadataSpec[];
  listModules(): readonly ModuleMetadataSpec[];
  listCollections(): readonly string[];
}

/** Inferred return field on a `register:` variable. */
export interface InferredReturnField {
  readonly name: string;
  readonly type: ModuleOptionType;
  readonly description: string;
  readonly returned: string;
  readonly docUrl?: string;
  readonly sample?: unknown;
  readonly children?: Readonly<Record<string, InferredReturnField>>;
}

/** Inferred type & return-value schema for a task's `register: <varName>` binding. */
export interface InferredRegisteredVariable {
  readonly name: string;
  readonly taskName?: string;
  readonly moduleFqcn: string;
  readonly uri: string;
  readonly range: SourceRange;
  readonly isLoop: boolean;
  readonly fields: Readonly<Record<string, InferredReturnField>>;
}

/** Variable definition tracked in the 22-level precedence graph. */
export interface VariableDefinition {
  readonly name: string;
  readonly value: unknown;
  readonly rawValue: string;
  readonly precedenceLevel: number;
  readonly precedenceLabel: string;
  readonly sourceKind: VariableSourceKind;
  readonly uri: string;
  readonly range: SourceRange;
}

/** Resolved variable across all definitions in the workspace according to 22-level precedence. */
export interface ResolvedVariable {
  readonly name: string;
  readonly winningDefinition: VariableDefinition;
  readonly shadowedDefinitions: readonly VariableDefinition[];
  readonly allDefinitions: readonly VariableDefinition[];
}

/** Diagnostic severity level. */
export type LintSeverity = 'error' | 'warning' | 'info';

/** Identifiers for all clean-room static lint and project integrity rules. */
export type LintRuleId =
  | 'yaml-syntax'
  | 'unknown-module'
  | 'unknown-param'
  | 'missing-required-param'
  | 'invalid-choice'
  | 'param-type-mismatch'
  | 'fqcn'
  | 'name-missing'
  | 'no-changed-when'
  | 'command-instead-of-module'
  | 'package-latest'
  | 'risky-file-permissions'
  | 'deprecated-module'
  | 'hardcoded-secret'
  | 'yaml-truthy'
  | 'duplicate-keys'
  | 'missing-role'
  | 'missing-role-tasks'
  | 'missing-handler'
  | 'missing-src-file'
  | 'unknown-inventory-host'
  | 'undefined-variable'
  | 'var-naming[no-role-prefix]';

/** Configuration options passed to `lintAnsibleDocument`. */
export interface LintOptions {
  /** Known workspace variable names (from `WorkspaceVariableGraph`, `register:`, `set_fact:`, etc.). */
  readonly knownVariables?: ReadonlySet<string>;
  /** User-configured extra variable names (`ansibleLens.lint.extraVars`). */
  readonly extraVars?: readonly string[];
  /** Lint profile level (`minimal`, `basic`, `moderate`, `production`). */
  readonly profile?: 'minimal' | 'basic' | 'moderate' | 'production';
  /** Per-rule severity overrides (`error`, `warning`, `info`, or `off`). */
  readonly ruleOverrides?: Readonly<Record<string, LintSeverity | 'off'>>;
}

/** Text replacement edit for a Quick-Fix action. */
export interface TextEditSpec {
  readonly range: SourceRange;
  readonly newText: string;
}

/** 1-click Quick-Fix attached to a lint diagnostic. */
export interface QuickFixAction {
  readonly title: string;
  readonly ruleId: LintRuleId;
  readonly edits: readonly TextEditSpec[];
  readonly isPreferred?: boolean;
}

/** Static lint or project-integrity diagnostic emitted by `@ansible-lens/core`. */
export interface LintDiagnostic {
  readonly ruleId: LintRuleId;
  readonly message: string;
  readonly severity: LintSeverity;
  readonly range: SourceRange;
  readonly docUrl?: string;
  readonly quickFixes: readonly QuickFixAction[];
}

/** Injectable virtual filesystem interface for deterministic, testable workspace checks. */
export interface IWorkspaceFs {
  exists(filePath: string): boolean;
  readFile(filePath: string): string | undefined;
  listFiles(dirPath: string): readonly string[];
}
