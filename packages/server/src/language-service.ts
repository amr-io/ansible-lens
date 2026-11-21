import os from 'node:os';
import path from 'node:path';
import type {
  AnsibleDocumentAst,
  IMetadataFetcher,
  IWorkspaceFs,
  InferredRegisteredVariable,
  InferredReturnField,
  LintDiagnostic,
  LintOptions,
  LintSeverity,
  MetadataRegistry,
  SourcePosition,
  SourceRange,
  TaskNode,
} from '@ansible-lens/core';
import {
  DEFAULT_MANIFEST_URL,
  MetadataPackLoader,
  NodeMetadataFetcher,
  WorkspaceVariableGraph,
  applyLintConfiguration,
  checkProjectIntegrity,
  createDefaultMetadataRegistry,
  discoverAnsibleProjectContext,
  inferRegisteredVariables,
  lintAnsibleDocument,
} from '@ansible-lens/core';
import {
  CodeActionKind,
  CompletionItemKind,
  DiagnosticSeverity,
  MarkupKind,
  type CodeAction,
  type CompletionItem,
  type Diagnostic,
  type Hover,
  type Location,
  type LocationLink,
  type Position,
  type Range,
  type TextEdit,
} from 'vscode-languageserver/node.js';
import {
  ANSIBLE_FACTS_FIELDS,
  ANSIBLE_MAGIC_VARS,
  COMMON_REGISTER_RETURN_FIELDS,
  JINJA_FILTERS,
  JINJA_TESTS,
  PLAY_AND_TASK_KEYWORDS,
  TASK_LEVEL_NON_MODULE_KEYS,
} from './ansible-reference.js';
import {
  collectAllTasks,
  evaluateAnsibleHeuristic,
  extractVariableDefinitionsFromAst,
  fallbackLintDocument,
  inferRegisteredVariablesFallback,
  parseDocumentWithFallback,
} from './ast-fallback.js';
import { ensureFallbackModulesLoaded } from './fallback-catalog.js';
import {
  formatModuleDocsPageMarkdown,
  formatModuleHoverMarkdown,
  formatParameterHoverMarkdown,
  formatRegisteredVarHoverMarkdown,
  formatReturnFieldHoverMarkdown,
  formatUnloadedModuleDocsPageMarkdown,
  formatVariablePrecedenceHoverMarkdown,
} from './hover-formatter.js';
import { createServerLogger, type ServerLogger } from './logger.js';
import { NodeWorkspaceFs, fsPathToUri, normalizeDocumentUri, uriToFsPath } from './workspace-fs.js';

/** A single watched-file change event reported by the LSP client. */
export interface WatchedFileChange {
  readonly uri: string;
  readonly deleted: boolean;
  /** Optional in-memory buffer text when the changed file is currently open in the editor. */
  readonly openDocumentText?: string;
}

/** Summary returned by `AnsibleLanguageService.applyWatchedFileChanges`. */
export interface WatchedFileBatchResult {
  readonly needsFullWorkspaceReindex: boolean;
  readonly affectsSharedProviders: boolean;
  readonly updatedUris: readonly string[];
}

export interface InventoryInfo {
  readonly hosts: readonly string[];
  readonly groups: readonly string[];
}

export interface LintConfiguration {
  readonly enabled?: boolean;
  readonly profile?: 'minimal' | 'basic' | 'moderate' | 'production';
  readonly rules?: Readonly<Record<string, LintSeverity | 'off'>>;
  readonly extraVars?: readonly string[];
}

export interface MetadataConfiguration {
  readonly autoDownload?: boolean;
  readonly manifestUrl?: string;
}

export type DocsCtrlClickBehavior = 'renderedPreview' | 'openInBrowser' | 'disabled';

export interface ServerSettings {
  readonly docsCtrlClickBehavior?: DocsCtrlClickBehavior;
  readonly lint?: LintConfiguration;
  readonly metadata?: MetadataConfiguration;
  readonly ansibleRootPaths?: readonly string[];
}

export interface DiagnosticsInfoReport {
  readonly detectedAnsibleRoot: string | undefined;
  readonly workspaceRoots: readonly string[];
  readonly ansibleRootPaths: readonly string[];
  readonly loadedCollections: readonly string[];
  readonly loadedModulesCount: number;
  readonly indexedDocumentsCount: number;
  readonly indexedVariablesCount: number;
  readonly recentErrors: readonly string[];
}

export interface LanguageServiceOptions {
  readonly registry?: MetadataRegistry;
  readonly fs?: IWorkspaceFs;
  readonly logger?: ServerLogger;
  readonly workspaceRoots?: readonly string[];
  readonly docsCtrlClickBehavior?: DocsCtrlClickBehavior;
  readonly lintConfig?: LintConfiguration;
  readonly metadataConfig?: MetadataConfiguration;
  readonly ansibleRootPaths?: readonly string[];
  readonly cacheDir?: string;
  readonly fetcher?: IMetadataFetcher;
}

interface IndexedDocumentEntry {
  readonly uri: string;
  readonly text: string;
  readonly ast: AnsibleDocumentAst;
}

/**
 * Pure, testable Ansible Language Service engine backing the LSP connection.
 *
 * Manages document indexing, Smart Hybrid Activation, cross-file variable graph,
 * inventory host/group parsing, diagnostics, completions, hovers,
 * go-to-definition, find-references, and code actions.
 */
export class AnsibleLanguageService {
  private readonly registry: MetadataRegistry;
  private readonly fs: IWorkspaceFs;
  private readonly logger: ServerLogger;
  private readonly documents = new Map<string, IndexedDocumentEntry>();
  private readonly externalVarsFileUris = new Set<string>();
  private readonly referencedVarsFileUris = new Set<string>();
  private readonly workspaceRoots: string[] = [];
  private ansibleRootPaths: string[] = [];
  private variableGraph = new WorkspaceVariableGraph();
  private docsCtrlClickBehavior: DocsCtrlClickBehavior;
  private lintEnabled = true;
  private lintProfile: 'minimal' | 'basic' | 'moderate' | 'production' = 'moderate';
  private lintRuleOverrides: Readonly<Record<string, LintSeverity | 'off'>> = {};
  private lintExtraVars: readonly string[] = [];
  private autoDownloadEnabled = true;
  private manifestUrl: string = DEFAULT_MANIFEST_URL;
  private readonly cacheDir: string;
  private readonly fetcher: IMetadataFetcher;
  private readonly inflightCollections = new Set<string>();
  private readonly failedCollections = new Set<string>();
  private readonly recentErrors: string[] = [];

  public constructor(options?: LanguageServiceOptions) {
    this.registry = options?.registry ?? createDefaultMetadataRegistry();
    ensureFallbackModulesLoaded(this.registry);
    this.fs = options?.fs ?? new NodeWorkspaceFs();
    this.logger = options?.logger ?? createServerLogger('AnsibleLanguageService');
    this.docsCtrlClickBehavior = options?.docsCtrlClickBehavior ?? 'renderedPreview';
    this.cacheDir =
      options?.cacheDir ?? path.join(os.homedir(), '.cache', 'ansible-lens', 'metadata');
    this.fetcher = options?.fetcher ?? new NodeMetadataFetcher();
    if (options?.lintConfig) {
      this.setLintConfiguration(options.lintConfig);
    }
    if (options?.metadataConfig) {
      this.setMetadataConfiguration(options.metadataConfig);
    }
    if (options?.ansibleRootPaths) {
      this.setAnsibleRootPaths(options.ansibleRootPaths);
    }
    if (options?.workspaceRoots) {
      for (const root of options.workspaceRoots) {
        this.addWorkspaceRoot(root);
      }
    }
  }

  public recordError(message: string): void {
    this.recentErrors.push(message);
    if (this.recentErrors.length > 20) {
      this.recentErrors.shift();
    }
  }

  public applySettings(settings: ServerSettings): void {
    if (
      settings.docsCtrlClickBehavior === 'renderedPreview' ||
      settings.docsCtrlClickBehavior === 'openInBrowser' ||
      settings.docsCtrlClickBehavior === 'disabled'
    ) {
      this.docsCtrlClickBehavior = settings.docsCtrlClickBehavior;
    }
    if (settings.lint) {
      this.setLintConfiguration(settings.lint);
    }
    if (settings.metadata) {
      this.setMetadataConfiguration(settings.metadata);
    }
    if (settings.ansibleRootPaths) {
      this.setAnsibleRootPaths(settings.ansibleRootPaths);
    }
  }

  public setMetadataConfiguration(config: MetadataConfiguration): void {
    if (typeof config.autoDownload === 'boolean') {
      this.autoDownloadEnabled = config.autoDownload;
    }
    if (typeof config.manifestUrl === 'string' && config.manifestUrl.trim().length > 0) {
      this.manifestUrl = config.manifestUrl.trim();
    }
  }

  public isAutoDownloadEnabled(): boolean {
    return this.autoDownloadEnabled;
  }

  public getManifestUrl(): string {
    return this.manifestUrl;
  }

  public setAnsibleRootPaths(rootPaths: readonly string[]): void {
    const resolved: string[] = [];
    const baseRoot = this.workspaceRoots[0];
    for (const p of rootPaths) {
      if (typeof p !== 'string' || p.trim().length === 0) {
        continue;
      }
      const trimmed = p.trim();
      const target =
        baseRoot && !path.isAbsolute(trimmed) && !trimmed.startsWith('/')
          ? resolveRelativeFsPath(baseRoot, trimmed)
          : uriToFsPath(trimmed);
      if (!resolved.includes(target)) {
        resolved.push(target);
      }
    }
    this.ansibleRootPaths = resolved;
  }

  public getAnsibleRootPaths(): readonly string[] {
    return this.ansibleRootPaths;
  }

  /**
   * Returns unloaded collection names (`<ns>.<name>`) referenced by FQCN tasks in `uri` / `text`
   * that have not yet been loaded or permanently failed in this session.
   */
  public findUnloadedCollectionsInDocument(uri: string, text?: string): readonly string[] {
    const canonicalUri = normalizeDocumentUri(uri);
    const docText = text ?? this.documents.get(canonicalUri)?.text;
    if (docText === undefined) {
      return [];
    }
    const hasCfg = this.hasAnsibleCfgForUri(canonicalUri);
    const heuristic = evaluateAnsibleHeuristic(canonicalUri, docText, hasCfg);
    if (!heuristic.isAnsible || heuristic.kind === 'template') {
      return [];
    }
    const ast = parseDocumentWithFallback(canonicalUri, docText, heuristic.kind, this.registry);
    const loaded = new Set(this.registry.listCollections());
    const unloaded = new Set<string>();

    for (const task of collectAllTasks(ast)) {
      const col = extractCollectionFromFqcn(task.moduleName);
      if (
        col &&
        col !== 'ansible.builtin' &&
        col !== 'ansible.legacy' &&
        !loaded.has(col) &&
        !this.inflightCollections.has(col) &&
        !this.failedCollections.has(col)
      ) {
        unloaded.add(col);
      }
    }
    return Array.from(unloaded);
  }

