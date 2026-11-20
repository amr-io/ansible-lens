import { describe, expect, it } from 'vitest';
import {
  inferRegisteredVariables,
  resolveRegisteredFieldPath,
} from '../../src/intelligence/index.js';
import {
  createTestMetadataRegistry,
  makeAst,
  makeParam,
  makePlay,
  makeRange,
  makeTask,
} from './testFixtures.js';

describe('inferRegisteredVariables & resolveRegisteredFieldPath', () => {
  it('infers common and nested module return fields with docUrl anchors for non-loop tasks', () => {
    const registry = createTestMetadataRegistry();
    const statTask = makeTask('stat', {
      name: 'Check config file',
      isFqcn: false,
      register: 'cfg_stat',
      params: [makeParam('path', '/etc/app.conf')],
      range: makeRange(3, 4, 40, 5, 25, 80),
    });

    const ast = makeAst('file:///workspace/site.yml', 'playbook', {
      plays: [
        makePlay({
          hosts: 'all',
          tasks: [statTask],
        }),
      ],
    });

    const inferredMap = inferRegisteredVariables(ast, registry);
    expect(inferredMap.size).toBe(1);

    const cfgStat = inferredMap.get('cfg_stat');
    expect(cfgStat).toBeDefined();
    expect(cfgStat?.isLoop).toBe(false);
    expect(cfgStat?.moduleFqcn).toBe('ansible.builtin.stat');
    expect(cfgStat?.taskName).toBe('Check config file');

    expect(cfgStat?.fields['failed']?.type).toBe('bool');
    expect(cfgStat?.fields['changed']?.type).toBe('bool');
    expect(cfgStat?.fields['skipped']?.type).toBe('bool');
    expect(cfgStat?.fields['msg']?.type).toBe('str');
    expect(cfgStat?.fields['rc']?.type).toBe('int');
    expect(cfgStat?.fields['stdout']?.type).toBe('str');
    expect(cfgStat?.fields['stdout_lines']?.type).toBe('list');
    expect(cfgStat?.fields['stderr']?.type).toBe('str');
    expect(cfgStat?.fields['stderr_lines']?.type).toBe('list');

    const statField = cfgStat?.fields['stat'];
    expect(statField?.docUrl).toBe(
      'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/stat_module.html#return-stat',
    );
    expect(statField?.children?.['exists']?.type).toBe('bool');
    expect(statField?.children?.['exists']?.docUrl).toBe(
      'https://docs.ansible.com/ansible/latest/collections/ansible/builtin/stat_module.html#return-stat/exists',
    );

    const resolvedExists = resolveRegisteredFieldPath(cfgStat!, ['stat', 'exists']);
    expect(resolvedExists?.type).toBe('bool');
    expect(resolvedExists?.sample).toBe(true);

    expect(resolveRegisteredFieldPath(cfgStat!, [])).toBeUndefined();
    expect(resolveRegisteredFieldPath(cfgStat!, ['stat', 'nonexistent'])).toBeUndefined();
  });

  it('wraps per-iteration return fields and item inside results[] when task uses loop or with_items', () => {
    const registry = createTestMetadataRegistry();
    const loopCmdTask = makeTask('ansible.builtin.command', {
      name: 'Run commands in loop',
      register: 'cmd_results',
      loop: ['one', 'two'],
      loopKind: 'loop',
      params: [makeParam('cmd', 'echo {{ item }}')],
      range: makeRange(4, 4, 50, 7, 20, 120),
    });

    const preTask = makeTask('ansible.builtin.copy', {
      register: 'pre_copy',
      loopKind: 'with_items',
      params: [makeParam('dest', '/tmp/a')],
      range: makeRange(10, 4, 150, 12, 20, 190),
    });

    const postTask = makeTask('unknown.custom.mod', {
      register: 'post_custom',
      range: makeRange(14, 4, 210, 16, 20, 240),
    });

    const handlerTask = makeTask('ansible.builtin.debug', {
      register: 'handler_res',
      range: makeRange(18, 4, 260, 20, 20, 290),
    });

    const ast = makeAst('file:///workspace/tasks.yml', 'tasks', {
      tasks: [loopCmdTask],
      handlers: [handlerTask],
      plays: [
        makePlay({
          preTasks: [preTask],
          postTasks: [postTask],
          handlers: [handlerTask],
        }),
      ],
    });

    const inferredMap = inferRegisteredVariables(ast, registry);
    expect(inferredMap.size).toBe(4);

    const cmdRes = inferredMap.get('cmd_results');
    expect(cmdRes?.isLoop).toBe(true);
    expect(Object.keys(cmdRes?.fields ?? {}).sort()).toEqual([
      'changed',
      'failed',
      'msg',
      'results',
      'skipped',
    ]);
    expect(cmdRes?.fields['results']?.type).toBe('list');
    expect(cmdRes?.fields['results']?.children?.['item']?.type).toBe('raw');
    expect(cmdRes?.fields['results']?.children?.['stdout']?.type).toBe('str');
    expect(cmdRes?.fields['results']?.children?.['cmd']?.type).toBe('list');

    expect(resolveRegisteredFieldPath(cmdRes!, ['results[0]', 'stdout'])?.type).toBe('str');
    expect(resolveRegisteredFieldPath(cmdRes!, ['results', '0', 'item'])?.type).toBe('raw');
    expect(resolveRegisteredFieldPath(cmdRes!, ['results', '[1]', 'cmd'])?.type).toBe('list');
    expect(resolveRegisteredFieldPath(cmdRes!, ['changed'])?.type).toBe('bool');

    const preCopy = inferredMap.get('pre_copy');
    expect(preCopy?.isLoop).toBe(true);
    expect(resolveRegisteredFieldPath(preCopy!, ['results[0]', 'checksum'])?.type).toBe('str');

    const postCustom = inferredMap.get('post_custom');
    expect(postCustom?.moduleFqcn).toBe('unknown.custom.mod');
    expect(postCustom?.fields['stdout']?.type).toBe('str');
  });
});
