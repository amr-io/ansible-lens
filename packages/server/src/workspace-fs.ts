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
    return path.posix.normalize(filePath.replaceAll('\\', '/'));
  }

  public setFile(filePath: string, content: string): void {
    this.files.set(this.keyOf(filePath), content);
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
 * Converts a `file://` URI or raw filesystem path to a normalized OS path.
 */
export function uriToFsPath(uriOrPath: string): string {
  if (uriOrPath.startsWith('file://')) {
    return URI.parse(uriOrPath).fsPath;
  }
  return path.normalize(uriOrPath);
}

/**
 * Converts a filesystem path to a canonical `file://` URI.
 */
export function fsPathToUri(fsPath: string): string {
  if (fsPath.startsWith('file://')) {
    return fsPath;
  }
  return URI.file(fsPath).toString();
}