  /**
   * Lazily downloads and loads the requested collection metadata packs in the background
   * using `MetadataPackLoader.syncFromManifest` with SHA-256 verification.
   */
  public async downloadCollections(collections: readonly string[]): Promise<readonly string[]> {
    const targets = collections.filter(
      (c) => !this.inflightCollections.has(c) && !this.registry.listCollections().includes(c),
    );
    if (targets.length === 0) {
      return [];
    }
    for (const c of targets) {
      this.inflightCollections.add(c);
    }
    const loadedNow: string[] = [];
    try {
      const loader = new MetadataPackLoader(this.cacheDir, this.fetcher);
      const { packs, result } = await loader.syncFromManifest(this.manifestUrl, targets);
      for (const [colName, pack] of packs.entries()) {
        this.registry.loadPack(pack);
        loadedNow.push(colName);
      }
      for (const err of result.errors) {
        this.recordError(err);
        this.logger.warn('Metadata pack sync warning', { error: err });
      }
      for (const c of targets) {
        if (!packs.has(c)) {
          this.failedCollections.add(c);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.recordError(`Metadata sync failed: ${msg}`);
      this.logger.warn('Background collection auto-download failed', {
        collections: targets,
        error: msg,
      });
      for (const c of targets) {
        this.failedCollections.add(c);
      }
    } finally {
      for (const c of targets) {
        this.inflightCollections.delete(c);
      }
    }
    return loadedNow;
  }

  public getDiagnosticsInfo(activeUri?: string): DiagnosticsInfoReport {
    let detectedAnsibleRoot: string | undefined;
    const refUri = activeUri ?? this.documents.keys().next().value;
    if (refUri) {
      const root = this.findWorkspaceRootForUri(refUri) ?? path.dirname(uriToFsPath(refUri));
      detectedAnsibleRoot = discoverAnsibleProjectContext(refUri, root, this.fs).ansibleRoot;
    } else if (this.ansibleRootPaths[0]) {
      detectedAnsibleRoot = this.ansibleRootPaths[0];
    } else if (this.workspaceRoots[0]) {
      detectedAnsibleRoot = this.workspaceRoots[0];
    }
    return {
      detectedAnsibleRoot,
      workspaceRoots: [...this.workspaceRoots],
      ansibleRootPaths: [...this.ansibleRootPaths],
      loadedCollections: [...this.registry.listCollections()].sort(),
      loadedModulesCount: this.registry.listModules().length,
      indexedDocumentsCount: this.documents.size,
      indexedVariablesCount: this.variableGraph.listVariables().length,
      recentErrors: [...this.recentErrors],
    };
  }

  public setLintConfiguration(config: LintConfiguration): void {
    if (typeof config.enabled === 'boolean') {
      this.lintEnabled = config.enabled;
    }
    if (
      config.profile === 'minimal' ||
      config.profile === 'basic' ||
      config.profile === 'moderate' ||
      config.profile === 'production'
    ) {
      this.lintProfile = config.profile;
    }
    if (config.rules !== undefined) {
      this.lintRuleOverrides = config.rules;
    }
    if (Array.isArray(config.extraVars)) {
      this.lintExtraVars = config.extraVars.filter((v): v is string => typeof v === 'string');
    }
  }

  public getLintConfiguration(): Required<LintConfiguration> {
    return {
      enabled: this.lintEnabled,
      profile: this.lintProfile,
      rules: this.lintRuleOverrides,
      extraVars: this.lintExtraVars,
    };
  }

  public setDocsCtrlClickBehavior(behavior: DocsCtrlClickBehavior): void {
    this.docsCtrlClickBehavior = behavior;
  }

  public getDocsCtrlClickBehavior(): DocsCtrlClickBehavior {
    return this.docsCtrlClickBehavior;
  }

  public getRegistry(): MetadataRegistry {
    return this.registry;
  }

  public getLoadedCollectionsCount(): number {
    return this.registry.listCollections().length;
  }

  public addWorkspaceRoot(rootPathOrUri: string): void {
    const fsPath = uriToFsPath(rootPathOrUri);
    if (!this.workspaceRoots.includes(fsPath)) {
      this.workspaceRoots.push(fsPath);
    }
  }

  /**
   * Scans workspace roots for Ansible YAML files and indexes them into memory
   * so cross-file variables, handlers, roles, and inventory completions work immediately.
   */
  public indexWorkspace(): void {
    const scanRoots = [...this.workspaceRoots];
    for (const extraRoot of this.ansibleRootPaths) {
      if (!scanRoots.includes(extraRoot)) {
        scanRoots.push(extraRoot);
      }
    }
    for (const root of scanRoots) {
      const files = this.fs.listFiles(root);
      for (const filePath of files) {
        if (
          !filePath.endsWith('.yml') &&
          !filePath.endsWith('.yaml') &&
          !filePath.endsWith('.j2')
        ) {
          continue;
        }
        const uri = fsPathToUri(filePath);
        if (this.documents.has(uri)) {
          continue;
        }
        const content = this.fs.readFile(filePath);
        if (content === undefined) {
          continue;
        }
        const hasCfg = this.hasAnsibleCfgForUri(uri);
        const heuristic = evaluateAnsibleHeuristic(uri, content, hasCfg);
        if (!heuristic.isAnsible) {
          continue;
        }
        const ast = parseDocumentWithFallback(uri, content, heuristic.kind, this.registry);
        this.documents.set(uri, { uri, text: content, ast });
      }
    }
    this.indexReferencedVarsFiles();
    this.rebuildVariableGraph();
    this.logger.info('Workspace indexed', {
      roots: scanRoots.length,
      documents: this.documents.size,
      variables: this.variableGraph.listVariables().length,
    });
  }

  public updateDocument(uri: string, text: string): void {
    const canonicalUri = normalizeDocumentUri(uri);
    const hasCfg = this.hasAnsibleCfgForUri(canonicalUri);
    const heuristic = evaluateAnsibleHeuristic(canonicalUri, text, hasCfg);
    if (!heuristic.isAnsible && this.externalVarsFileUris.has(canonicalUri)) {
      const ast = parseDocumentWithFallback(canonicalUri, text, 'vars-files', this.registry);
      this.documents.set(canonicalUri, { uri: canonicalUri, text, ast });
    } else {
      const ast = parseDocumentWithFallback(canonicalUri, text, heuristic.kind, this.registry);
      this.documents.set(canonicalUri, { uri: canonicalUri, text, ast });
    }
    this.indexReferencedVarsFiles();
    this.rebuildVariableGraph();
  }

  /**
   * Called when an editor tab is closed (`onDidClose`): restores the disk-backed copy of the file
   * into the workspace index so closing `defaults/main.yml`, `handlers/main.yml`, or `versions.yml`
   * never breaks cross-file variables or `notify:` Go-to-Definition. Only evicts the document if
   * it no longer exists on disk.
   */
  public closeDocument(uri: string): void {
    const canonicalUri = normalizeDocumentUri(uri);
    const fsPath = uriToFsPath(canonicalUri);
    const diskContent = this.fs.readFile(fsPath);
    if (diskContent === undefined) {
      this.removeDocument(canonicalUri);
      return;
    }
    const hasCfg = this.hasAnsibleCfgForUri(canonicalUri);
    const heuristic = evaluateAnsibleHeuristic(canonicalUri, diskContent, hasCfg);
    if (heuristic.isAnsible) {
      const ast = parseDocumentWithFallback(
        canonicalUri,
        diskContent,
        heuristic.kind,
        this.registry,
      );
      this.documents.set(canonicalUri, { uri: canonicalUri, text: diskContent, ast });
    } else if (this.externalVarsFileUris.has(canonicalUri)) {
      const ast = parseDocumentWithFallback(canonicalUri, diskContent, 'vars-files', this.registry);
      this.documents.set(canonicalUri, { uri: canonicalUri, text: diskContent, ast });
    } else {
      this.documents.delete(canonicalUri);
    }
    this.indexReferencedVarsFiles();
    this.rebuildVariableGraph();
  }

  /**
   * Re-reads a file from disk after `onDidSave` or `onDidChangeWatchedFiles` and refreshes
   * referenced `vars_files:` / `include_vars:` and the cross-file variable graph.
   */
  public reloadDocumentFromDisk(uri: string): void {
    const canonicalUri = normalizeDocumentUri(uri);
    const fsPath = uriToFsPath(canonicalUri);
    const diskContent = this.fs.readFile(fsPath);
    if (diskContent === undefined) {
      this.removeDocument(canonicalUri);
      return;
    }
    this.updateDocument(canonicalUri, diskContent);
  }

  /**
   * Removes a document from the workspace index (used when a file is deleted from disk).
   */
  public removeDocument(uri: string): void {
    const canonicalUri = normalizeDocumentUri(uri);
    this.externalVarsFileUris.delete(canonicalUri);
    if (this.documents.delete(canonicalUri)) {
      this.indexReferencedVarsFiles();
      this.rebuildVariableGraph();
    }
  }

  /**
   * Determines whether a document can supply variables, handlers, or inventory data to
   * other open documents in the workspace (e.g. `defaults/`, `vars/`, `group_vars/`,
   * `host_vars/`, `handlers/`, `inventory`, `site.yml`, `ansible.cfg`, tracked external
   * `vars_files`, or playbooks/tasks referencing `vars_files:` / `include_vars`).
   */
  public isSharedProviderDocument(uri: string, text?: string): boolean {
    const canonicalUri = normalizeDocumentUri(uri);
    if (
      this.externalVarsFileUris.has(canonicalUri) ||
      this.referencedVarsFileUris.has(canonicalUri)
    ) {
      return true;
    }

    const normPath = uriToFsPath(canonicalUri).replaceAll('\\', '/').toLowerCase();
    if (/(?:^|\/)(?:defaults|vars|group_vars|host_vars|handlers|inventory)\//.test(normPath)) {
      return true;
    }

    const base = path.posix.basename(normPath);
    if (
      base === 'site.yml' ||
      base === 'site.yaml' ||
      base === 'ansible.cfg' ||
      base === 'inventory' ||
      base.startsWith('inventory.') ||
      base === 'hosts' ||
      base.startsWith('hosts.')
    ) {
      return true;
    }

    if (text !== undefined && /\b(?:vars_files|include_vars)\b/.test(text)) {
      return true;
    }

    const existing = this.documents.get(canonicalUri);
    if (existing) {
      if (existing.ast.plays.some((play) => play.varsFiles.length > 0)) {
        return true;
      }
      for (const task of collectAllTasks(existing.ast)) {
        const shortMod = task.moduleName.includes('.')
          ? task.moduleName.slice(task.moduleName.lastIndexOf('.') + 1)
          : task.moduleName;
        if (shortMod === 'include_vars') {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Incrementally applies a debounced batch of watched-file changes without rescanning
   * the entire workspace. Only falls back to `indexWorkspace()` if `ansible.cfg` changed.
   */
  public applyWatchedFileChanges(
    changes: ReadonlyArray<WatchedFileChange>,
  ): WatchedFileBatchResult {
    const deduped = new Map<string, WatchedFileChange>();
    for (const change of changes) {
      const canonicalUri = normalizeDocumentUri(change.uri);
      deduped.set(canonicalUri, {
        uri: canonicalUri,
        deleted: change.deleted,
        ...(change.openDocumentText !== undefined
          ? { openDocumentText: change.openDocumentText }
          : {}),
      });
    }

    const updatedUris = Array.from(deduped.keys());
    if (updatedUris.length === 0) {
      return {
        needsFullWorkspaceReindex: false,
        affectsSharedProviders: false,
        updatedUris: [],
      };
    }

    const hasAnsibleCfgChange = updatedUris.some(
      (canonicalUri) =>
        path.posix.basename(uriToFsPath(canonicalUri).replaceAll('\\', '/').toLowerCase()) ===
        'ansible.cfg',
    );
    if (hasAnsibleCfgChange) {
      this.indexWorkspace();
      return {
        needsFullWorkspaceReindex: true,
        affectsSharedProviders: true,
        updatedUris,
      };
    }

    let affectsSharedProviders = false;
    for (const [canonicalUri, change] of deduped.entries()) {
      if (this.isSharedProviderDocument(canonicalUri, change.openDocumentText)) {
        affectsSharedProviders = true;
      }

      if (change.deleted) {
        this.externalVarsFileUris.delete(canonicalUri);
        this.documents.delete(canonicalUri);
        continue;
      }

      const content =
        change.openDocumentText !== undefined
          ? change.openDocumentText
          : this.fs.readFile(uriToFsPath(canonicalUri));
      if (content === undefined) {
        this.externalVarsFileUris.delete(canonicalUri);
        this.documents.delete(canonicalUri);
        continue;
      }

      if (!affectsSharedProviders && this.isSharedProviderDocument(canonicalUri, content)) {
        affectsSharedProviders = true;
      }

      const hasCfg = this.hasAnsibleCfgForUri(canonicalUri);
      const heuristic = evaluateAnsibleHeuristic(canonicalUri, content, hasCfg);
      if (!heuristic.isAnsible && this.externalVarsFileUris.has(canonicalUri)) {
        const ast = parseDocumentWithFallback(canonicalUri, content, 'vars-files', this.registry);
        this.documents.set(canonicalUri, { uri: canonicalUri, text: content, ast });
      } else if (heuristic.isAnsible) {
        const ast = parseDocumentWithFallback(canonicalUri, content, heuristic.kind, this.registry);
        this.documents.set(canonicalUri, { uri: canonicalUri, text: content, ast });
      } else {
        this.documents.delete(canonicalUri);
      }
    }

    this.indexReferencedVarsFiles();
    this.rebuildVariableGraph();

    return {
      needsFullWorkspaceReindex: false,
      affectsSharedProviders,
      updatedUris,
    };
  }

  public hasAnsibleCfgForUri(uri: string): boolean {
    const fsPath = uriToFsPath(uri);
    const normDoc = fsPath.replaceAll('\\', '/');
    for (const customRoot of this.ansibleRootPaths) {
      const normRoot = customRoot.replaceAll('\\', '/');
      if (normDoc.startsWith(normRoot)) {
        return true;
      }
    }
    let currentDir = path.dirname(fsPath);
    for (let depth = 0; depth < 8; depth++) {
      if (this.fs.exists(path.join(currentDir, 'ansible.cfg'))) {
        return true;
      }
      const parent = path.dirname(currentDir);
      if (parent === currentDir) {
        break;
      }
      currentDir = parent;
    }
    for (const root of [...this.ansibleRootPaths, ...this.workspaceRoots]) {
      if (this.fs.exists(path.join(root, 'ansible.cfg'))) {
        return true;
      }
    }
    return false;
  }

  private buildLintOptions(): LintOptions {
    const knownVariables = new Set<string>();
    for (const resolved of this.variableGraph.listVariables()) {
      knownVariables.add(resolved.name);
    }
    return {
      knownVariables,
      extraVars: this.lintExtraVars,
      profile: this.lintProfile,
      ruleOverrides: this.lintRuleOverrides,
    };
  }

  public getDiagnostics(uri: string, text?: string): Diagnostic[] {
    if (!this.lintEnabled) {
      return [];
    }
    const canonicalUri = normalizeDocumentUri(uri);
    const docText = text ?? this.documents.get(canonicalUri)?.text;
    if (docText === undefined) {
      return [];
    }
    const hasCfg = this.hasAnsibleCfgForUri(canonicalUri);
    const heuristic = evaluateAnsibleHeuristic(canonicalUri, docText, hasCfg);
    if (!heuristic.isAnsible) {
      return [];
    }

    const ast = parseDocumentWithFallback(canonicalUri, docText, heuristic.kind, this.registry);
    const lintOptions = this.buildLintOptions();
    const coreDiags = lintAnsibleDocument(ast, this.registry, lintOptions);
    const lintDiags = coreDiags.length > 0 ? coreDiags : fallbackLintDocument(ast, this.registry);

    const root = this.findWorkspaceRootForUri(canonicalUri);
    const rawIntegrityDiags = root ? checkProjectIntegrity(ast, root, this.fs) : [];
    const integrityDiags = applyLintConfiguration(rawIntegrityDiags, lintOptions);

    const combined = deduplicateDiagnostics([...lintDiags, ...integrityDiags]);
    return combined.map((d) => toLspDiagnostic(d));
  }

  public getCompletions(uri: string, position: Position, text?: string): CompletionItem[] {
    const canonicalUri = normalizeDocumentUri(uri);
    const docText = text ?? this.documents.get(canonicalUri)?.text;
    if (docText === undefined) {
      return [];
    }
    const hasCfg = this.hasAnsibleCfgForUri(canonicalUri);
    const heuristic = evaluateAnsibleHeuristic(canonicalUri, docText, hasCfg);
    if (!heuristic.isAnsible) {
      return [];
    }

    const ast = parseDocumentWithFallback(canonicalUri, docText, heuristic.kind, this.registry);
    const lines = docText.split(/\r?\n/);
    const line = lines[position.line] ?? '';
    const beforeCursor = line.slice(0, position.character);

    // 1. Inventory host/group names after `hosts:`
    if (isHostsCompletionPrefix(beforeCursor)) {
      return this.completeInventoryTargets(uri);
    }

    // Replace only the identifier fragment being typed (after the last `.`, `|`, space, ...)
    // so VS Code's YAML word pattern never filters out valid suggestions.
    const partialPrefix = extractTrailingIdentifier(beforeCursor);
    const replaceRange: Range = {
      start: { line: position.line, character: position.character - partialPrefix.length },
      end: { line: position.line, character: position.character },
    };
    const inCondition = isInsideExpressionOrCondition(beforeCursor, line, lines, position.line);

    // 2. Dotted access on `ansible_facts.` or registered variables (`my_res.`)
    const dottedMatch = extractTrailingDottedAccess(beforeCursor);
    if (dottedMatch && inCondition) {
      const { rootVar, subPath } = dottedMatch;
      if (rootVar === 'ansible_facts') {
        const facts: CompletionItem[] = ANSIBLE_FACTS_FIELDS.filter((f) =>
          matchesPrefix(f.name, partialPrefix),
        ).map((f) => ({
          label: f.name,
          kind: CompletionItemKind.Field,
          detail: `ansible_facts.${f.name} (${f.signature})`,
          documentation: { kind: MarkupKind.Markdown, value: f.description },
        }));
        return withReplaceRange(facts, replaceRange);
      }
      const regMap = this.getRegisteredVariables(ast);
      const reg = regMap.get(rootVar);
      if (reg) {
        return withReplaceRange(this.completeRegisteredFields(reg, subPath), replaceRange);
      }
    }

    // 3. Jinja2 filter completion after `|`
    if (isFilterCompletionPrefix(beforeCursor, lines, position.line)) {
      const filters: CompletionItem[] = JINJA_FILTERS.map((f) => ({
        label: f.name,
        kind: CompletionItemKind.Function,
        detail: f.signature,
        documentation: { kind: MarkupKind.Markdown, value: f.description },
      }));
      return withReplaceRange(filters, replaceRange);
    }

    // 4. Jinja2 test completion after `is ` or `is not `
    if (isJinjaTestPrefix(beforeCursor, partialPrefix)) {
      const tests: CompletionItem[] = JINJA_TESTS.map((t) => ({
        label: t.name,
        kind: CompletionItemKind.Keyword,
        detail: t.signature,
        documentation: { kind: MarkupKind.Markdown, value: t.description },
      }));
      return withReplaceRange(tests, replaceRange);
    }

    // 5. Jinja2 variable completion inside `{{ ...` or `when:`/`changed_when:`/`failed_when:`
    if (inCondition) {
      return withReplaceRange(this.completeVariablesAndMagic(ast), replaceRange);
    }

    if (heuristic.kind === 'template') {
      return [];
    }

    // 6. Module parameter value choices (`state: `)
    const paramName = extractParamValuePrefixKey(beforeCursor);
    if (paramName !== undefined) {
      const activeTask =
        this.findTaskAtLine(ast, position.line) ??
        this.findPrecedingTaskModule(lines, position.line);
      if (activeTask) {
        const mod = this.registry.getModule(activeTask.moduleName);
        if (mod) {
          const opt = mod.options[paramName];
          if (opt?.choices && opt.choices.length > 0) {
            return opt.choices.map((choice) => ({
              label: String(choice),
              kind: CompletionItemKind.EnumMember,
              detail: `${mod.shortName}.${opt.name} choice`,
              documentation: { kind: MarkupKind.Markdown, value: opt.description },
            }));
          }
        }
      }
      if (paramName === 'notify') {
        return this.completeHandlers();
      }
    }

    // 7. Module parameter / nested suboption completion when indented under a module key
    const taskCtx = this.findModuleContextAtLine(ast, lines, position.line);
    if (taskCtx && !beforeCursor.includes(':')) {
      const items: CompletionItem[] = [];
      for (const opt of Object.values(taskCtx.options)) {
        items.push({
          label: opt.name,
          kind: CompletionItemKind.Property,
          detail: `${opt.type}${opt.required ? ' (required)' : ''}`,
          documentation: {
            kind: MarkupKind.Markdown,
            value: formatParameterHoverMarkdown(taskCtx, opt),
          },
          insertText: `${opt.name}: `,
        });
      }
      return items;
    }

    // 8. Default task/play level completions: modules (FQCN & short names) + keywords
    const items: CompletionItem[] = [];
    for (const kw of PLAY_AND_TASK_KEYWORDS) {
      items.push({
        label: kw.name,
        kind: CompletionItemKind.Keyword,
        detail: `Ansible ${kw.scope} keyword`,
        documentation: { kind: MarkupKind.Markdown, value: kw.description },
        insertText: `${kw.name}: `,
      });
    }
    for (const mod of this.registry.listModules()) {
      items.push({
        label: mod.fqcn,
        kind: CompletionItemKind.Module,
        detail: mod.shortDescription,
        documentation: {
          kind: MarkupKind.Markdown,
          value: formatModuleHoverMarkdown(mod),
        },
        insertText: `${mod.fqcn}:`,
      });
      items.push({
        label: mod.shortName,
        kind: CompletionItemKind.Module,
        detail: `${mod.fqcn} (short name)`,
        documentation: {
          kind: MarkupKind.Markdown,
          value: formatModuleHoverMarkdown(mod),
        },
        insertText: `${mod.shortName}:`,
      });
    }
    return items;
  }

  public getHover(uri: string, position: Position, text?: string): Hover | null {
    const canonicalUri = normalizeDocumentUri(uri);
    const docText = text ?? this.documents.get(canonicalUri)?.text;
    if (docText === undefined) {
      return null;
    }
    const hasCfg = this.hasAnsibleCfgForUri(canonicalUri);
    const heuristic = evaluateAnsibleHeuristic(canonicalUri, docText, hasCfg);
    if (!heuristic.isAnsible) {
      return null;
    }

    const ast = parseDocumentWithFallback(canonicalUri, docText, heuristic.kind, this.registry);
    const lines = docText.split(/\r?\n/);
    const line = lines[position.line] ?? '';
    const token = extractWordTokenAtPosition(line, position.character);

    // 1. Check dotted registered variable field (`nginx_stat.stat.exists`, `svc_check.rc`, etc.)
    const dottedToken = extractDottedTokenAtPosition(line, position.character);
    if (dottedToken && dottedToken.includes('.')) {
      const parts = dottedToken.split('.');
      const rootName = parts[0] ?? '';
      const regMap = this.getRegisteredVariables(ast);
      const reg = regMap.get(rootName);
      if (reg) {
        const resolvedField = resolveNestedReturnField(reg, parts.slice(1));
        if (resolvedField) {
          const mod = this.registry.getModule(reg.moduleFqcn);
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: formatReturnFieldHoverMarkdown(dottedToken, resolvedField, mod),
            },
          };
        }
      }
      if (rootName === 'ansible_facts' && parts[1]) {
        const fact = ANSIBLE_FACTS_FIELDS.find((f) => f.name === parts[1]);
        if (fact) {
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: `### \`ansible_facts.${fact.name}\`\n\n- **Type:** \`${fact.signature}\`\n\n${fact.description}`,
            },
          };
        }
      }
    }

    // 2. Check module name or parameter on task
    const task = this.findTaskAtLine(ast, position.line);
    if (task) {
      const mod = this.registry.getModule(task.moduleName);
      if (mod) {
        if (isPositionInRange(position, task.moduleRange)) {
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: formatModuleHoverMarkdown(mod),
            },
            range: toLspRange(task.moduleRange),
          };
        }
        for (const param of task.params) {
          if (isPositionInRange(position, param.keyRange)) {
            const opt =
              mod.options[param.name] ??
              Object.values(mod.options).find((o) => o.aliases?.includes(param.name));
            if (opt) {
              return {
                contents: {
                  kind: MarkupKind.Markdown,
                  value: formatParameterHoverMarkdown(mod, opt),
                },
                range: toLspRange(param.keyRange),
              };
            }
          }
        }
      }
    }

    // 3. Direct module hover fallback by token
    if (token) {
      const directMod = this.registry.getModule(token);
      if (directMod && new RegExp(`(?:^|\\s|-)${escapeRegExp(token)}\\s*:`).test(line)) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: formatModuleHoverMarkdown(directMod),
          },
        };
      }

      // 4. Registered variable root hover
      const reg = this.getRegisteredVariables(ast).get(token);
      if (reg) {
        const mod = this.registry.getModule(reg.moduleFqcn);
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: formatRegisteredVarHoverMarkdown(reg, mod),
          },
        };
      }

      // 5. Workspace variable hover with 22-level precedence breakdown
      const resolvedVar = this.variableGraph.resolveVariable(token);
      if (resolvedVar) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: formatVariablePrecedenceHoverMarkdown(resolvedVar),
          },
        };
      }

      // 6. Jinja filter or Ansible magic variable
      const filter = JINJA_FILTERS.find((f) => f.name === token);
      if (filter && line.includes('|')) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `### Jinja2 Filter \`${filter.name}\`\n\n\`${filter.signature}\`\n\n${filter.description}`,
          },
        };
      }
      const magic = ANSIBLE_MAGIC_VARS.find((m) => m.name === token);
      if (magic) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `### Ansible Magic Variable \`${magic.name}\`\n\n- **Type:** \`${magic.signature}\`\n\n${magic.description}`,
          },
        };
      }
    }

    return null;
  }

  /**
   * Returns a full rendered Markdown docs page for a module (by FQCN or short name),
   * served to the client's `ansible-lens-docs:` TextDocumentContentProvider.
   */
  public getModuleDocsMarkdown(moduleName: string): string {
    const mod = this.registry.getModule(moduleName);
    if (mod) {
      return formatModuleDocsPageMarkdown(mod);
    }
    return formatUnloadedModuleDocsPageMarkdown(moduleName);
  }

  public getDefinition(
    uri: string,
    position: Position,
    text?: string,
  ): Location[] | LocationLink[] {
    const canonicalUri = normalizeDocumentUri(uri);
    const docText = text ?? this.documents.get(canonicalUri)?.text;
    if (docText === undefined) {
      return [];
    }
    const hasCfg = this.hasAnsibleCfgForUri(canonicalUri);
    const heuristic = evaluateAnsibleHeuristic(canonicalUri, docText, hasCfg);
    if (!heuristic.isAnsible) {
      return [];
    }

    const ast = parseDocumentWithFallback(canonicalUri, docText, heuristic.kind, this.registry);
    const lines = docText.split(/\r?\n/);
    const line = lines[position.line] ?? '';
    if (isPositionInYamlComment(line, position.character)) {
      return [];
    }
    const root =
      this.findWorkspaceRootForUri(canonicalUri) ?? path.dirname(uriToFsPath(canonicalUri));
    const projectCtx = discoverAnsibleProjectContext(canonicalUri, root, this.fs);

    // 1. roles: entry -> roles/<name>/tasks/main.yml (across ansible.cfg roles_path & nested root)
    for (const play of ast.plays) {
      for (const roleRef of play.roles) {
        if (isPositionInRange(position, roleRef.range)) {
          for (const roleBase of projectCtx.rolesPaths) {
            const candidates = [
              path.join(roleBase, roleRef.name, 'tasks', 'main.yml'),
              path.join(roleBase, roleRef.name, 'tasks', 'main.yaml'),
            ];
            for (const candidate of candidates) {
              if (this.fs.exists(candidate)) {
                return [
                  {
                    uri: fsPathToUri(candidate),
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 0 },
                    },
                  },
                ];
              }
            }
          }
        }
      }

      // 2. vars_files: entry -> target YAML file
      for (const vf of play.varsFiles) {
        if (isPositionInRange(position, vf.range)) {
          const candidates = [
            resolveRelativeFsPath(projectCtx.documentDir, vf.path),
            resolveRelativeFsPath(projectCtx.ansibleRoot, vf.path),
            resolveRelativeFsPath(root, vf.path),
          ];
          for (const resolved of candidates) {
            if (this.fs.exists(resolved)) {
              return [
                {
                  uri: fsPathToUri(resolved),
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 },
                  },
                },
              ];
            }
          }
        }
      }
    }

    // 3. Module name -> read-only rendered docs page (`ansible-lens-docs:` virtual document)
    if (this.docsCtrlClickBehavior !== 'disabled') {
      for (const moduleTask of collectAllTasks(ast)) {
        if (isPositionInRange(position, moduleTask.moduleRange)) {
          const mod = this.registry.getModule(moduleTask.moduleName);
          if (mod || moduleTask.isFqcn) {
            return [
              {
                uri: buildModuleDocsUri(mod ? mod.fqcn : moduleTask.moduleName),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            ];
          }
        }
      }
    }

    // 4. notify: -> matching handler definition across play & workspace (LocationLink for multi-word highlight)
    const task = this.findTaskAtLine(ast, position.line);
    if (task?.notify && task.notify.length > 0) {
      const notifyMatch = this.extractNotifyHandlerAtPosition(
        lines,
        position.line,
        position.character,
        task.notify,
      );
      if (notifyMatch) {
        const locs = this.findHandlerLocations(notifyMatch.handlerName, canonicalUri);
        if (locs.length > 0) {
          return locs.map((loc): LocationLink => ({
            originSelectionRange: notifyMatch.originSelectionRange,
            targetUri: loc.uri,
            targetRange: loc.range,
            targetSelectionRange: loc.range,
          }));
        }
      }
    }

    // 4. copy/template src: -> target file
    if (task && (task.moduleName.endsWith('copy') || task.moduleName.endsWith('template'))) {
      const srcParam = task.params.find((p) => p.name === 'src');
      if (
        srcParam &&
        isPositionInRange(position, srcParam.valueRange) &&
        typeof srcParam.value === 'string'
      ) {
        const resolved = this.resolveTaskAssetPath(
          uri,
          projectCtx.ansibleRoot,
          task.moduleName,
          srcParam.value,
        );
        if (resolved) {
          return [
            {
              uri: fsPathToUri(resolved),
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
            },
          ];
        }
      }
    }

    // 5. register: variable reference -> register declaration
    const dotted = extractDottedTokenAtPosition(line, position.character);
    const word = extractWordTokenAtPosition(line, position.character);
    const varName = dotted ? dotted.split('.')[0] : word;
    if (varName) {
      const reg = this.getRegisteredVariables(ast).get(varName);
      if (reg) {
        return [{ uri: reg.uri, range: toLspRange(reg.range) }];
      }

      // 6. Workspace variable definition (winning + shadowed)
      const resolvedVar = this.variableGraph.resolveVariable(varName);
      if (resolvedVar) {
        return resolvedVar.allDefinitions.map((d) => ({
          uri: d.uri,
          range: toLspRange(d.range),
        }));
      }
    }

    return [];
  }

  public getReferences(uri: string, position: Position, text?: string): Location[] {
    const canonicalUri = normalizeDocumentUri(uri);
    const docText = text ?? this.documents.get(canonicalUri)?.text;
    if (docText === undefined) {
      return [];
    }
    const lines = docText.split(/\r?\n/);
    const line = lines[position.line] ?? '';
    const dotted = extractDottedTokenAtPosition(line, position.character);
    const word = extractWordTokenAtPosition(line, position.character);
    const targetName = dotted ? dotted.split('.')[0] : word;
    if (!targetName) {
      return [];
    }

    const locations: Location[] = [];
    const wordRegex = new RegExp(`\\b${escapeRegExp(targetName)}\\b`, 'g');
    for (const [docUri, entry] of this.documents.entries()) {
      const docLines = entry.text.split(/\r?\n/);
      for (let lineIdx = 0; lineIdx < docLines.length; lineIdx++) {
        const docLine = docLines[lineIdx] ?? '';
        let match: RegExpExecArray | null;
        wordRegex.lastIndex = 0;
        while ((match = wordRegex.exec(docLine)) !== null) {
          locations.push({
            uri: docUri,
            range: {
              start: { line: lineIdx, character: match.index },
              end: { line: lineIdx, character: match.index + targetName.length },
            },
          });
        }
      }
    }
    return locations;
  }

  public getCodeActions(uri: string, range: Range, text?: string): CodeAction[] {
    if (!this.lintEnabled) {
      return [];
    }
    const canonicalUri = normalizeDocumentUri(uri);
    const docText = text ?? this.documents.get(canonicalUri)?.text;
    if (docText === undefined) {
      return [];
    }
    const hasCfg = this.hasAnsibleCfgForUri(canonicalUri);
    const heuristic = evaluateAnsibleHeuristic(canonicalUri, docText, hasCfg);
    if (!heuristic.isAnsible) {
      return [];
    }

    const ast = parseDocumentWithFallback(canonicalUri, docText, heuristic.kind, this.registry);
    const lintOptions = this.buildLintOptions();
    const coreDiags = lintAnsibleDocument(ast, this.registry, lintOptions);
    const lintDiags = coreDiags.length > 0 ? coreDiags : fallbackLintDocument(ast, this.registry);

    const actions: CodeAction[] = [];
    const fqcnEdits: TextEdit[] = [];

    for (const diag of lintDiags) {
      if (diag.ruleId === 'fqcn') {
        for (const fix of diag.quickFixes) {
          for (const edit of fix.edits) {
            fqcnEdits.push({
              range: toLspRange(edit.range),
              newText: edit.newText,
            });
          }
        }
      }

      if (rangesOverlap(toLspRange(diag.range), range)) {
        for (const fix of diag.quickFixes) {
          actions.push({
            title: fix.title,
            kind: CodeActionKind.QuickFix,
            diagnostics: [toLspDiagnostic(diag)],
            isPreferred: fix.isPreferred ?? false,
            edit: {
              changes: {
                [uri]: fix.edits.map((e) => ({
                  range: toLspRange(e.range),
                  newText: e.newText,
                })),
              },
            },
          });
        }
      }
    }

    if (fqcnEdits.length > 0) {
      actions.push({
        title: 'Convert File to FQCN',
        kind: 'source.fixAll.ansible-lens.fqcn',
        edit: {
          changes: {
            [uri]: fqcnEdits,
          },
        },
      });
    }

    return actions;
  }

  public getInventoryInfo(forUri?: string): InventoryInfo {
    const hosts = new Set<string>(['all', 'localhost']);
    const groups = new Set<string>(['all', 'ungrouped']);

    const searchDirs = new Set<string>(this.workspaceRoots);
    const directFiles = new Set<string>();
    if (forUri) {
      const root = this.findWorkspaceRootForUri(forUri) ?? path.dirname(uriToFsPath(forUri));
      const ctx = discoverAnsibleProjectContext(forUri, root, this.fs);
      searchDirs.add(root);
      searchDirs.add(ctx.ansibleRoot);
      for (const invPath of ctx.inventoryPaths) {
        directFiles.add(invPath);
      }
    }

    for (const invFile of directFiles) {
      if (this.fs.exists(invFile) && !invFile.endsWith('.yml') && !invFile.endsWith('.yaml')) {
        const content = this.fs.readFile(invFile);
        if (content) {
          const parsed = parseIniInventory(content);
          for (const h of parsed.hosts) {
            hosts.add(h);
          }
          for (const g of parsed.groups) {
            groups.add(g);
          }
        }
      }
    }

    for (const dir of searchDirs) {
      for (const filePath of this.fs.listFiles(dir)) {
        const base = path.basename(filePath).toLowerCase();
        if (
          base === 'hosts' ||
          base === 'hosts.ini' ||
          base === 'inventory.ini' ||
          base.endsWith('.ini')
        ) {
          const content = this.fs.readFile(filePath);
          if (content) {
            const parsed = parseIniInventory(content);
            for (const h of parsed.hosts) {
              hosts.add(h);
            }
            for (const g of parsed.groups) {
              groups.add(g);
            }
          }
        }
      }
    }

    return {
      hosts: Array.from(hosts),
      groups: Array.from(groups),
    };
  }

  /**
   * Follows relative paths in `vars_files:` (e.g. `../../versions.yml` in `playbooks/site.yml`)
   * and `include_vars:` across indexed documents so external shared YAML files feed into
   * role defaults, tasks, and `.j2` templates. Immediately evicts previously loaded external
   * `vars_files` that are no longer referenced by any playbook/task.
   */
  private indexReferencedVarsFiles(): void {
    const asts = Array.from(this.documents.values(), (entry) => entry.ast);
    const activeExternalUris = new Set<string>();
    this.referencedVarsFileUris.clear();

    const loadExternalVarsFile = (
      resolvedPath: string,
      kind: 'vars-files' | 'include-vars',
    ): void => {
      if (!resolvedPath.endsWith('.yml') && !resolvedPath.endsWith('.yaml')) {
        return;
      }
      const targetUri = fsPathToUri(resolvedPath);
      this.referencedVarsFileUris.add(targetUri);
      const existing = this.documents.get(targetUri);
      if (
        existing &&
        !this.externalVarsFileUris.has(targetUri) &&
        existing.ast.variables.length > 0
      ) {
        return;
      }
      const content = existing?.text ?? this.fs.readFile(resolvedPath);
      if (content === undefined) {
        return;
      }
      const parsed = parseDocumentWithFallback(targetUri, content, kind, this.registry);
      this.documents.set(targetUri, { uri: targetUri, text: content, ast: parsed });
      this.externalVarsFileUris.add(targetUri);
      activeExternalUris.add(targetUri);
    };

    for (const ast of asts) {
      const root = this.findWorkspaceRootForUri(ast.uri) ?? path.dirname(uriToFsPath(ast.uri));
      const projectCtx = discoverAnsibleProjectContext(ast.uri, root, this.fs);

      for (const play of ast.plays) {
        for (const vf of play.varsFiles) {
          if (!vf.path || vf.path.includes('{{')) {
            continue;
          }
          const candidates = [
            resolveRelativeFsPath(projectCtx.documentDir, vf.path),
            resolveRelativeFsPath(projectCtx.ansibleRoot, vf.path),
            resolveRelativeFsPath(root, vf.path),
          ];
          for (const candidate of candidates) {
            if (this.fs.exists(candidate)) {
              loadExternalVarsFile(candidate, 'vars-files');
              break;
            }
          }
        }
      }

      for (const task of collectAllTasks(ast)) {
        const shortMod = task.moduleName.includes('.')
          ? task.moduleName.slice(task.moduleName.lastIndexOf('.') + 1)
          : task.moduleName;
        if (shortMod !== 'include_vars') {
          continue;
        }
        const fileParam = task.params.find((p) => p.name === 'file');
        const dirParam = task.params.find((p) => p.name === 'dir');
        const fileRef =
          (typeof fileParam?.value === 'string' ? fileParam.value : undefined) ?? task.freeFormArg;
        if (fileRef && !fileRef.includes('{{')) {
          const candidates = [
            resolveRelativeFsPath(projectCtx.documentDir, fileRef),
            resolveRelativeFsPath(projectCtx.documentDir, 'vars', fileRef),
            resolveRelativeFsPath(projectCtx.documentDir, '..', 'vars', fileRef),
            resolveRelativeFsPath(projectCtx.ansibleRoot, fileRef),
            resolveRelativeFsPath(projectCtx.ansibleRoot, 'vars', fileRef),
            resolveRelativeFsPath(root, fileRef),
          ];
          for (const candidate of candidates) {
            if (this.fs.exists(candidate)) {
              loadExternalVarsFile(candidate, 'include-vars');
              break;
            }
          }
        }
        if (typeof dirParam?.value === 'string' && !dirParam.value.includes('{{')) {
          const dirCandidates = [
            resolveRelativeFsPath(projectCtx.documentDir, dirParam.value),
            resolveRelativeFsPath(projectCtx.documentDir, '..', dirParam.value),
            resolveRelativeFsPath(projectCtx.ansibleRoot, dirParam.value),
            resolveRelativeFsPath(root, dirParam.value),
          ];
          for (const dirCandidate of dirCandidates) {
            if (this.fs.exists(dirCandidate)) {
              for (const childFile of this.fs.listFiles(dirCandidate)) {
                loadExternalVarsFile(childFile, 'include-vars');
              }
              break;
            }
          }
        }
      }
    }

    // Evict any previously loaded external vars_files that are no longer referenced
    for (const oldExternalUri of Array.from(this.externalVarsFileUris)) {
      if (!activeExternalUris.has(oldExternalUri)) {
        this.externalVarsFileUris.delete(oldExternalUri);
        const existing = this.documents.get(oldExternalUri);
        if (existing) {
          const hasCfg = this.hasAnsibleCfgForUri(oldExternalUri);
          const heuristic = evaluateAnsibleHeuristic(oldExternalUri, existing.text, hasCfg);
          if (!heuristic.isAnsible) {
            this.documents.delete(oldExternalUri);
          } else {
            const reparsed = parseDocumentWithFallback(
              oldExternalUri,
              existing.text,
              heuristic.kind,
              this.registry,
            );
            this.documents.set(oldExternalUri, {
              uri: oldExternalUri,
              text: existing.text,
              ast: reparsed,
            });
          }
        }
      }
    }
  }

  private rebuildVariableGraph(): void {
    const graph = new WorkspaceVariableGraph();
    for (const entry of this.documents.values()) {
      graph.indexDocument(entry.ast);
      if (graph.listVariables().length === 0 || entry.ast.variables.length > 0) {
        // Ensure variables extracted via fallback are also present if core indexDocument is a stub
        for (const def of extractVariableDefinitionsFromAst(entry.ast)) {
          const existing = graph.resolveVariable(def.name);
          const alreadyTracked = existing?.allDefinitions.some(
            (d) =>
              d.uri === def.uri &&
              d.range.start.line === def.range.start.line &&
              d.sourceKind === def.sourceKind,
          );
          if (!alreadyTracked) {
            graph.addDefinition(def);
          }
        }
      }
    }
    this.variableGraph = graph;
  }

  private getRegisteredVariables(
    ast: AnsibleDocumentAst,
  ): ReadonlyMap<string, InferredRegisteredVariable> {
    const merged = new Map<string, InferredRegisteredVariable>();
    const localCore = inferRegisteredVariables(ast, this.registry);
    const localMap =
      localCore.size > 0 ? localCore : inferRegisteredVariablesFallback(ast, this.registry);
    for (const [k, v] of localMap.entries()) {
      merged.set(k, v);
    }
    // Include registered variables from indexed workspace documents (role tasks, playbooks)
    // so `.j2` templates and cross-file task files inherit `register:` variables & return fields.
    for (const entry of this.documents.values()) {
      if (entry.uri === ast.uri) {
        continue;
      }
      const entryCore = inferRegisteredVariables(entry.ast, this.registry);
      const entryMap =
        entryCore.size > 0 ? entryCore : inferRegisteredVariablesFallback(entry.ast, this.registry);
      for (const [k, v] of entryMap.entries()) {
        if (!merged.has(k)) {
          merged.set(k, v);
        }
      }
    }
    return merged;
  }

  private completeInventoryTargets(uri: string): CompletionItem[] {
    const inv = this.getInventoryInfo(uri);
    const items: CompletionItem[] = [];
    for (const group of inv.groups) {
      items.push({
        label: group,
        kind: CompletionItemKind.Class,
        detail: 'Inventory group',
      });
    }
    for (const host of inv.hosts) {
      if (!inv.groups.includes(host)) {
        items.push({
          label: host,
          kind: CompletionItemKind.Constant,
          detail: 'Inventory host',
        });
      }
    }
    return items;
  }

  private completeRegisteredFields(
    reg: InferredRegisteredVariable,
    subPath: string,
  ): CompletionItem[] {
    // `subPath` is everything after `<var>.`; the final segment is the partial
    // identifier currently being typed (possibly empty), the rest are parents.
    const rawParts = subPath.split('.');
    const partialPrefix = rawParts[rawParts.length - 1] ?? '';
    const parentParts = rawParts.slice(0, -1).filter((p) => p.length > 0);

    if (parentParts.length > 0) {
      const parent = resolveNestedReturnField(reg, parentParts);
      const children = parent?.children;
      if (!children) {
        return [];
      }
      return Object.values(children)
        .filter((c) => matchesPrefix(c.name, partialPrefix))
        .map((c) => ({
          label: c.name,
          kind: CompletionItemKind.Field,
          detail: `${c.type} (${c.returned})`,
          documentation: { kind: MarkupKind.Markdown, value: c.description },
        }));
    }

    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    for (const field of Object.values(reg.fields)) {
      seen.add(field.name);
      items.push({
        label: field.name,
        kind: CompletionItemKind.Field,
        detail: `${field.type} (${field.returned})`,
        documentation: { kind: MarkupKind.Markdown, value: field.description },
      });
    }
    for (const common of COMMON_REGISTER_RETURN_FIELDS) {
      if (!seen.has(common.name)) {
        seen.add(common.name);
        items.push({
          label: common.name,
          kind: CompletionItemKind.Field,
          detail: `${common.type} (${common.returned})`,
          documentation: { kind: MarkupKind.Markdown, value: common.description },
        });
      }
    }
    if (reg.isLoop && !seen.has('results')) {
      items.push({
        label: 'results',
        kind: CompletionItemKind.Field,
        detail: 'list (when loop is used)',
        documentation: {
          kind: MarkupKind.Markdown,
          value: 'List of iteration result objects when the task uses `loop` or `with_*`.',
        },
      });
    }
    return items.filter((item) => matchesPrefix(item.label, partialPrefix));
  }

  private completeVariablesAndMagic(ast: AnsibleDocumentAst): CompletionItem[] {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    const currentRole = extractRoleNameFromUri(ast.uri);

    for (const resolved of this.variableGraph.listVariables()) {
      const win = resolved.winningDefinition;
      const winRole = extractRoleNameFromUri(win.uri);

      // Exclude other roles' private `register:` variables so they don't bloat templates
      if (win.sourceKind === 'register' && winRole !== undefined && winRole !== currentRole) {
        continue;
      }

      const belongsToCurrentRole =
        (currentRole !== undefined &&
          resolved.allDefinitions.some((d) => extractRoleNameFromUri(d.uri) === currentRole)) ||
        win.uri === ast.uri;

      const isSharedScope = resolved.allDefinitions.some(
        (d) =>
          d.sourceKind === 'play-vars-files' ||
          d.sourceKind === 'include-vars' ||
          d.sourceKind === 'playbook-group-vars-all' ||
          d.sourceKind === 'playbook-group-vars' ||
          d.sourceKind === 'inventory-group-vars' ||
          d.sourceKind === 'inventory-host-vars' ||
          d.sourceKind === 'playbook-host-vars' ||
          d.sourceKind === 'inventory-file' ||
          d.sourceKind === 'play-vars' ||
          d.sourceKind === 'play-vars-prompt' ||
          d.sourceKind === 'extra-vars',
      );

      let bucket: '0_' | '1_' | '2_' = '2_';
      if (belongsToCurrentRole) {
        bucket = '0_';
      } else if (isSharedScope) {
        bucket = '1_';
      }

      seen.add(resolved.name);
      items.push({
        label: resolved.name,
        sortText: `${bucket}${resolved.name}`,
        kind: CompletionItemKind.Variable,
        detail: `Rank ${win.precedenceLevel} (${win.precedenceLabel})`,
        documentation: {
          kind: MarkupKind.Markdown,
          value: formatVariablePrecedenceHoverMarkdown(resolved),
        },
      });
    }

    for (const [name, reg] of this.getRegisteredVariables(ast).entries()) {
      if (seen.has(name)) {
        continue;
      }
      const regRole = extractRoleNameFromUri(reg.uri);
      // Exclude other roles' private `register:` variables
      if (regRole !== undefined && regRole !== currentRole) {
        continue;
      }
      seen.add(name);
      const bucket =
        reg.uri === ast.uri || (currentRole !== undefined && regRole === currentRole) ? '0_' : '1_';
      items.push({
        label: name,
        sortText: `${bucket}${name}`,
        kind: CompletionItemKind.Variable,
        detail: `Registered from ${reg.moduleFqcn}`,
        documentation: {
          kind: MarkupKind.Markdown,
          value: formatRegisteredVarHoverMarkdown(reg, this.registry.getModule(reg.moduleFqcn)),
        },
      });
    }

    for (const magic of ANSIBLE_MAGIC_VARS) {
      if (seen.has(magic.name)) {
        continue;
      }
      seen.add(magic.name);
      items.push({
        label: magic.name,
        sortText: `3_${magic.name}`,
        kind: CompletionItemKind.Variable,
        detail: `Magic variable (${magic.signature})`,
        documentation: { kind: MarkupKind.Markdown, value: magic.description },
      });
    }

    items.sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label));
    return items;
  }

  private completeHandlers(): CompletionItem[] {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    for (const entry of this.documents.values()) {
      const handlers = [...entry.ast.handlers, ...entry.ast.plays.flatMap((p) => p.handlers)];
      for (const handler of handlers) {
        if (handler.name && !seen.has(handler.name)) {
          seen.add(handler.name);
          items.push({
            label: handler.name,
            kind: CompletionItemKind.Event,
            detail: `Handler (${handler.moduleName})`,
          });
        }
      }
    }
    return items;
  }

  private findTaskAtLine(ast: AnsibleDocumentAst, line: number): TaskNode | undefined {
    for (const task of collectAllTasks(ast)) {
      if (line >= task.range.start.line && line <= task.range.end.line) {
        return task;
      }
    }
    return undefined;
  }

  private findPrecedingTaskModule(
    lines: readonly string[],
    lineIdx: number,
  ): { readonly moduleName: string } | undefined {
    const currentIndent = countLeadingSpaces(lines[lineIdx] ?? '');
    for (let i = lineIdx - 1; i >= 0; i--) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        continue;
      }
      const indent = countLeadingSpaces(line);
      if (indent < currentIndent) {
        let afterIndent = line.slice(indent);
        if (afterIndent.startsWith('- ') || afterIndent.startsWith('-\t')) {
          afterIndent = afterIndent.slice(1).trimStart();
        }
        const colonIdx = afterIndent.indexOf(':');
        if (colonIdx > 0) {
          const key = afterIndent.slice(0, colonIdx).trim();
          if (!TASK_LEVEL_NON_MODULE_KEYS.has(key) && this.registry.getModule(key)) {
            return { moduleName: key };
          }
          if (line.trimStart().startsWith('- ')) {
            return undefined;
          }
        }
      }
    }
    return undefined;
  }

  private findModuleContextAtLine(
    ast: AnsibleDocumentAst,
    lines: readonly string[],
    lineIdx: number,
  ) {
    const task = this.findTaskAtLine(ast, lineIdx);
    if (task) {
      const mod = this.registry.getModule(task.moduleName);
      if (mod && lineIdx > task.moduleRange.start.line) {
        const currentIndent = countLeadingSpaces(lines[lineIdx] ?? '');
        if (currentIndent > task.moduleRange.start.column) {
          return mod;
        }
      }
    }
    const preceding = this.findPrecedingTaskModule(lines, lineIdx);
    return preceding ? this.registry.getModule(preceding.moduleName) : undefined;
  }

  private findHandlerLocations(handlerName: string, fromUri?: string): Location[] {
    const locs: Location[] = [];
    for (const [docUri, entry] of this.documents.entries()) {
      const handlers = [...entry.ast.handlers, ...entry.ast.plays.flatMap((p) => p.handlers)];
      for (const h of handlers) {
        if (h.name === handlerName) {
          locs.push({
            uri: docUri,
            range: toLspRange(h.nameRange ?? h.range),
          });
        }
      }
    }
    if (locs.length <= 1 || !fromUri) {
      return locs;
    }
    const canonicalFrom = normalizeDocumentUri(fromUri);
    const sameDoc = locs.filter((l) => l.uri === canonicalFrom);
    if (sameDoc.length > 0) {
      return [sameDoc[0]!];
    }
    const currentRole = extractRoleNameFromUri(canonicalFrom);
    if (currentRole !== undefined) {
      const sameRole = locs.filter((l) => extractRoleNameFromUri(l.uri) === currentRole);
      if (sameRole.length > 0) {
        return [sameRole[0]!];
      }
    }
    return locs;
  }

  private extractNotifyHandlerAtPosition(
    lines: readonly string[],
    lineIdx: number,
    character: number,
    notifyNames: readonly string[],
  ): { readonly handlerName: string; readonly originSelectionRange: Range } | undefined {
    const line = lines[lineIdx] ?? '';
    const indent = countLeadingSpaces(line);
    const trimmed = line.slice(indent);
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      return undefined;
    }

    // Determine the raw value slice [rawValueStart, line.length) ONLY if this line is:
    //   (a) `notify: <handler>` (inline value on the notify key line), OR
    //   (b) `- <handler>` strictly nested as a sequence item under a `notify:` key.
    let rawValueStart = -1;

    const lineKey = extractYamlLineKey(line);
    if (lineKey === 'notify') {
      const colonIdx = line.indexOf(':', indent);
      if (colonIdx === -1 || character <= colonIdx) {
        return undefined;
      }
      rawValueStart = colonIdx + 1;
    } else if (isYamlSequenceItem(trimmed)) {
      // Never match `- name: ...` or any other mapping entry inside a task.
      if (lineKey !== undefined) {
        return undefined;
      }
      if (!isWithinNotifySequence(lines, lineIdx)) {
        return undefined;
      }
      rawValueStart = indent + 1;
    } else {
      return undefined;
    }

    // Skip leading whitespace before the handler value.
    let startCol = rawValueStart;
    while (startCol < line.length && (line[startCol] === ' ' || line[startCol] === '\t')) {
      startCol++;
    }
    if (startCol >= line.length) {
      return undefined;
    }

    // Find end of scalar value, handling optional single/double quotes and ignoring trailing `# comment`.
    let endCol = line.length;
    const firstCh = line[startCol];
    if (firstCh === '"' || firstCh === "'") {
      const closeIdx = findClosingQuote(line, startCol + 1, firstCh);
      if (closeIdx === -1) {
        return undefined;
      }
      // Exclude the surrounding quotes from the handler name and highlight range.
      startCol += 1;
      endCol = closeIdx;
    } else {
      // Strip trailing unquoted `# comment` (preceded by whitespace or start of value).
      const commentIdx = findUnquotedCommentIndex(line, startCol);
      if (commentIdx !== -1) {
        endCol = commentIdx;
      }
      while (endCol > startCol && (line[endCol - 1] === ' ' || line[endCol - 1] === '\t')) {
        endCol--;
      }
    }

    if (endCol <= startCol) {
      return undefined;
    }

    // Cursor must be strictly inside the handler value span (not on `notify:`, `- `, whitespace, or `# comment`).
    if (character < startCol || character > endCol) {
      return undefined;
    }

    const candidate = line.slice(startCol, endCol);
    if (!notifyNames.includes(candidate)) {
      return undefined;
    }

    return {
      handlerName: candidate,
      originSelectionRange: {
        start: { line: lineIdx, character: startCol },
        end: { line: lineIdx, character: endCol },
      },
    };
  }

  private resolveTaskAssetPath(
    docUri: string,
    ansibleRoot: string,
    moduleName: string,
    srcValue: string,
  ): string | undefined {
    const docDir = path.dirname(uriToFsPath(docUri));
    const subDir = moduleName.endsWith('template') ? 'templates' : 'files';
    const candidates = [
      path.resolve(docDir, srcValue),
      path.resolve(docDir, subDir, srcValue),
      path.resolve(docDir, '..', subDir, srcValue),
      path.resolve(ansibleRoot, srcValue),
      path.resolve(ansibleRoot, subDir, srcValue),
    ];
    for (const candidate of candidates) {
      if (this.fs.exists(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  private findWorkspaceRootForUri(uri: string): string | undefined {
    const fsPath = uriToFsPath(uri);
    const normDoc = fsPath.replaceAll('\\', '/');
    for (const customRoot of this.ansibleRootPaths) {
      if (normDoc.startsWith(customRoot.replaceAll('\\', '/'))) {
        return customRoot;
      }
    }
    for (const root of this.workspaceRoots) {
      if (fsPath.startsWith(root) || normDoc.startsWith(root.replaceAll('\\', '/'))) {
        return root;
      }
    }
    let dir = path.dirname(fsPath);
    for (let i = 0; i < 8; i++) {
      if (this.fs.exists(path.join(dir, 'ansible.cfg'))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return this.ansibleRootPaths[0] ?? this.workspaceRoots[0];
  }
}

/** Extracts `<role>` when `uri` resides inside `roles/<role>/...` (tasks, handlers, defaults, vars, templates). */
function extractRoleNameFromUri(uri: string): string | undefined {
  const fsPath = uriToFsPath(uri).replaceAll('\\', '/');
  const segments = fsPath.split('/').filter((s) => s.length > 0);
  const rolesIdx = segments.lastIndexOf('roles');
  if (rolesIdx === -1 || rolesIdx + 2 >= segments.length) {
    return undefined;
  }
  const roleName = segments[rolesIdx + 1];
  return roleName && roleName.length > 0 ? roleName : undefined;
}

/** Extracts `<namespace>.<collection>` from a valid 3+ segment FQCN without regex. */
function extractCollectionFromFqcn(moduleName: string): string | undefined {
  const parts = moduleName.split('.');
  if (parts.length < 3) {
    return undefined;
  }
  for (const part of parts) {
    if (part.length === 0) {
      return undefined;
    }
    for (let i = 0; i < part.length; i++) {
      const c = part.charCodeAt(i);
      const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
      if (!ok) {
        return undefined;
      }
    }
  }
  return `${parts[0]!.toLowerCase()}.${parts[1]!.toLowerCase()}`;
}

function resolveRelativeFsPath(baseDir: string, ...segments: readonly string[]): string {
  const normalizedBase = baseDir.replaceAll('\\', '/');
  if (normalizedBase.startsWith('/')) {
    return path.posix.resolve(normalizedBase, ...segments.map((s) => s.replaceAll('\\', '/')));
  }
  return path.resolve(baseDir, ...segments);
}

function countLeadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length) {
    const c = line.charCodeAt(count);
    if (c !== 32 && c !== 9) {
      break;
    }
    count++;
  }
  return count;
}

function isHostsCompletionPrefix(beforeCursor: string): boolean {
  let s = beforeCursor.trimStart();
  if (s.startsWith('-')) {
    s = s.slice(1).trimStart();
  }
  if (!s.startsWith('hosts')) {
    return false;
  }
  s = s.slice('hosts'.length).trimStart();
  if (!s.startsWith(':')) {
    return false;
  }
  s = s.slice(1).trimStart();
  return !s.includes(' ') && !s.includes('\t');
}

function extractTrailingDottedAccess(
  beforeCursor: string,
): { readonly rootVar: string; readonly subPath: string } | undefined {
  let idx = beforeCursor.length;
  while (idx > 0) {
    const c = beforeCursor.charCodeAt(idx - 1);
    const isIdOrDot =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46;
    if (!isIdOrDot) {
      break;
    }
    idx--;
  }
  const token = beforeCursor.slice(idx);
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) {
    return undefined;
  }
  const rootVar = token.slice(0, dotIdx);
  const first = rootVar.charCodeAt(0);
  const validStart = (first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95;
  if (!validStart) {
    return undefined;
  }
  return { rootVar, subPath: token.slice(dotIdx + 1) };
}

function isFilterCompletionPrefix(
  beforeCursor: string,
  lines?: readonly string[],
  lineIdx?: number,
): boolean {
  const pipeIdx = beforeCursor.lastIndexOf('|');
  if (pipeIdx === -1) {
    return false;
  }
  const afterPipe = beforeCursor.slice(pipeIdx + 1).trimStart();
  for (let i = 0; i < afterPipe.length; i++) {
    const c = afterPipe.charCodeAt(i);
    const isId = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    if (!isId) {
      return false;
    }
  }
  const beforePipe = beforeCursor.slice(0, pipeIdx);
  return isInsideExpressionOrCondition(beforePipe, beforePipe, lines, lineIdx);
}

function extractParamValuePrefixKey(beforeCursor: string): string | undefined {
  const trimmed = beforeCursor.trimStart();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0) {
    return undefined;
  }
  const key = trimmed.slice(0, colonIdx).trim();
  if (key.length === 0) {
    return undefined;
  }
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 95 ||
      c === 46 ||
      c === 45;
    if (!ok) {
      return undefined;
    }
  }
  const valPart = trimmed.slice(colonIdx + 1).trimStart();
  for (let i = 0; i < valPart.length; i++) {
    const c = valPart.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;
    if (!ok) {
      return undefined;
    }
  }
  return key;
}

function parseIniInventory(content: string): InventoryInfo {
  const hosts = new Set<string>();
  const groups = new Set<string>();
  let inChildren = false;

  for (const rawLine of content.replaceAll('\r\n', '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']') && line.length > 2) {
      const section = line.slice(1, -1);
      if (!section.includes('[') && !section.includes(']')) {
        inChildren = section.endsWith(':children');
        const groupName = section.split(':')[0] ?? '';
        if (groupName) {
          groups.add(groupName);
        }
        continue;
      }
    }
    if (inChildren) {
      groups.add(line);
      continue;
    }
    const hostToken = line.split(/\s+/)[0];
    if (hostToken && !hostToken.includes('=')) {
      hosts.add(hostToken);
    }
  }

  return {
    hosts: Array.from(hosts),
    groups: Array.from(groups),
  };
}

