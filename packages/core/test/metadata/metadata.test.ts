import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CollectionMetadataPack, MetadataManifest } from '../../src/contracts/types.js';
import {
  MetadataPackLoader,
  MetadataRegistry,
  computeSha256,
  createDefaultMetadataRegistry,
  extractPythonModuleMetadata,
  validateCollectionPack,
  validateMetadataManifest,
} from '../../src/metadata/index.js';
import type { IMetadataFetcher } from '../../src/metadata/index.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ansible-lens-meta-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('Bundled ansible.builtin MetadataRegistry', () => {
  it('loads real bundled ansible.builtin.json.gz with core modules, options, and returnFields', () => {
    const registry = createDefaultMetadataRegistry();
    expect(registry.listCollections()).toContain('ansible.builtin');
    expect(registry.listModules().length).toBeGreaterThanOrEqual(50);

    const copyMod = registry.getModule('ansible.builtin.copy');
    expect(copyMod).toBeDefined();
    expect(copyMod?.shortName).toBe('copy');
    expect(copyMod?.options['dest']?.required).toBe(true);
    expect(copyMod?.options['src']?.type).toBe('path');

    const shortLookup = registry.getModule('stat');
    expect(shortLookup?.fqcn).toBe('ansible.builtin.stat');
    expect(shortLookup?.returnFields['stat']?.contains?.['exists']?.type).toBe('bool');
  });
});

