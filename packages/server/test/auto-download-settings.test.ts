import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  computeSha256,
  type CollectionMetadataPack,
  type IMetadataFetcher,
  type MetadataManifest,
} from '@ansible-lens/core';
import {
  AnsibleLanguageService,
  IGNORED_WORKSPACE_DIRECTORIES,
  MemoryWorkspaceFs,
  fsPathToUri,
} from '../src/index.js';

describe('Silent collection auto-download, live settings, diagnostics info, and workspace ignores', () => {
  it('lazily auto-downloads an unloaded collection pack with SHA-256 verification and clears the Info diagnostic', async () => {
    const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'ansible-lens-autodownload-'));
    try {
      const posixPack: CollectionMetadataPack = {
        schemaVersion: 1,
        collection: 'ansible.posix',
        version: '1.5.4',
        generatedAt: '2026-11-20T00:00:00Z',
        modules: {
          'ansible.posix.sysctl': {
            fqcn: 'ansible.posix.sysctl',
            shortName: 'sysctl',
            collection: 'ansible.posix',
            shortDescription: 'Manage entries in sysctl.conf',
            description: 'Manage sysctl kernel parameters.',
            docUrl:
              'https://docs.ansible.com/ansible/latest/collections/ansible/posix/sysctl_module.html',
            options: {
              name: {
                name: 'name',
                type: 'str',
                required: true,
                description: 'The dot-separated path (key) specifying the sysctl variable.',
              },
              value: {
                name: 'value',
                type: 'str',
                description: 'Desired value of the sysctl key.',
              },
            },
            returnFields: {},
          },
        },
      };

      const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(posixPack), 'utf8'));
      const sha256 = computeSha256(compressed);
      const manifest: MetadataManifest = {
        schemaVersion: 1,
        generatedAt: '2026-11-20T00:00:00Z',
        ansibleCoreVersion: '2.16.3',
        collections: {
          'ansible.posix': {
            collection: 'ansible.posix',
            version: '1.5.4',
            fileName: 'ansible.posix.json.gz',
            sha256,
            sizeBytes: compressed.byteLength,
            moduleCount: 1,
          },
        },
      };

      const mockFetcher: IMetadataFetcher = {
        fetchText: async () => JSON.stringify(manifest),
        fetchBytes: async () => new Uint8Array(compressed),
      };

      const service = new AnsibleLanguageService({
        cacheDir: tmpCache,
        fetcher: mockFetcher,
        workspaceRoots: ['/repo'],
        fs: new MemoryWorkspaceFs({
          '/repo/ansible.cfg': '[defaults]\nroles_path = roles\n',
        }),
      });

      const playUri = fsPathToUri('/repo/site.yml');
      const playText = [
        '---',
        '- name: Configure kernel parameters',
        '  hosts: all',
        '  tasks:',
        '    - name: Enable IPv4 forwarding',
        '      ansible.posix.sysctl:',
        '        name: net.ipv4.ip_forward',
        '        value: "1"',
      ].join('\n');

      // Before download: unloaded collection emits an 'info' diagnostic (severity 3)
      const beforeDiags = service.getDiagnostics(playUri, playText);
      expect(
        beforeDiags.some(
          (d) =>
            d.code === 'unknown-module' &&
            d.severity === 3 &&
            d.message.includes("Collection metadata not loaded for 'ansible.posix'"),
        ),
      ).toBe(true);

      const unloaded = service.findUnloadedCollectionsInDocument(playUri, playText);
      expect(unloaded).toEqual(['ansible.posix']);

      // Trigger background download
      const loaded = await service.downloadCollections(unloaded);
      expect(loaded).toEqual(['ansible.posix']);
      expect(service.getRegistry().getModule('ansible.posix.sysctl')).toBeDefined();

      // After download: the Info hint disappears automatically
      const afterDiags = service.getDiagnostics(playUri, playText);
      expect(afterDiags).toEqual([]);
    } finally {
      fs.rmSync(tmpCache, { recursive: true, force: true });
    }
  });

  it('applies live settings updates (lint.enabled, lint.profile, lint.rules, lint.extraVars, ansible.rootPaths) and returns diagnostics info', () => {
    const fsMem = new MemoryWorkspaceFs({
      '/repo/sub/ansible/playbooks/site.yml': [
        '---',
        '- name: Play',
        '  hosts: all',
        '  tasks:',
        '    - name: Print runtime extra var',
        '      ansible.builtin.debug:',
        '        msg: "{{ runtime_ci_var }}"',
      ].join('\n'),
      '/repo/node_modules/pkg/playbook.yml': '---\n- hosts: all\n',
      '/repo/.venv/lib/site.yml': '---\n- hosts: all\n',
      '/repo/__pycache__/cached.yml': '---\n- hosts: all\n',
      '/repo/.git/hooks/test.yml': '---\n- hosts: all\n',
      '/repo/dist/out.yml': '---\n- hosts: all\n',
    });

    for (const dir of ['node_modules', '.git', '.venv', '__pycache__', 'dist']) {
      expect(IGNORED_WORKSPACE_DIRECTORIES.has(dir)).toBe(true);
    }
    const listed = fsMem.listFiles('/repo');
    expect(listed).toEqual(['/repo/sub/ansible/playbooks/site.yml']);

    const service = new AnsibleLanguageService({
      fs: fsMem,
      workspaceRoots: ['/repo'],
    });
    service.indexWorkspace();

    const siteUri = fsPathToUri('/repo/sub/ansible/playbooks/site.yml');
    const siteText = fsMem.readFile('/repo/sub/ansible/playbooks/site.yml')!;

    // Initially runtime_ci_var is flagged as undefined-variable
    expect(
      service.getDiagnostics(siteUri, siteText).some((d) => d.code === 'undefined-variable'),
    ).toBe(true);

    // Apply live settings: add runtime_ci_var to extraVars and configure ansibleRootPaths
    service.applySettings({
      lint: {
        enabled: true,
        profile: 'production',
        extraVars: ['runtime_ci_var'],
        rules: { fqcn: 'off' },
      },
      metadata: {
        autoDownload: false,
        manifestUrl: 'https://mirror.example.com/manifest.json',
      },
      ansibleRootPaths: ['sub/ansible'],
    });

    expect(service.isAutoDownloadEnabled()).toBe(false);
    expect(service.getManifestUrl()).toBe('https://mirror.example.com/manifest.json');
    expect(service.getDiagnostics(siteUri, siteText)).toEqual([]);

    const info = service.getDiagnosticsInfo(siteUri);
    expect(info.loadedCollections).toContain('ansible.builtin');
    expect(info.ansibleRootPaths).toEqual(['/repo/sub/ansible']);
    expect(info.indexedDocumentsCount).toBe(1);

    // Disabling lint returns empty diagnostics
    service.applySettings({ lint: { enabled: false } });
    expect(service.getDiagnostics(siteUri, siteText)).toEqual([]);
  });
});