function resolveNestedReturnField(
  reg: InferredRegisteredVariable,
  pathParts: readonly string[],
): InferredReturnField | undefined {
  const first = pathParts[0];
  if (!first) {
    return undefined;
  }
  let current: InferredReturnField | undefined = reg.fields[first];
  for (let i = 1; i < pathParts.length && current; i++) {
    const part = pathParts[i];
    if (!part) {
      break;
    }
    current = current.children?.[part];
  }
  return current;
}

const CONDITION_KEYS: ReadonlySet<string> = new Set([
  'when',
  'changed_when',
  'failed_when',
  'until',
  'that',
]);

/** Maximum number of lines scanned upward when resolving a multi-line condition's parent key. */
const MAX_CONDITION_WALK_LINES = 200;

function isYamlSequenceItem(trimmedStart: string): boolean {
  return trimmedStart === '-' || trimmedStart.startsWith('- ') || trimmedStart.startsWith('-\t');
}

/** Extracts the mapping key on a YAML line (after an optional `- ` prefix), or `undefined`. */
function extractYamlLineKey(line: string): string | undefined {
  let s = line.trimStart();
  if (isYamlSequenceItem(s)) {
    s = s.slice(1).trimStart();
  }
  const colonIdx = s.indexOf(':');
  if (colonIdx <= 0) {
    return undefined;
  }
  const key = s.slice(0, colonIdx).trim();
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 95 ||
      c === 46 ||
      c === 45;
    if (!ok) {
      return undefined;
    }
  }
  return key;
}

