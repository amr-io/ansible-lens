import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TOP_COLLECTIONS,
  buildPacksFromMetadataDump,
  transformRawModuleEntry,
  writeCompressedPacksAndManifest,
} from '../src/index.js';
import type { AnsibleDocDump } from '../src/index.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ansible-lens-builder-'));
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

describe('scripts/metadata-builder', () => {
  it('includes ansible.builtin and Top 10 Galaxy collections', () => {
    expect(TOP_COLLECTIONS).toContain('ansible.builtin');
    expect(TOP_COLLECTIONS).toContain('ansible.posix');
    expect(TOP_COLLECTIONS).toContain('community.general');
    expect(TOP_COLLECTIONS).toHaveLength(11);
  });

  it('transforms raw ansible-doc dump entries and writes deterministic .json.gz + manifest.json', () => {
    const sampleDump: AnsibleDocDump = {
      all: {
        module: {
          'ansible.builtin.copy': {
            doc: {
              collection: 'ansible.builtin',
              module: 'copy',
              short_description: 'Copy files to remote locations',
              description: ['Line 1.', 'Line 2.'],
              options: {
                dest: {
                  type: 'path',
                  required: true,
                  description: ['Remote destination path.'],
                },
                force: {
                  type: 'bool',
                  default: true,
                  aliases: ['thirsty'],
                  description: 'Overwrite existing files.',
                },
              },
            },
            return: {
              dest: {
                type: 'str',
                returned: 'success',
                description: 'Destination file path.',
                sample: '/etc/foo.conf',
              },
            },
          },
          'community.general.ufw': {
            doc: {
              collection: 'community.general',
              module: 'ufw',
              short_description: 'Manage firewall with UFW',
              deprecated: {
                why: 'Test deprecation',
                removed_in: '10.0.0',
                alternative: 'ansible.posix.firewalld',
              },
              options: {},
            },
          },
        },
      },
    };

    const single = transformRawModuleEntry(
      'ansible.builtin.copy',
      sampleDump.all!.module!['ansible.builtin.copy']!,
    );
    expect(single?.options['dest']?.required).toBe(true);
    expect(single?.returnFields['dest']?.sample).toBe('/etc/foo.conf');

    const packs = buildPacksFromMetadataDump(sampleDump, {
      collections: ['ansible.builtin', 'community.general', 'amazon.aws'],
      ansibleCoreVersion: '2.16.3',
      generatedAt: '2026-11-20T00:00:00Z',
    });

    expect(packs.size).toBe(2);
    expect(
      packs.get('community.general')?.modules['community.general.ufw']?.deprecated?.removedIn,
    ).toBe('10.0.0');

    const outDir = createTempDir();
    const manifest = writeCompressedPacksAndManifest(
      packs,
      outDir,
      '2.16.3',
      '2026-11-20T00:00:00Z',
    );

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.collections['ansible.builtin']?.moduleCount).toBe(1);
    expect(manifest.collections['ansible.builtin']?.sha256).toMatch(/^[a-f0-9]{64}$/);

    const gzPath = path.join(outDir, 'ansible.builtin.json.gz');
    expect(fs.existsSync(gzPath)).toBe(true);
    const unzipped = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf8')) as {
      collection: string;
    };
    expect(unzipped.collection).toBe('ansible.builtin');
  });
});
