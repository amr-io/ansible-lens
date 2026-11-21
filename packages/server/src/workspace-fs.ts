import fs from 'node:fs';
import path from 'node:path';
import { URI } from 'vscode-uri';
import type { IWorkspaceFs } from '@ansible-lens/core';

export const IGNORED_WORKSPACE_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.venv',
  '__pycache__',
  'dist',
]);

function hasIgnoredDirectorySegment(filePath: string): boolean {
  const segments = filePath.replaceAll('\\', '/').split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (seg !== undefined && IGNORED_WORKSPACE_DIRECTORIES.has(seg)) {
      return true;
    }
  }
  return false;
}

/**
 * Node filesystem implementation of `IWorkspaceFs` for workspace scanning and
 * cross-file intelligence.
 */
export class NodeWorkspaceFs implements IWorkspaceFs {
  public exists(filePath: string): boolean {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  public readFile(filePath: string): string | undefined {
    try {
      if (!fs.existsSync(filePath)) {
        return undefined;
      }
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  public listFiles(dirPath: string): readonly string[] {
    try {
      if (!fs.existsSync(dirPath)) {
        return [];
      }
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        return [];
      }
      const results: string[] = [];
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORED_WORKSPACE_DIRECTORIES.has(entry.name)) {
          continue;
        }
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          results.push(...this.listFiles(fullPath));
        } else if (entry.isFile()) {
          results.push(fullPath);
        }
      }
      return results;
    } catch {
      return [];
    }
  }
}

/**
 * In-memory `IWorkspaceFs` implementation useful for deterministic tests.
 */
export class MemoryWorkspaceFs implements IWorkspaceFs {
  private readonly files = new Map<string, string>();

  public constructor(initialFiles?: Readonly<Record<string, string>>) {
    if (initialFiles) {
      for (const [k, v] of Object.entries(initialFiles)) {
        this.files.set(this.keyOf(k), v);
      }
    }
  }

  private keyOf(filePath: string): string {
    return normalizeFsPathForIndex(filePath);
  }

  public setFile(filePath: string, content: string): void {
    this.files.set(this.keyOf(filePath), content);
  }

  public deleteFile(filePath: string): void {
    this.files.delete(this.keyOf(filePath));
  }

  public exists(filePath: string): boolean {
    const normalized = this.keyOf(filePath);
    if (this.files.has(normalized)) {
      return true;
    }
    const prefix = normalized.endsWith('/') ? normalized : `${normalized}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  public readFile(filePath: string): string | undefined {
    return this.files.get(this.keyOf(filePath));
  }

  public listFiles(dirPath: string): readonly string[] {
    const normalized = this.keyOf(dirPath);
    const prefix = normalized.endsWith('/') ? normalized : `${normalized}/`;
    const results: string[] = [];
    for (const key of this.files.keys()) {
      if ((key === normalized || key.startsWith(prefix)) && !hasIgnoredDirectorySegment(key)) {
        results.push(key);
      }
    }
    return results;
  }
}

/**
 * Normalizes a filesystem path to forward slashes and a lower-case Windows drive letter (`c:/...`).
 */
export function normalizeFsPathForIndex(inputPath: string): string {
  const forward = inputPath.replaceAll('\\', '/');
  if (forward.length >= 2 && forward[1] === ':') {
    const drive = forward[0]!.toLowerCase();
    const rest = path.posix.normalize(forward.slice(2) || '/');
    return `${drive}:${rest.startsWith('/') ? rest : `/${rest}`}`;
  }
  return path.posix.normalize(forward);
}

/**
 * Converts a `file://` URI or raw filesystem path to a normalized OS path with a lower-case
 * Windows drive letter when present.
 */
export function uriToFsPath(uriOrPath: string): string {
  let rawPath: string;
  if (uriOrPath.startsWith('file://')) {
    rawPath = URI.parse(uriOrPath).fsPath;
  } else {
    rawPath = path.normalize(uriOrPath);
  }
  if (rawPath.length >= 2 && rawPath[1] === ':') {
    return `${rawPath[0]!.toLowerCase()}${rawPath.slice(1)}`;
  }
  return rawPath;
}

/**
 * Converts a filesystem path or `file://` URI to a canonical `file://` URI with a lower-case
 * Windows drive letter and forward slashes so URIs never mismatch across Windows vs. POSIX.
 */
export function fsPathToUri(fsPathOrUri: string): string {
  if (fsPathOrUri.startsWith('file://')) {
    return normalizeDocumentUri(fsPathOrUri);
  }
  const normalizedPath =
    fsPathOrUri.length >= 2 && fsPathOrUri[1] === ':'
      ? `${fsPathOrUri[0]!.toLowerCase()}${fsPathOrUri.slice(1)}`
      : fsPathOrUri;
  return normalizeDocumentUri(URI.file(normalizedPath).toString());
}

/**
 * Canonicalizes a document URI (`file:///C%3A/...` or `file:///C:/...` -> canonical lower-case drive URI)
 * so map lookups in `AnsibleLanguageService` and `WorkspaceVariableGraph` are case-consistent on Windows.
 */
export function normalizeDocumentUri(uri: string): string {
  if (!uri.startsWith('file://')) {
    return uri;
  }
  const parsed = URI.parse(uri);
  const fsPath = parsed.fsPath;
  const canonicalFsPath =
    fsPath.length >= 2 && fsPath[1] === ':'
      ? `${fsPath[0]!.toLowerCase()}${fsPath.slice(1)}`
      : fsPath;
  return URI.file(canonicalFsPath).toString();
}