/**
 * Walks upward from a YAML sequence item line to verify its enclosing mapping key is `notify:`.
 */
function isWithinNotifySequence(lines: readonly string[], lineIdx: number): boolean {
  const current = lines[lineIdx] ?? '';
  const currentIndent = countLeadingSpaces(current);
  const stop = Math.max(0, lineIdx - MAX_CONDITION_WALK_LINES);
  for (let i = lineIdx - 1; i >= stop; i--) {
    const candidate = lines[i] ?? '';
    const indent = countLeadingSpaces(candidate);
    const body = candidate.slice(indent);
    if (body.length === 0 || body.startsWith('#')) {
      continue;
    }
    if (indent > currentIndent) {
      continue;
    }
    const candidateIsItem = isYamlSequenceItem(body);
    if (indent === currentIndent) {
      if (candidateIsItem) {
        if (extractYamlLineKey(candidate) !== undefined) {
          // Hit a task-level `- name:` / `- module:` mapping item, not a plain notify list sibling.
          return false;
        }
        continue;
      }
      // `notify:` followed by a zero-indented `- Handler` sequence.
      return extractYamlLineKey(candidate) === 'notify';
    }
    return extractYamlLineKey(candidate) === 'notify';
  }
  return false;
}

/** Finds the matching closing quote index for a single- or double-quoted YAML scalar. */
function findClosingQuote(line: string, startAfterOpen: number, quote: string): number {
  for (let i = startAfterOpen; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"' && ch === '\\' && i + 1 < line.length) {
      i++;
      continue;
    }
    if (quote === "'" && ch === "'" && line[i + 1] === "'") {
      i++;
      continue;
    }
    if (ch === quote) {
      return i;
    }
  }
  return -1;
}

