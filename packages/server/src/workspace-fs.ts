import fs from 'node:fs';
import path from 'node:path';
import { URI } from 'vscode-uri';
import type { IWorkspaceFs } from '@ansible-lens/core';

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
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
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
        this.files.set(path.normalize(k), v);
      }
    }
  }

  public setFile(filePath: string, content: string): void {
    this.files.set(path.normalize(filePath), content);
  }

  public exists(filePath: string): boolean {
    const normalized = path.normalize(filePath);
    if (this.files.has(normalized)) {
      return true;
    }
    const prefix = normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  public readFile(filePath: string): string | undefined {
    return this.files.get(path.normalize(filePath));
  }

  public listFiles(dirPath: string): readonly string[] {
    const normalized = path.normalize(dirPath);
    const prefix = normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`;
    const results: string[] = [];
    for (const key of this.files.keys()) {
      if (key === normalized || key.startsWith(prefix)) {
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
