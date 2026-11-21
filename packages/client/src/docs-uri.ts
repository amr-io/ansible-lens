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