/** Finds the index of a YAML `#` comment starting at or after `fromIdx` (preceded by whitespace or start). */
function findUnquotedCommentIndex(line: string, fromIdx: number): number {
  for (let i = fromIdx; i < line.length; i++) {
    if (line[i] === '#') {
      if (i === fromIdx || line[i - 1] === ' ' || line[i - 1] === '\t') {
        return i;
      }
    }
  }
  return -1;
}

/** Returns true if `character` falls inside a YAML `# ...` comment (ignoring `#` inside quotes). */
function isPositionInYamlComment(line: string, character: number): boolean {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== undefined) {
      if (quote === '"' && ch === '\\' && i + 1 < line.length) {
        i++;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return character >= i;
    }
  }
  return false;
}

/**
 * Determines whether `lines[lineIdx]` is nested under a `when:` / `changed_when:` /
 * `failed_when:` / `until:` / `that:` key, e.g. an item of a multi-line `when:` list
 * or a folded block-scalar continuation line.
 */
function isWithinMultiLineCondition(lines: readonly string[], lineIdx: number): boolean {
  const current = lines[lineIdx] ?? '';
  const currentIndent = countLeadingSpaces(current);
  const currentIsItem = isYamlSequenceItem(current.slice(currentIndent));
  const stop = Math.max(0, lineIdx - MAX_CONDITION_WALK_LINES);
  for (let i = lineIdx - 1; i >= stop; i--) {
    const candidate = lines[i] ?? '';
    const indent = countLeadingSpaces(candidate);
    const body = candidate.slice(indent);
    if (body.length === 0 || body.startsWith('#')) {
      continue;
    }
    if (indent > currentIndent) {
      continue;
    }
    const candidateIsItem = isYamlSequenceItem(body);
    if (indent === currentIndent) {
      if (currentIsItem && candidateIsItem) {
        // Sibling list item (`- a` / `- b`) — keep walking to the parent key.
        continue;
      }
      if (!currentIsItem && !candidateIsItem) {
        if (extractYamlLineKey(candidate) !== undefined) {
          // Sibling mapping key (e.g. another module parameter) — not a condition.
          return false;
        }
        // Folded/plain multi-line scalar continuation — keep walking.
        continue;
      }
      if (candidateIsItem) {
        return false;
      }
      // `when:` followed by a zero-indented `- item` sequence.
    }
    const key = extractYamlLineKey(candidate);
    return key !== undefined && CONDITION_KEYS.has(key);
  }
  return false;
}