describe('MetadataPackLoader SHA-256 verification & delta cache sync', () => {
  const samplePack: CollectionMetadataPack = {
    schemaVersion: 1,
    collection: 'community.general',
    version: '9.0.0',
    generatedAt: '2026-11-20T00:00:00Z',
    modules: {
      'community.general.ufw': {
        fqcn: 'community.general.ufw',
        shortName: 'ufw',
        collection: 'community.general',
        shortDescription: 'Manage firewall with UFW',
        description: 'Manage firewall with UFW.',
        docUrl:
          'https://docs.ansible.com/ansible/latest/collections/community/general/ufw_module.html',
        options: {
          state: {
            name: 'state',
            type: 'str',
            choices: ['enabled', 'disabled', 'reloaded', 'reset'],
            description: 'Desired firewall state.',
          },
        },
        returnFields: {},
      },
    },
  };

  it('verifies SHA-256 on compressed packs and rejects tampered payloads', () => {
    const dir = createTempDir();
    const loader = new MetadataPackLoader(dir);
    const gzBytes = zlib.gzipSync(Buffer.from(JSON.stringify(samplePack), 'utf8'));
    const validSha = computeSha256(gzBytes);

    const parsed = loader.parseCompressedPack(gzBytes, validSha);
    expect(parsed.collection).toBe('community.general');

    expect(() => loader.parseCompressedPack(gzBytes, 'deadbeef'.repeat(8))).toThrow(
      /SHA-256 mismatch/,
    );
  });

  it('downloads only uncached/changed packs during delta sync and skips cached valid packs', async () => {
    const dir = createTempDir();
    const gzBytes = zlib.gzipSync(Buffer.from(JSON.stringify(samplePack), 'utf8'));
    const sha256 = computeSha256(gzBytes);

    const manifest: MetadataManifest = {
      schemaVersion: 1,
      generatedAt: '2026-11-20T00:00:00Z',
      ansibleCoreVersion: '2.16.3',
      collections: {
        'community.general': {
          collection: 'community.general',
          version: '9.0.0',
          fileName: 'community.general.json.gz',
          sha256,
          sizeBytes: gzBytes.byteLength,
          moduleCount: 1,
        },
      },
    };

    let downloadCount = 0;
    const fetcher: IMetadataFetcher = {
      async fetchText() {
        return JSON.stringify(manifest);
      },
      async fetchBytes() {
        downloadCount += 1;
        return gzBytes;
      },
    };

    const loader = new MetadataPackLoader(dir, fetcher);

    // First sync: downloads community.general.json.gz
    const first = await loader.syncFromManifest('https://example.invalid/manifest.json', [
      'community.general',
      'missing.collection',
    ]);
    expect(downloadCount).toBe(1);
    expect(first.result.updatedCollections).toEqual(['community.general']);
    expect(first.result.skippedCollections).toEqual([]);
    expect(first.result.errors).toHaveLength(1);
    expect(first.packs.get('community.general')?.modules['community.general.ufw']?.shortName).toBe(
      'ufw',
    );

    // Second sync: SHA-256 already matches cached file -> skips network download
    const second = await loader.syncFromManifest('https://example.invalid/manifest.json', [
      'community.general',
    ]);
    expect(downloadCount).toBe(1);
    expect(second.result.updatedCollections).toEqual([]);
    expect(second.result.skippedCollections).toEqual(['community.general']);
  });

  it('rejects malformed pack and manifest schemas and handles loader error paths', async () => {
    expect(() => validateCollectionPack(null)).toThrow(/expected object/);
    expect(() => validateCollectionPack({ schemaVersion: 2 })).toThrow(/Unsupported/);
    expect(() => validateCollectionPack({ schemaVersion: 1, collection: '' })).toThrow(
      /collection/,
    );
    expect(() => validateCollectionPack({ schemaVersion: 1, collection: 'a.b' })).toThrow(
      /version/,
    );
    expect(() =>
      validateCollectionPack({ schemaVersion: 1, collection: 'a.b', version: '1.0' }),
    ).toThrow(/generatedAt/);
    expect(() =>
      validateCollectionPack({
        schemaVersion: 1,
        collection: 'a.b',
        version: '1.0',
        generatedAt: 'now',
      }),
    ).toThrow(/modules/);
    expect(() =>
      validateCollectionPack({
        schemaVersion: 1,
        collection: 'a.b',
        version: '1.0',
        generatedAt: 'now',
        modules: { bad: {} },
      }),
    ).toThrow(/Invalid module entry/);

    expect(() => validateMetadataManifest(null)).toThrow(/expected object/);
    expect(() => validateMetadataManifest({ schemaVersion: 2 })).toThrow(/Unsupported/);
    expect(() => validateMetadataManifest({ schemaVersion: 1 })).toThrow(/missing/);
    expect(() =>
      validateMetadataManifest({
        schemaVersion: 1,
        generatedAt: 'now',
        ansibleCoreVersion: '2.16.3',
      }),
    ).toThrow(/collections/);
    expect(() =>
      validateMetadataManifest({
        schemaVersion: 1,
        generatedAt: 'now',
        ansibleCoreVersion: '2.16.3',
        collections: { bad: {} },
      }),
    ).toThrow(/Invalid manifest collection entry/);

    const dir = createTempDir();
    const offlineLoader = new MetadataPackLoader(dir);
    await expect(
      offlineLoader.syncFromManifest('https://example.invalid/manifest.json'),
    ).rejects.toThrow(/without an IMetadataFetcher/);

    await expect(
      offlineLoader.ensureCollectionPack({
        collection: 'a.b',
        version: '1.0.0',
        fileName: 'a.b.json.gz',
        sha256: 'abc',
        sizeBytes: 10,
        moduleCount: 1,
      }),
    ).rejects.toThrow(/not cached/);

    const badFetcher: IMetadataFetcher = {
      async fetchText() {
        return JSON.stringify({
          schemaVersion: 1,
          generatedAt: 'now',
          ansibleCoreVersion: '2.16.3',
          collections: {
            'broken.col': {
              collection: 'broken.col',
              version: '1.0.0',
              fileName: 'broken.col.json.gz',
              sha256: '00'.repeat(32),
              sizeBytes: 10,
              moduleCount: 1,
            },
          },
        });
      },
      async fetchBytes() {
        return new Uint8Array([1, 2, 3]);
      },
    };
    const badSyncLoader = new MetadataPackLoader(dir, badFetcher);
    const syncRes = await badSyncLoader.syncFromManifest('https://example.invalid/manifest.json');
    expect(syncRes.result.errors).toHaveLength(1);
    expect(syncRes.result.errors[0]).toContain('SHA-256 mismatch');
  });

  it('registers multiple modules with same shortName and handles resolveFqcn', () => {
    const registry = new MetadataRegistry();
    expect(registry.getModule('unknown')).toBeUndefined();
    expect(registry.resolveFqcn('unknown')).toEqual([]);

    registry.registerModule({
      fqcn: 'community.general.copy',
      shortName: 'copy',
      collection: 'community.general',
      shortDescription: 'Custom',
      description: 'Custom',
      docUrl: 'https://example.com',
      options: {},
      returnFields: {},
    });
    expect(registry.getModule('copy')?.fqcn).toBe('community.general.copy');
    expect(registry.resolveFqcn('community.general.copy')).toHaveLength(1);

    registry.registerModule({
      fqcn: 'ansible.builtin.copy',
      shortName: 'copy',
      collection: 'ansible.builtin',
      shortDescription: 'Builtin',
      description: 'Builtin',
      docUrl: 'https://example.com',
      options: {},
      returnFields: {},
    });
    expect(registry.getModule('copy')?.fqcn).toBe('ansible.builtin.copy');
    expect(registry.resolveFqcn('copy')).toHaveLength(2);
  });
});

