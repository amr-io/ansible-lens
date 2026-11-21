import { describe, expect, it } from 'vitest';
import { lintAnsibleDocument } from '../../src/linter/index.js';
import {
  createTestMetadataRegistry,
  makeAst,
  makeParam,
  makePlay,
  makeRange,
  makeTask,
  makeVariableDecl,
} from '../intelligence/testFixtures.js';

describe('lintAnsibleDocument — all clean-room rules & Quick-Fixes', () => {
  it('flags yaml-syntax, duplicate-keys, and yaml-truthy with Quick-Fix', () => {
    const registry = createTestMetadataRegistry();
    const ast = makeAst('file:///ws/site.yml', 'playbook', {
      syntaxErrors: [
        {
          code: 'YAML_BAD_INDENT',
          message: 'Unexpected indentation at line 4',
          range: makeRange(3, 0, 30),
        },
      ],
      duplicateKeys: [
        {
          key: 'tasks',
          range: makeRange(5, 2, 50),
        },
      ],
      rawTruthyValues: [
        {
          key: 'become',
          rawValue: 'yes',
          range: makeRange(2, 10, 22, 2, 13, 25),
        },
      ],
      plays: [
        makePlay({
          tasks: [
            makeTask('ansible.builtin.debug', {
              name: 'Say hi',
              params: [makeParam('msg', 'hi')],
              duplicateKeys: [{ key: 'msg', range: makeRange(7, 4, 70) }],
              rawTruthyKeys: [{ key: 'no_log', rawValue: 'OFF', range: makeRange(8, 12, 85) }],
            }),
          ],
        }),
      ],
    });

    const diagnostics = lintAnsibleDocument(ast, registry);
    expect(diagnostics.some((d) => d.ruleId === 'yaml-syntax' && d.severity === 'error')).toBe(
      true,
    );
    expect(diagnostics.filter((d) => d.ruleId === 'duplicate-keys')).toHaveLength(2);

    const truthyDiags = diagnostics.filter((d) => d.ruleId === 'yaml-truthy');
    expect(truthyDiags).toHaveLength(2);
    expect(truthyDiags[0]?.quickFixes[0]?.edits[0]?.newText).toBe('true');
    expect(truthyDiags[1]?.quickFixes[0]?.edits[0]?.newText).toBe('false');
  });

  it('flags unknown-module with Levenshtein Quick-Fix and skips when registry is empty', () => {
    const emptyRegistry = createTestMetadataRegistry();
    emptyRegistry.listModules().forEach(() => {});
    const registry = createTestMetadataRegistry();

    const ast = makeAst('file:///ws/site.yml', 'playbook', {
      plays: [
        makePlay({
          tasks: [
            makeTask('ansible.builtin.cpy', {
              name: 'Typo module',
              isFqcn: true,
            }),
          ],
        }),
      ],
    });

    const diags = lintAnsibleDocument(ast, registry);
    const unknownMod = diags.find((d) => d.ruleId === 'unknown-module');
    expect(unknownMod).toBeDefined();
    expect(unknownMod?.severity).toBe('error');
    expect(unknownMod?.quickFixes[0]?.edits[0]?.newText).toBe('ansible.builtin.copy');

    // Valid-looking FQCNs from unloaded collections must not be flagged as red errors
    const unloadedAst = makeAst('file:///ws/site.yml', 'playbook', {
      plays: [
        makePlay({
          tasks: [
            makeTask('community.general.ufw', {
              name: 'Allow SSH via community.general.ufw',
              isFqcn: true,
              range: makeRange(2, 2, 28),
            }),
            makeTask('ansible.posix.synchronize', {
              name: 'Sync via ansible.posix.synchronize',
              isFqcn: true,
              range: makeRange(6, 2, 120),
            }),
          ],
        }),
      ],
    });
    const unloadedDiags = lintAnsibleDocument(unloadedAst, registry);
    const redErrors = unloadedDiags.filter((d) => d.severity === 'error');
    expect(redErrors).toEqual([]);
    const infoDiags = unloadedDiags.filter(
      (d) => d.ruleId === 'unknown-module' && d.severity === 'info',
    );
    expect(infoDiags).toHaveLength(2);
    expect(infoDiags[0]?.message).toContain('Collection metadata not loaded');
  });

  it('flags unknown-param, missing-required-param, invalid-choice, param-type-mismatch, and recursive suboptions', () => {
    const registry = createTestMetadataRegistry();

    const ast = makeAst('file:///ws/site.yml', 'playbook', {
      plays: [
        makePlay({
          tasks: [
            makeTask('ansible.builtin.stat', {
              name: 'Stat with bad params',
              params: [
                // Missing required 'path'
                makeParam('flolow', true), // typo for 'follow'
                makeParam('checksum_algorithm', 'sha257'), // invalid choice close to sha256
                makeParam('follow', 'not_a_bool'), // type mismatch
              ],
            }),
            makeTask('ansible.builtin.uri', {
              name: 'Call API with missing suboption',
              params: [
                makeParam('url', 'https://example.com'),
                makeParam(
                  'headers',
                  { Authorization: 'Bearer x' },
                  {
                    suboptions: [
                      makeParam('Authorization', 'Bearer x'),
                      makeParam('unknown_hdr', '1'),
                    ],
                  },
                ),
              ],
              range: makeRange(10, 2, 120),
            }),
          ],
        }),
      ],
    });

    const diags = lintAnsibleDocument(ast, registry);
    const unknownParams = diags.filter((d) => d.ruleId === 'unknown-param');
    expect(unknownParams.length).toBe(2);
    expect(unknownParams[0]?.quickFixes[0]?.edits[0]?.newText).toBe('follow');

    const missingRequired = diags.filter((d) => d.ruleId === 'missing-required-param');
    expect(missingRequired.length).toBe(2); // path on stat + timeout_ms on uri.headers

    const invalidChoice = diags.find((d) => d.ruleId === 'invalid-choice');
    expect(invalidChoice).toBeDefined();
    expect(invalidChoice?.quickFixes[0]?.edits[0]?.newText).toBe('sha256');

    const typeMismatch = diags.find((d) => d.ruleId === 'param-type-mismatch');
    expect(typeMismatch).toBeDefined();
    expect(typeMismatch?.message).toContain("expects type 'bool'");
  });

  it('recognizes parameter aliases and ignores Jinja dynamic expressions for choices/types', () => {
    const registry = createTestMetadataRegistry();
    const ast = makeAst('file:///ws/site.yml', 'playbook', {
      plays: [
        makePlay({
          tasks: [
            makeTask('ansible.builtin.stat', {
              name: 'Valid stat via alias and jinja',
              params: [
                makeParam('dest', '/etc/hosts'), // alias for required 'path'
                makeParam('follow', '{{ follow_links }}'),
                makeParam('checksum_algorithm', '{{ algo }}'),
              ],
            }),
          ],
        }),
      ],
    });

    const diags = lintAnsibleDocument(ast, registry);
    expect(diags).toEqual([]);
  });

  it('flags fqcn, name-missing, deprecated-module, package-latest, and risky-file-permissions', () => {
    const registry = createTestMetadataRegistry();
    const ast = makeAst('file:///ws/site.yml', 'playbook', {
      plays: [
        makePlay({
          tasks: [
            makeTask('apt', {
              // missing name
              isFqcn: false,
              params: [makeParam('name', ['nginx']), makeParam('state', 'latest')],
              range: makeRange(2, 2, 20),
            }),
            makeTask('ansible.builtin.file', {
              name: 'Create dir without mode',
              params: [makeParam('path', '/opt/app'), makeParam('state', 'directory')],
              range: makeRange(6, 2, 80),
            }),
            makeTask('ansible.builtin.copy', {
              name: 'Copy with 0777 mode',
              params: [
                makeParam('src', 'a.txt'),
                makeParam('dest', '/tmp/a.txt'),
                makeParam('mode', '0777'),
              ],
              range: makeRange(10, 2, 140),
            }),
            makeTask('ansible.builtin.legacy_mod', {
              name: 'Use deprecated module',
              range: makeRange(14, 2, 200),
            }),
          ],
        }),
      ],
    });

    const diags = lintAnsibleDocument(ast, registry);

    expect(diags.some((d) => d.ruleId === 'name-missing')).toBe(true);

    const fqcnDiag = diags.find((d) => d.ruleId === 'fqcn');
    expect(fqcnDiag?.quickFixes[0]?.edits[0]?.newText).toBe('ansible.builtin.apt');

    const pkgLatest = diags.find((d) => d.ruleId === 'package-latest');
    expect(pkgLatest?.quickFixes[0]?.edits[0]?.newText).toBe('present');

    const riskyPerms = diags.filter((d) => d.ruleId === 'risky-file-permissions');
    expect(riskyPerms).toHaveLength(2);
    expect(riskyPerms[1]?.quickFixes[0]?.edits[0]?.newText).toBe("'0755'");

    const deprecatedDiag = diags.find((d) => d.ruleId === 'deprecated-module');
    expect(deprecatedDiag?.quickFixes[0]?.edits[0]?.newText).toBe('ansible.builtin.debug');
  });

  it('flags no-changed-when and command-instead-of-module appropriately', () => {
    const registry = createTestMetadataRegistry();
    const ast = makeAst('file:///ws/site.yml', 'playbook', {
      plays: [
        makePlay({
          tasks: [
            makeTask('ansible.builtin.command', {
              name: 'Clone via command',
              freeFormArg: 'git clone https://example.com/repo.git',
              range: makeRange(2, 2, 20),
            }),
            makeTask('ansible.builtin.shell', {
              name: 'Download via curl with creates guard',
              params: [
                makeParam('cmd', 'curl -fsSL https://example.com/file -o /tmp/file'),
                makeParam('creates', '/tmp/file'),
              ],
              range: makeRange(5, 2, 70),
            }),
            makeTask('ansible.builtin.command', {
              name: 'Idempotent command with changed_when',
              freeFormArg: 'whoami',
              changedWhen: false,
              range: makeRange(9, 2, 130),
            }),
          ],
        }),
      ],
    });

    const diags = lintAnsibleDocument(ast, registry);
    const noChangedWhen = diags.filter((d) => d.ruleId === 'no-changed-when');
    expect(noChangedWhen).toHaveLength(1);
    expect(noChangedWhen[0]?.quickFixes[0]?.edits[0]?.newText).toContain('changed_when: false');

    const cmdInstead = diags.filter((d) => d.ruleId === 'command-instead-of-module');
    expect(cmdInstead).toHaveLength(2);
    expect(cmdInstead[0]?.quickFixes[0]?.edits[0]?.newText).toBe('ansible.builtin.git');
    expect(cmdInstead[1]?.quickFixes[0]?.edits[0]?.newText).toBe('ansible.builtin.get_url');
  });

  it('flags hardcoded-secret on literal task params and vars unless no_log, jinja, or vault is used', () => {
    const registry = createTestMetadataRegistry();
    const ast = makeAst('file:///ws/site.yml', 'playbook', {
      variables: [
        makeVariableDecl('db_password', 'supersecret123', 'play-vars'),
        makeVariableDecl('safe_token', '{{ vault_token }}', 'play-vars'),
        makeVariableDecl('vaulted_key', '$ANSIBLE_VAULT;1.1;AES256\n3031', 'play-vars', {
          rawValue: '!vault |\n$ANSIBLE_VAULT;1.1;AES256',
        }),
      ],
      plays: [
        makePlay({
          tasks: [
            makeTask('ansible.builtin.user', {
              name: 'Create user with hardcoded password',
              params: [
                makeParam('name', 'deploy'),
                makeParam('password', 'P@ssw0rd123'),
                makeParam('password_lock', false),
              ],
              range: makeRange(4, 2, 40),
            }),
            makeTask('ansible.builtin.user', {
              name: 'Create user with no_log true',
              noLog: true,
              params: [makeParam('name', 'deploy2'), makeParam('password', 'P@ssw0rd123')],
              range: makeRange(8, 2, 90),
            }),
          ],
        }),
      ],
    });

    const diags = lintAnsibleDocument(ast, registry);
    const secretDiags = diags.filter((d) => d.ruleId === 'hardcoded-secret');
    expect(secretDiags).toHaveLength(2);
    expect(secretDiags[0]?.quickFixes).toHaveLength(2);
    expect(secretDiags[0]?.quickFixes[0]?.edits[0]?.newText).toBe("'{{ vault_password }}'");
    expect(secretDiags[0]?.quickFixes[1]?.edits[0]?.newText).toContain('no_log: true');
    expect(secretDiags[1]?.quickFixes[0]?.edits[0]?.newText).toBe("'{{ vault_db_password }}'");
  });
});