function isInsideExpressionOrCondition(
  beforeCursor: string,
  fullLine: string,
  lines?: readonly string[],
  lineIdx?: number,
): boolean {
  const lastOpen = beforeCursor.lastIndexOf('{{');
  const lastClose = beforeCursor.lastIndexOf('}}');
  if (lastOpen > lastClose) {
    return true;
  }
  const lastStmtOpen = beforeCursor.lastIndexOf('{%');
  const lastStmtClose = beforeCursor.lastIndexOf('%}');
  if (lastStmtOpen > lastStmtClose) {
    return true;
  }
  const key = extractYamlLineKey(fullLine);
  if (key !== undefined && CONDITION_KEYS.has(key)) {
    return true;
  }
  if (lines !== undefined && lineIdx !== undefined) {
    return isWithinMultiLineCondition(lines, lineIdx);
  }
  return false;
}

/** Returns the trailing `[A-Za-z0-9_]*` identifier fragment immediately before the cursor. */
function extractTrailingIdentifier(beforeCursor: string): string {
  let idx = beforeCursor.length;
  while (idx > 0) {
    const c = beforeCursor.charCodeAt(idx - 1);
    const isId = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    if (!isId) {
      break;
    }
    idx--;
  }
  return beforeCursor.slice(idx);
}

