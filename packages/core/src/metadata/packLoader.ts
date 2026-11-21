import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type {
  CollectionMetadataPack,
  CollectionPackManifestEntry,
  MetadataManifest,
  ModuleMetadataSpec,
} from '../contracts/types.js';

export const DEFAULT_MANIFEST_URL =
  'https://github.com/amr-vibe/ansible-lens/releases/download/metadata-latest/manifest.json';

/**
 * Injectable remote fetcher interface for downloading `manifest.json` and `.json.gz` collection packs.
 * Enables deterministic offline testing and easy swapping of HTTP clients.
 */
export interface IMetadataFetcher {
  fetchText(url: string): Promise<string>;
  fetchBytes(url: string): Promise<Uint8Array>;
}

/**
 * Default Node.js 20+ `fetch`-backed implementation of `IMetadataFetcher`.
 */
export class NodeMetadataFetcher implements IMetadataFetcher {
  public async fetchText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return res.text();
  }

  public async fetchBytes(url: string): Promise<Uint8Array> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }
}

/** Result returned by `MetadataPackLoader.syncFromManifest` describing applied delta updates. */
export interface MetadataSyncResult {
  readonly updatedCollections: readonly string[];
  readonly skippedCollections: readonly string[];
  readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Computes lowercase hex SHA-256 digest of a byte buffer. */
export function computeSha256(data: Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Validates that a parsed JSON value conforms to `CollectionMetadataPack` schema v1.
 */
export function validateCollectionPack(value: unknown): CollectionMetadataPack {
  if (!isRecord(value)) {
    throw new Error('Invalid CollectionMetadataPack: expected object');
  }
  if (value['schemaVersion'] !== 1) {
    throw new Error(
      `Unsupported CollectionMetadataPack schemaVersion: ${String(value['schemaVersion'])}`,
    );
  }
  if (typeof value['collection'] !== 'string' || value['collection'].length === 0) {
    throw new Error('Invalid CollectionMetadataPack: missing collection name');
  }
  if (typeof value['version'] !== 'string') {
    throw new Error('Invalid CollectionMetadataPack: missing version');
  }
  if (typeof value['generatedAt'] !== 'string') {
    throw new Error('Invalid CollectionMetadataPack: missing generatedAt');
  }
  if (!isRecord(value['modules'])) {
    throw new Error('Invalid CollectionMetadataPack: missing modules map');
  }

  for (const [fqcn, mod] of Object.entries(value['modules'])) {
    if (!isRecord(mod) || typeof mod['fqcn'] !== 'string' || typeof mod['shortName'] !== 'string') {
      throw new Error(`Invalid module entry in pack ${value['collection']}: ${fqcn}`);
    }
  }

  return value as unknown as CollectionMetadataPack;
}

/**
 * Validates that a parsed JSON value conforms to `MetadataManifest` schema v1.
 */
export function validateMetadataManifest(value: unknown): MetadataManifest {
  if (!isRecord(value)) {
    throw new Error('Invalid MetadataManifest: expected object');
  }
  if (value['schemaVersion'] !== 1) {
    throw new Error(
      `Unsupported MetadataManifest schemaVersion: ${String(value['schemaVersion'])}`,
    );
  }
  if (typeof value['generatedAt'] !== 'string' || typeof value['ansibleCoreVersion'] !== 'string') {
    throw new Error('Invalid MetadataManifest: missing generatedAt or ansibleCoreVersion');
  }
  if (!isRecord(value['collections'])) {
    throw new Error('Invalid MetadataManifest: missing collections map');
  }
  for (const [colName, entry] of Object.entries(value['collections'])) {
    if (
      !isRecord(entry) ||
      typeof entry['collection'] !== 'string' ||
      typeof entry['version'] !== 'string' ||
      typeof entry['fileName'] !== 'string' ||
      typeof entry['sha256'] !== 'string'
    ) {
      throw new Error(`Invalid manifest collection entry: ${colName}`);
    }
  }
  return value as unknown as MetadataManifest;
}

/**
 * Loads, SHA-256-verifies, caches, and delta-updates compressed `.json.gz` metadata packs.
 */
export class MetadataPackLoader {
  private readonly cacheDir: string;
  private readonly fetcher: IMetadataFetcher | undefined;

  public constructor(cacheDir: string, fetcher?: IMetadataFetcher) {
    this.cacheDir = cacheDir;
    this.fetcher = fetcher;
  }

  /**
   * Decompresses a `.json.gz` buffer, optionally verifying its SHA-256 digest first,
   * then parses and validates the `CollectionMetadataPack`.
   */
  public parseCompressedPack(
    compressedBytes: Uint8Array,
    expectedSha256?: string,
  ): CollectionMetadataPack {
    if (expectedSha256 !== undefined) {
      const actualSha = computeSha256(compressedBytes);
      if (actualSha.toLowerCase() !== expectedSha256.toLowerCase()) {
        throw new Error(
          `Metadata pack SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha}`,
        );
      }
    }

    const jsonBytes = zlib.gunzipSync(compressedBytes);
    const parsed: unknown = JSON.parse(jsonBytes.toString('utf8'));
    return validateCollectionPack(parsed);
  }

  /**
   * Loads a `.json.gz` pack from a file path on disk with optional SHA-256 verification.
   */
  public loadPackFromFile(filePath: string, expectedSha256?: string): CollectionMetadataPack {
    const bytes = fs.readFileSync(filePath);
    return this.parseCompressedPack(bytes, expectedSha256);
  }

  /**
   * Reads and validates `manifest.json` from a local file path.
   */
  public loadManifestFromFile(manifestPath: string): MetadataManifest {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return validateMetadataManifest(parsed);
  }

  /**
   * Checks whether a cached `.json.gz` file exists and matches the manifest entry's SHA-256.
   */
  public hasValidCachedPack(entry: CollectionPackManifestEntry): boolean {
    const targetPath = path.join(this.cacheDir, entry.fileName);
    if (!fs.existsSync(targetPath)) {
      return false;
    }
    try {
      const bytes = fs.readFileSync(targetPath);
      return computeSha256(bytes).toLowerCase() === entry.sha256.toLowerCase();
    } catch (err) {
      void err;
      return false;
    }
  }

  /**
   * Ensures a collection pack is available in the local cache, downloading and verifying SHA-256
   * via the injected `IMetadataFetcher` if missing or stale.
   */
  public async ensureCollectionPack(
    entry: CollectionPackManifestEntry,
    baseUrl?: string,
  ): Promise<CollectionMetadataPack> {
    const targetPath = path.join(this.cacheDir, entry.fileName);

    if (this.hasValidCachedPack(entry)) {
      return this.loadPackFromFile(targetPath, entry.sha256);
    }

    if (!this.fetcher) {
      throw new Error(
        `Collection pack ${entry.collection} is not cached and no IMetadataFetcher was configured`,
      );
    }

    const url =
      entry.downloadUrl ??
      (baseUrl !== undefined ? `${baseUrl.replace(/\/$/, '')}/${entry.fileName}` : undefined);
    if (!url) {
      throw new Error(
        `No downloadUrl or baseUrl available for collection pack ${entry.collection}`,
      );
    }

    const downloaded = await this.fetcher.fetchBytes(url);
    const pack = this.parseCompressedPack(downloaded, entry.sha256);

    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(targetPath, downloaded);

    return pack;
  }

  /**
   * Fetches remote `manifest.json`, compares against local cache/manifest, and downloads only
   * collections whose version or SHA-256 changed (delta update).
   */
  public async syncFromManifest(
    manifestUrl: string,
    requestedCollections?: readonly string[],
  ): Promise<{
    manifest: MetadataManifest;
    packs: Map<string, CollectionMetadataPack>;
    result: MetadataSyncResult;
  }> {
    if (!this.fetcher) {
      throw new Error('Cannot sync metadata packs without an IMetadataFetcher');
    }

    const manifestText = await this.fetcher.fetchText(manifestUrl);
    const parsedManifest: unknown = JSON.parse(manifestText);
    const manifest = validateMetadataManifest(parsedManifest);
    const baseUrl = manifestUrl.slice(0, manifestUrl.lastIndexOf('/'));

    const targetCollections = requestedCollections ?? Object.keys(manifest.collections);
    const packs = new Map<string, CollectionMetadataPack>();
    const updatedCollections: string[] = [];
    const skippedCollections: string[] = [];
    const errors: string[] = [];

    for (const colName of targetCollections) {
      const entry = manifest.collections[colName];
      if (!entry) {
        errors.push(`Collection ${colName} not found in manifest`);
        continue;
      }

      const alreadyCached = this.hasValidCachedPack(entry);
      try {
        const pack = await this.ensureCollectionPack(entry, baseUrl);
        packs.set(colName, pack);
        if (alreadyCached) {
          skippedCollections.push(colName);
        } else {
          updatedCollections.push(colName);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to sync ${colName}: ${msg}`);
      }
    }

    // Persist updated manifest.json in cache directory
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.cacheDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );

    return {
      manifest,
      packs,
      result: {
        updatedCollections,
        skippedCollections,
        errors,
      },
    };
  }
}

/**
 * Helper to create a minimal deterministic `ModuleMetadataSpec` entry.
 */
export type { ModuleMetadataSpec };
