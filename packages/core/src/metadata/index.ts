import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CollectionMetadataPack,
  IMetadataRegistry,
  ModuleMetadataSpec,
} from '../contracts/types.js';
import { MetadataPackLoader } from './packLoader.js';
import { extractPythonModuleMetadata } from './pythonExtractor.js';

export {
  computeSha256,
  DEFAULT_MANIFEST_URL,
  MetadataPackLoader,
  NodeMetadataFetcher,
  validateCollectionPack,
  validateMetadataManifest,
} from './packLoader.js';
export type { IMetadataFetcher, MetadataSyncResult } from './packLoader.js';
export { extractPythonModuleMetadata } from './pythonExtractor.js';

/**
 * In-memory metadata registry & pack loader supporting bundled `ansible.builtin`,
 * lazy-downloaded `.json.gz` collection packs with SHA-256 verification, and local `.py` extraction.
 */
export class MetadataRegistry implements IMetadataRegistry {
  private readonly modulesByFqcn = new Map<string, ModuleMetadataSpec>();
  private readonly modulesByShortName = new Map<string, ModuleMetadataSpec[]>();
  private readonly collections = new Set<string>();

  public loadPack(pack: CollectionMetadataPack): void {
    this.collections.add(pack.collection);
    for (const mod of Object.values(pack.modules)) {
      this.registerModule(mod);
    }
  }

  public registerModule(mod: ModuleMetadataSpec): void {
    this.collections.add(mod.collection);
    this.modulesByFqcn.set(mod.fqcn, mod);
    const list = this.modulesByShortName.get(mod.shortName) ?? [];
    const filtered = list.filter((m) => m.fqcn !== mod.fqcn);
    filtered.push(mod);
    this.modulesByShortName.set(mod.shortName, filtered);
  }

  /**
   * Registers a custom workspace module directly from its Python source code (`DOCUMENTATION` / `RETURN`).
   */
  public registerPythonModule(
    pythonSource: string,
    fqcn: string,
    collection: string,
  ): ModuleMetadataSpec | undefined {
    const spec = extractPythonModuleMetadata(pythonSource, fqcn, collection);
    if (spec) {
      this.registerModule(spec);
    }
    return spec;
  }

  public getModule(nameOrFqcn: string): ModuleMetadataSpec | undefined {
    const direct = this.modulesByFqcn.get(nameOrFqcn);
    if (direct) {
      return direct;
    }
    const candidates = this.modulesByShortName.get(nameOrFqcn);
    if (!candidates || candidates.length === 0) {
      return undefined;
    }
    return candidates.find((c) => c.collection === 'ansible.builtin') ?? candidates[0];
  }

  public resolveFqcn(shortOrFqcn: string): readonly ModuleMetadataSpec[] {
    const direct = this.modulesByFqcn.get(shortOrFqcn);
    if (direct) {
      return [direct];
    }
    return this.modulesByShortName.get(shortOrFqcn) ?? [];
  }

  public listModules(): readonly ModuleMetadataSpec[] {
    return Array.from(this.modulesByFqcn.values());
  }

  public listCollections(): readonly string[] {
    return Array.from(this.collections.values());
  }
}

function resolveBundledDataPath(fileName: string): string | undefined {
  let currentDir = process.cwd();
  try {
    const metaUrl = import.meta.url;
    if (typeof metaUrl === 'string' && metaUrl.startsWith('file:')) {
      currentDir = path.dirname(fileURLToPath(metaUrl));
    }
  } catch (err) {
    void err;
  }
  const candidates = [
    // From bundled dist/ (packages/client/dist/data/)
    path.resolve(currentDir, 'data', fileName),
    path.resolve(currentDir, '../data', fileName),
    // From packages/core/src/metadata/ -> packages/core/data/
    path.resolve(currentDir, '../../data', fileName),
    // From packages/core/dist/metadata/ -> packages/core/data/
    path.resolve(currentDir, '../../../data', fileName),
    // Fallback relative to process.cwd()
    path.resolve(process.cwd(), 'packages/core/data', fileName),
    path.resolve(process.cwd(), 'data', fileName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Creates a default `MetadataRegistry` preloaded with the bundled `ansible.builtin.json.gz` pack
 * (verified against `manifest.json` when available).
 */
export function createDefaultMetadataRegistry(): MetadataRegistry {
  const registry = new MetadataRegistry();
  const packPath = resolveBundledDataPath('ansible.builtin.json.gz');
  if (!packPath) {
    return registry;
  }

  const loader = new MetadataPackLoader(path.dirname(packPath));
  const manifestPath = resolveBundledDataPath('manifest.json');
  let expectedSha: string | undefined;

  if (manifestPath) {
    try {
      const manifest = loader.loadManifestFromFile(manifestPath);
      expectedSha = manifest.collections['ansible.builtin']?.sha256;
    } catch (err) {
      void err;
    }
  }

  try {
    const pack = loader.loadPackFromFile(packPath, expectedSha);
    registry.loadPack(pack);
  } catch (err) {
    void err;
  }

  return registry;
}