/**
 * Attaches an explicit `textEdit` replacing only the identifier fragment being typed,
 * so VS Code's YAML word pattern (which treats `foo.bar.` as one word) never filters
 * valid suggestions away.
 */
function withReplaceRange(items: CompletionItem[], range: Range): CompletionItem[] {
  return items.map((item) => {
    const newText = typeof item.insertText === 'string' ? item.insertText : item.label;
    return {
      ...item,
      filterText: item.filterText ?? item.label,
      textEdit: { range, newText },
    };
  });
}

function matchesPrefix(name: string, prefix: string): boolean {
  return prefix.length === 0 || name.toLowerCase().startsWith(prefix.toLowerCase());
}

function isIdentifierCharCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/** Returns true when `head` ends with the standalone word `word` (preceded by a non-identifier). */
function endsWithWord(head: string, word: string): boolean {
  if (!head.endsWith(word)) {
    return false;
  }
  const idx = head.length - word.length;
  return idx === 0 || !isIdentifierCharCode(head.charCodeAt(idx - 1));
}

/** Detects `... is <partial>` / `... is not <partial>` (Jinja2 test position) without regex. */
function isJinjaTestPrefix(beforeCursor: string, partialPrefix: string): boolean {
  const head = beforeCursor.slice(0, beforeCursor.length - partialPrefix.length);
  const trimmed = head.trimEnd();
  if (trimmed.length === head.length) {
    // `is` / `not` must be followed by whitespace.
    return false;
  }
  if (endsWithWord(trimmed, 'is')) {
    return true;
  }
  if (endsWithWord(trimmed, 'not')) {
    const withoutNot = trimmed.slice(0, -3);
    const t2 = withoutNot.trimEnd();
    return t2.length < withoutNot.length && endsWithWord(t2, 'is');
  }
  return false;
}

