import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { computeSha256 } from '@ansible-lens/core';
import type {
  CollectionMetadataPack,
  CollectionPackManifestEntry,
  MetadataManifest,
  ModuleDeprecationInfo,
  ModuleMetadataSpec,
  ModuleOptionSpec,
  ModuleOptionType,
  ModuleReturnFieldSpec,
} from '@ansible-lens/core';

export const TOP_COLLECTIONS = [
  'ansible.builtin',
  'ansible.posix',
  'community.general',
  'community.docker',
  'community.crypto',
  'ansible.windows',
  'amazon.aws',
  'kubernetes.core',
  'community.mysql',
  'community.postgresql',
  'ansible.utils',
] as const;

export interface RawAnsibleDocEntry {
  readonly doc?: Record<string, unknown>;
  readonly return?: Record<string, unknown>;
}

export interface AnsibleDocDump {
  readonly all?: {
    readonly module?: Record<string, RawAnsibleDocEntry>;
  };
}

export interface BuildPackOptions {
  readonly collections: readonly string[];
  readonly outDir: string;
  readonly ansibleCoreVersion?: string;
  readonly collectionVersions?: Readonly<Record<string, string>>;
  readonly generatedAt?: string;
}

const VALID_OPTION_TYPES = new Set<ModuleOptionType>([
  'str',
  'int',
  'float',
  'bool',
  'list',
  'dict',
  'path',
  'raw',
  'jsonarg',
  'sid',
  'bits',
  'bytes',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeType(raw: unknown): ModuleOptionType {
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase();
    if (lower === 'string') return 'str';
    if (lower === 'integer') return 'int';
    if (lower === 'boolean') return 'bool';
    if (lower === 'array') return 'list';
    if (lower === 'hash' || lower === 'map') return 'dict';
    if (VALID_OPTION_TYPES.has(lower as ModuleOptionType)) {
      return lower as ModuleOptionType;
    }
  }
  return 'str';
}

function normalizeDescription(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is string => typeof item === 'string')
      .map((s) => s.trim())
      .join(' ');
  }
  return '';
}

function transformOptions(rawOptions: unknown): Record<string, ModuleOptionSpec> {
  if (!isRecord(rawOptions)) {
    return {};
  }
  const result: Record<string, ModuleOptionSpec> = {};
  for (const name of Object.keys(rawOptions).sort()) {
    const rawSpec = rawOptions[name];
    if (!isRecord(rawSpec)) {
      continue;
    }
    const type = normalizeType(rawSpec['type']);
    const elements =
      rawSpec['elements'] !== undefined ? normalizeType(rawSpec['elements']) : undefined;
    const required = typeof rawSpec['required'] === 'boolean' ? rawSpec['required'] : undefined;
    const hasDefault =
      Object.prototype.hasOwnProperty.call(rawSpec, 'default') && rawSpec['default'] !== undefined;
    const choices = Array.isArray(rawSpec['choices'])
      ? rawSpec['choices'].filter(
          (c): c is string | number | boolean =>
            typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean',
        )
      : undefined;
    const aliases = Array.isArray(rawSpec['aliases'])
      ? rawSpec['aliases'].filter((a): a is string => typeof a === 'string')
      : undefined;
    const versionAdded =
      typeof rawSpec['version_added'] === 'string' ? rawSpec['version_added'] : undefined;
    const suboptions = isRecord(rawSpec['suboptions'])
      ? transformOptions(rawSpec['suboptions'])
      : undefined;

    result[name] = {
      name,
      type,
      ...(elements !== undefined ? { elements } : {}),
      ...(required !== undefined ? { required } : {}),
      ...(hasDefault ? { default: rawSpec['default'] } : {}),
      ...(choices !== undefined && choices.length > 0 ? { choices } : {}),
      ...(aliases !== undefined && aliases.length > 0 ? { aliases } : {}),
      description: normalizeDescription(rawSpec['description']),
      ...(versionAdded !== undefined ? { versionAdded } : {}),
      ...(suboptions !== undefined && Object.keys(suboptions).length > 0 ? { suboptions } : {}),
    };
  }
  return result;
}

function transformReturnFields(rawReturn: unknown): Record<string, ModuleReturnFieldSpec> {
  if (!isRecord(rawReturn)) {
    return {};
  }
  const result: Record<string, ModuleReturnFieldSpec> = {};
  for (const name of Object.keys(rawReturn).sort()) {
    const rawSpec = rawReturn[name];
    if (!isRecord(rawSpec)) {
      continue;
    }
    const type = normalizeType(rawSpec['type']);
    const returned = typeof rawSpec['returned'] === 'string' ? rawSpec['returned'] : 'always';
    const hasSample =
      Object.prototype.hasOwnProperty.call(rawSpec, 'sample') && rawSpec['sample'] !== undefined;
    const contains = isRecord(rawSpec['contains'])
      ? transformReturnFields(rawSpec['contains'])
      : undefined;

    result[name] = {
      name,
      type,
      returned,
      description: normalizeDescription(rawSpec['description']),
      ...(hasSample ? { sample: rawSpec['sample'] } : {}),
      ...(contains !== undefined && Object.keys(contains).length > 0 ? { contains } : {}),
    };
  }
  return result;
}

