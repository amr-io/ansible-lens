import { createDefaultMetadataRegistry } from '@ansible-lens/core';
import { ensureFallbackModulesLoaded } from './fallback-catalog.js';

export {
  AnsibleLanguageService,
  MODULE_DOCS_SCHEME,
  buildModuleDocsUri,
} from './language-service.js';
export type {
  DiagnosticsInfoReport,
  InventoryInfo,
  LanguageServiceOptions,
  LintConfiguration,
  MetadataConfiguration,
  ServerSettings,
} from './language-service.js';
export { bindLanguageServer, startLanguageServer } from './server.js';
export type { BoundServer } from './server.js';
export { evaluateAnsibleHeuristic, parseDocumentWithFallback } from './ast-fallback.js';
export { FALLBACK_BUILTIN_MODULES, ensureFallbackModulesLoaded } from './fallback-catalog.js';
export { createServerLogger } from './logger.js';
export type { LogLevel, ServerLogSink, ServerLogger } from './logger.js';
export {
  IGNORED_WORKSPACE_DIRECTORIES,
  MemoryWorkspaceFs,
  NodeWorkspaceFs,
  fsPathToUri,
  uriToFsPath,
} from './workspace-fs.js';

export function createServerContext(): { readonly initialized: boolean } {
  const registry = createDefaultMetadataRegistry();
  ensureFallbackModulesLoaded(registry);
  return {
    initialized: registry.listCollections().length > 0,
  };
}