/** URI scheme of the read-only rendered module docs virtual documents. */
export const MODULE_DOCS_SCHEME = 'ansible-lens-docs';

/** Builds `ansible-lens-docs://module/<fqcn>.md` for a module name. */
export function buildModuleDocsUri(moduleName: string): string {
  return `${MODULE_DOCS_SCHEME}://module/${encodeURIComponent(moduleName)}.md`;
}

function toLspRange(range: SourceRange): Range {
  return {
    start: { line: range.start.line, character: range.start.column },
    end: { line: range.end.line, character: range.end.column },
  };
}

function toLspDiagnostic(diag: LintDiagnostic): Diagnostic {
  const severity =
    diag.severity === 'error'
      ? DiagnosticSeverity.Error
      : diag.severity === 'warning'
        ? DiagnosticSeverity.Warning
        : DiagnosticSeverity.Information;
  return {
    range: toLspRange(diag.range),
    severity,
    code: diag.ruleId,
    ...(diag.docUrl ? { codeDescription: { href: diag.docUrl } } : {}),
    source: 'ansible-lens',
    message: diag.message,
  };
}

function deduplicateDiagnostics(list: readonly LintDiagnostic[]): LintDiagnostic[] {
  const seen = new Set<string>();
  const out: LintDiagnostic[] = [];
  for (const item of list) {
    const key = `${item.ruleId}:${item.range.start.line}:${item.range.start.column}:${item.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function isPositionInRange(pos: Position, range: SourceRange): boolean {
  return isPosInRange(pos, range.start, range.end);
}

function isPosInRange(pos: Position, start: SourcePosition, end: SourcePosition): boolean {
  if (pos.line < start.line || pos.line > end.line) {
    return false;
  }
  if (pos.line === start.line && pos.character < start.column) {
    return false;
  }
  if (pos.line === end.line && pos.character > end.column) {
    return false;
  }
  return true;
}

function rangesOverlap(a: Range, b: Range): boolean {
  if (a.end.line < b.start.line || b.end.line < a.start.line) {
    return false;
  }
  if (a.end.line === b.start.line && a.end.character < b.start.character) {
    return false;
  }
  if (b.end.line === a.start.line && b.end.character < a.start.character) {
    return false;
  }
  return true;
}

function extractWordTokenAtPosition(line: string, character: number): string | undefined {
  if (line.length === 0) {
    return undefined;
  }
  const idx = Math.min(Math.max(character, 0), line.length - 1);
  const isWordChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_.-]/.test(ch);

  let start = idx;
  if (!isWordChar(line[start]) && start > 0 && isWordChar(line[start - 1])) {
    start -= 1;
  }
  if (!isWordChar(line[start])) {
    return undefined;
  }
  while (start > 0 && isWordChar(line[start - 1])) {
    start -= 1;
  }
  let end = start;
  while (end < line.length && isWordChar(line[end])) {
    end += 1;
  }
  return line.slice(start, end);
}

function extractDottedTokenAtPosition(line: string, character: number): string | undefined {
  const token = extractWordTokenAtPosition(line, character);
  if (!token || !token.includes('.')) {
    return undefined;
  }
  return token;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