function transformDeprecation(rawDoc: Record<string, unknown>): ModuleDeprecationInfo | undefined {
  const rawDeprecated = rawDoc['deprecated'];
  if (!isRecord(rawDeprecated)) {
    return undefined;
  }
  const why =
    typeof rawDeprecated['why'] === 'string' ? rawDeprecated['why'] : 'This module is deprecated.';
  const removedIn =
    typeof rawDeprecated['removed_in'] === 'string'
      ? rawDeprecated['removed_in']
      : typeof rawDeprecated['removed_at_date'] === 'string'
        ? rawDeprecated['removed_at_date']
        : undefined;
  const alternative =
    typeof rawDeprecated['alternative'] === 'string' ? rawDeprecated['alternative'] : undefined;

  return {
    why,
    ...(removedIn !== undefined ? { removedIn } : {}),
    ...(alternative !== undefined ? { alternative } : {}),
  };
}

function buildDocUrl(collection: string, shortName: string): string {
  const parts = collection.split('.');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return `https://docs.ansible.com/ansible/latest/collections/${parts[0]}/${parts[1]}/${shortName}_module.html`;
  }
  return `https://docs.ansible.com/ansible/latest/collections/${collection.replace(/\./g, '/')}/${shortName}_module.html`;
}

/**
 * Converts a single raw `ansible-doc --metadata-dump` entry into a compact `ModuleMetadataSpec`.
 */
export function transformRawModuleEntry(
  fqcn: string,
  entry: RawAnsibleDocEntry,
): ModuleMetadataSpec | undefined {
  const doc = entry.doc;
  if (!isRecord(doc)) {
    return undefined;
  }
  const parts = fqcn.split('.');
  const collection =
    typeof doc['collection'] === 'string' ? doc['collection'] : parts.slice(0, 2).join('.');
  const shortName =
    typeof doc['module'] === 'string' ? doc['module'] : (parts[parts.length - 1] ?? fqcn);
  const shortDescription = normalizeDescription(doc['short_description']);
  const description = normalizeDescription(doc['description']) || shortDescription;
  const deprecated = transformDeprecation(doc);

  return {
    fqcn,
    shortName,
    collection,
    shortDescription,
    description,
    docUrl: buildDocUrl(collection, shortName),
    ...(deprecated !== undefined ? { deprecated } : {}),
    options: transformOptions(doc['options']),
    returnFields: transformReturnFields(entry.return),
  };
}

/**
 * Transforms an `ansible-doc --metadata-dump` payload into deterministic `CollectionMetadataPack`
 * objects grouped by the requested collection names (or all discovered collections if `collections` is empty/omitted).
 */
export function buildPacksFromMetadataDump(
  dump: AnsibleDocDump,
  options: {
    readonly collections?: readonly string[];
    readonly ansibleCoreVersion?: string;
    readonly collectionVersions?: Readonly<Record<string, string>>;
    readonly generatedAt?: string;
  } = {},
): ReadonlyMap<string, CollectionMetadataPack> {
  const rawModules = dump.all?.module ?? {};
  const allowAll = !options.collections || options.collections.length === 0;
  const grouped = new Map<string, Record<string, ModuleMetadataSpec>>();
  if (options.collections) {
    for (const col of options.collections) {
      grouped.set(col, {});
    }
  }

  for (const fqcn of Object.keys(rawModules).sort()) {
    const rawEntry = rawModules[fqcn];
    if (!rawEntry) {
      continue;
    }
    const spec = transformRawModuleEntry(fqcn, rawEntry);
    if (!spec) {
      continue;
    }
    let bucket = grouped.get(spec.collection);
    if (!bucket) {
      if (!allowAll) {
        continue;
      }
      bucket = {};
      grouped.set(spec.collection, bucket);
    }
    bucket[spec.fqcn] = spec;
  }

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const packs = new Map<string, CollectionMetadataPack>();
  const targetCollections = allowAll ? Array.from(grouped.keys()).sort() : options.collections!;

  for (const col of targetCollections) {
    const modules = grouped.get(col) ?? {};
    if (Object.keys(modules).length === 0) {
      continue;
    }
    const version =
      options.collectionVersions?.[col] ??
      (col === 'ansible.builtin' ? (options.ansibleCoreVersion ?? '2.16.3') : 'latest');

    packs.set(col, {
      schemaVersion: 1,
      collection: col,
      version,
      generatedAt,
      modules,
    });
  }

  return packs;
}

/**
 * Compresses each `CollectionMetadataPack` to `<collection>.json.gz` and writes a SHA-256
 * `manifest.json` inside `outDir`.
 */