describe('Static Python DOCUMENTATION & RETURN extractor', () => {
  it('extracts module options, suboptions, deprecation, and RETURN fields without executing Python', () => {
    const pySource = `
#!/usr/bin/python
# -*- coding: utf-8 -*-

DOCUMENTATION = r'''
---
module: custom_deploy
short_description: Deploy custom service
description:
  - Deploys a custom service artifact.
  - Supports nested suboptions.
deprecated:
  why: Replaced by custom_deploy_v2
  removed_in: "3.0.0"
  alternative: custom.ops.custom_deploy_v2
options:
  name:
    description: Service name
    type: string
    required: true
    aliases:
      - service_name
  retries:
    description: Number of retries
    type: integer
    default: 3
  flags:
    description: Flags
    type: array
    elements: string
  extra:
    description: Extra dict
    type: hash
  tls:
    description: TLS settings
    type: dict
    suboptions:
      enabled:
        description: Enable TLS
        type: boolean
        default: true
      mode:
        description: TLS mode
        type: str
        version_added: "1.2.0"
        choices:
          - strict
          - permissive
'''

RETURN = r'''
endpoint:
  description: Deployed endpoint URL
  returned: always
  type: str
  sample: https://localhost:8443
details:
  description: Nested details
  returned: success
  type: dict
  contains:
    port:
      description: Listening port
      returned: always
      type: int
'''

def main():
    raise RuntimeError("Must never execute Python!")
`;

    const registry = new MetadataRegistry();
    const spec = registry.registerPythonModule(pySource, 'custom.ops.custom_deploy', 'custom.ops');

    expect(spec).toBeDefined();
    expect(spec?.fqcn).toBe('custom.ops.custom_deploy');
    expect(spec?.shortName).toBe('custom_deploy');
    expect(spec?.deprecated?.alternative).toBe('custom.ops.custom_deploy_v2');
    expect(spec?.options['name']?.type).toBe('str');
    expect(spec?.options['name']?.required).toBe(true);
    expect(spec?.options['name']?.aliases).toEqual(['service_name']);
    expect(spec?.options['retries']?.type).toBe('int');
    expect(spec?.options['flags']?.type).toBe('list');
    expect(spec?.options['flags']?.elements).toBe('str');
    expect(spec?.options['extra']?.type).toBe('dict');
    expect(spec?.options['tls']?.suboptions?.['enabled']?.type).toBe('bool');
    expect(spec?.options['tls']?.suboptions?.['mode']?.versionAdded).toBe('1.2.0');
    expect(spec?.options['tls']?.suboptions?.['mode']?.choices).toEqual(['strict', 'permissive']);
    expect(spec?.returnFields['endpoint']?.type).toBe('str');
    expect(spec?.returnFields['details']?.contains?.['port']?.type).toBe('int');
    expect(registry.getModule('custom_deploy')?.fqcn).toBe('custom.ops.custom_deploy');
  });

  it('handles double-quoted docstrings, unclosed docstrings, and invalid RETURN YAML gracefully', () => {
    const doubleQuoted = `
DOCUMENTATION = """
module: dq_mod
short_description: Double quoted
deprecated:
  removed_at_date: "2028-01-01"
"""
RETURN = """
: [unclosed
"""
`;
    const spec = extractPythonModuleMetadata(doubleQuoted, 'ns.col.dq_mod', 'ns.col');
    expect(spec?.shortName).toBe('dq_mod');
    expect(spec?.deprecated?.removedIn).toBe('2028-01-01');
    expect(spec?.returnFields).toEqual({});

    expect(extractPythonModuleMetadata('print("no docs")', 'a.b.c', 'a.b')).toBeUndefined();
    expect(
      extractPythonModuleMetadata("DOCUMENTATION = r'''\nunclosed", 'a.b.c', 'a.b'),
    ).toBeUndefined();
    expect(
      extractPythonModuleMetadata("DOCUMENTATION = r'''\n- just a list\n'''", 'a.b.c', 'a.b'),
    ).toBeUndefined();
    expect(
      extractPythonModuleMetadata("DOCUMENTATION = r'''\n: [broken\n'''", 'a.b.c', 'a.b'),
    ).toBeUndefined();
  });
});
