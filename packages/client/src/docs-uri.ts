// Pure helpers for the `ansible-lens-docs:` virtual documents (no `vscode` import, unit-testable).

/** URI scheme of the read-only rendered module docs (must match the server's `MODULE_DOCS_SCHEME`). */
export const MODULE_DOCS_SCHEME = 'ansible-lens-docs';

/** Custom LSP request served by the Ansible Lens language server. */
export const GET_MODULE_DOCS_REQUEST = 'ansibleLens/getModuleDocsMarkdown';

/**
 * Extracts the module name from an `ansible-lens-docs://module/<fqcn>.md` URI path.
 * Pure helper — exported for unit testing.
 */
export function parseModuleNameFromDocsPath(uriPath: string): string {
  let name = uriPath;
  while (name.startsWith('/')) {
    name = name.slice(1);
  }
  if (name.endsWith('.md')) {
    name = name.slice(0, -3);
  }
  try {
    return decodeURIComponent(name);
  } catch (error) {
    if (error instanceof URIError) {
      // Malformed percent-encoding: fall back to the raw path segment.
      return name;
    }
    throw error;
  }
}

/** Builds the canonical docs.ansible.com URL for an FQCN (offline fallback). */
export function buildOfflineDocUrl(moduleName: string): string {
  const parts = moduleName.split('.');
  if (parts.length < 3) {
    return 'https://docs.ansible.com/ansible/latest/collections/index.html';
  }
  const [ns, coll, ...rest] = parts;
  return `https://docs.ansible.com/ansible/latest/collections/${ns ?? ''}/${coll ?? ''}/${rest.join('.')}_module.html`;
}

/** Markdown shown when the language server cannot be reached. */
export function formatOfflineDocsMarkdown(moduleName: string): string {
  return [
    `[Open Official Docs on docs.ansible.com](${buildOfflineDocUrl(moduleName)})`,
    '',
    `# \`${moduleName}\``,
    '',
    'The Ansible Lens language server is not available yet; open the official documentation above.',
  ].join('\n');
}

/** Minimal structural representation of a VS Code `Uri` (zero `vscode` runtime imports). */
export interface DocsUriLike {
  readonly scheme: string;
  readonly path: string;
}

function isDocsUriLike(value: unknown): value is DocsUriLike {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj['scheme'] === 'string' && typeof obj['path'] === 'string';
}

/**
 * Extracts the first `ansible-lens-docs:` target URI from a VS Code definition result
 * (`Location`, `Location[]`, or `LocationLink[]`). Returns `undefined` when the definition
 * points to a normal workspace file or is empty.
 */
export function extractModuleDocsTargetUri(result: unknown): DocsUriLike | undefined {
  if (result === null || result === undefined) {
    return undefined;
  }
  const items: readonly unknown[] = Array.isArray(result) ? result : [result];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const candidate = 'targetUri' in obj ? obj['targetUri'] : obj['uri'];
    if (isDocsUriLike(candidate) && candidate.scheme === MODULE_DOCS_SCHEME) {
      return { scheme: candidate.scheme, path: candidate.path };
    }
  }
  return undefined;
}

/**
 * Resolves the official `docs.ansible.com` URL when a definition result targets an
 * `ansible-lens-docs:` virtual document, or returns `undefined` for non-docs targets.
 */
export function resolveOpenInBrowserUrl(result: unknown): string | undefined {
  const targetUri = extractModuleDocsTargetUri(result);
  if (!targetUri) {
    return undefined;
  }
  const moduleName = parseModuleNameFromDocsPath(targetUri.path);
  if (moduleName.length === 0) {
    return undefined;
  }
  return buildOfflineDocUrl(moduleName);
}