export function writeCompressedPacksAndManifest(
  packs: ReadonlyMap<string, CollectionMetadataPack>,
  outDir: string,
  ansibleCoreVersion: string,
  generatedAt?: string,
): MetadataManifest {
  fs.mkdirSync(outDir, { recursive: true });
  const collectionsManifest: Record<string, CollectionPackManifestEntry> = {};

  for (const [col, pack] of packs.entries()) {
    const fileName = `${col}.json.gz`;
    const filePath = path.join(outDir, fileName);
    const jsonBuffer = Buffer.from(JSON.stringify(pack), 'utf8');
    const gzBuffer = zlib.gzipSync(jsonBuffer, { level: 9 });
    fs.writeFileSync(filePath, gzBuffer);

    collectionsManifest[col] = {
      collection: col,
      version: pack.version,
      fileName,
      sha256: computeSha256(gzBuffer),
      sizeBytes: gzBuffer.byteLength,
      moduleCount: Object.keys(pack.modules).length,
    };
  }

  const manifest: MetadataManifest = {
    schemaVersion: 1,
    generatedAt: generatedAt ?? new Date().toISOString(),
    ansibleCoreVersion,
    collections: collectionsManifest,
  };

  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
  return manifest;
}

/**
 * Invokes `ansible-doc` on Linux to detect the installed `ansible-core` version.
 */
export function detectAnsibleCoreVersion(): string {
  try {
    const output = execFileSync('ansible-doc', ['--version'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const match = /\[core\s+([^\]]+)\]/.exec(output);
    return match?.[1] ?? '2.16.3';
  } catch (err) {
    void err;
    return '2.16.3';
  }
}

/**
 * Invokes `ansible-galaxy collection list --format json` to discover exact semantic versions
 * for all installed collections.
 */
export function detectInstalledCollectionVersions(): Readonly<Record<string, string>> {
  const versions: Record<string, string> = {};
  try {
    const stdout = execFileSync('ansible-galaxy', ['collection', 'list', '--format', 'json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (isRecord(parsed)) {
      for (const pathEntries of Object.values(parsed)) {
        if (isRecord(pathEntries)) {
          for (const [colName, colMeta] of Object.entries(pathEntries)) {
            if (isRecord(colMeta) && typeof colMeta['version'] === 'string') {
              versions[colName] = colMeta['version'];
            }
          }
        }
      }
    }
  } catch (err) {
    void err;
  }
  return versions;
}

/**
 * Invokes `ansible-doc -t module --metadata-dump --no-fail-on-errors` either for a single
 * collection filter or across all installed collections when `collectionFilter` is omitted.
 */
export function runAnsibleDocMetadataDump(collectionFilter?: string): AnsibleDocDump {
  const cmdArgs = ['-t', 'module', '--metadata-dump', '--no-fail-on-errors'];
  if (collectionFilter !== undefined && collectionFilter.length > 0) {
    cmdArgs.push(collectionFilter);
  }
  const stdout = execFileSync('ansible-doc', cmdArgs, {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: {
      ...process.env,
      ANSIBLE_DEPRECATION_WARNINGS: 'False',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout) as AnsibleDocDump;
}

/**
 * CLI entrypoint: generates compressed `.json.gz` packs and `manifest.json`.
 * Supports `--all` / `--all-installed` (all collections in the `ansible` community package),
 * `--all-top` (builtin + Top 10), and `--collection <name>`.
 */
export function runMetadataBuilderCli(args: readonly string[]): MetadataManifest {
  let outDir = path.resolve(process.cwd(), 'packages/core/data');
  const requestedCollections: string[] = [];
  let dumpAllInstalled = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--out-dir' && args[i + 1]) {
      outDir = path.resolve(args[i + 1]!);
      i += 1;
    } else if (arg === '--collection' && args[i + 1]) {
      requestedCollections.push(args[i + 1]!);
      i += 1;
    } else if (arg === '--all-top') {
      requestedCollections.push(...TOP_COLLECTIONS);
    } else if (arg === '--all' || arg === '--all-installed') {
      dumpAllInstalled = true;
    }
  }

  const coreVersion = detectAnsibleCoreVersion();
  const collectionVersions = detectInstalledCollectionVersions();
  const generatedAt = new Date().toISOString();

  if (dumpAllInstalled) {
    const fullDump = runAnsibleDocMetadataDump();
    const allPacks = buildPacksFromMetadataDump(fullDump, {
      ansibleCoreVersion: coreVersion,
      collectionVersions,
      generatedAt,
    });
    return writeCompressedPacksAndManifest(allPacks, outDir, coreVersion, generatedAt);
  }

  const collections = requestedCollections.length > 0 ? requestedCollections : ['ansible.builtin'];
  const mergedPacks = new Map<string, CollectionMetadataPack>();

  for (const col of collections) {
    const dump = runAnsibleDocMetadataDump(col);
    const colPacks = buildPacksFromMetadataDump(dump, {
      collections: [col],
      ansibleCoreVersion: coreVersion,
      collectionVersions,
      generatedAt,
    });
    for (const [k, v] of colPacks.entries()) {
      mergedPacks.set(k, v);
    }
  }

  return writeCompressedPacksAndManifest(mergedPacks, outDir, coreVersion, generatedAt);
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  const manifest = runMetadataBuilderCli(process.argv.slice(2));
  process.stdout.write(
    `Generated ${Object.keys(manifest.collections).length} pack(s) for ansible-core ${manifest.ansibleCoreVersion}\n`,
  );
}
