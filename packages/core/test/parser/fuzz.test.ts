import { describe, expect, it } from 'vitest';
import {
  detectAnsibleDocument,
  parseAnsibleDocument,
  tokenizeJinjaBlock,
} from '../../src/parser/index.js';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  '- name: ',
  'hosts: all',
  'tasks:',
  '  - copy:',
  '    src: ',
  '    dest: /tmp',
  '{{ ',
  ' }}',
  '{% if ',
  ' %}',
  '{# comment ',
  '#}',
  'res.results[0].item',
  ' | default(',
  'is defined',
  ': ',
  '\n',
  '\r\n',
  '  ',
  '[1, 2',
  '{a: b',
  'yes',
  'FALSE',
  '"""',
  "'''",
  '🚀',
  '&anchor',
  '*alias',
  '---\n',
  '...\n',
  '\t',
  '\\',
];

describe('Parser & Jinja2 fuzz / resilience suite', () => {
  it('never throws on 300 deterministic malformed/truncated/adversarial YAML+Jinja2 inputs', () => {
    const rand = mulberry32(20261120);

    for (let i = 0; i < 300; i++) {
      const len = 1 + Math.floor(rand() * 25);
      let doc = '';
      for (let j = 0; j < len; j++) {
        const frag = FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)] ?? '';
        doc += frag;
      }

      // Exercise heuristic detector, full document parser, and raw Jinja tokenizer
      const detected = detectAnsibleDocument(`file:///fuzz_${i}.yml`, doc, i % 2 === 0);
      expect(typeof detected.isAnsible).toBe('boolean');

      const ast = parseAnsibleDocument(`file:///fuzz_${i}.yml`, doc);
      expect(ast.uri).toBe(`file:///fuzz_${i}.yml`);
      expect(Array.isArray(ast.plays)).toBe(true);
      expect(Array.isArray(ast.tasks)).toBe(true);
      expect(Array.isArray(ast.jinjaBlocks)).toBe(true);
      expect(Array.isArray(ast.syntaxErrors)).toBe(true);

      const jBlock = tokenizeJinjaBlock(doc, i % 3 === 0 ? 'implicit' : 'expression');
      expect(typeof jBlock.unclosed).toBe('boolean');
      expect(Array.isArray(jBlock.tokens)).toBe(true);
    }
  });

  it('handles empty, whitespace-only, comment-only, scalar-root, and deeply truncated documents', () => {
    const edgeInputs = [
      '',
      '   \n\r\n\t  ',
      '# just a comment\n# another comment',
      'just a plain string {{ unclosed',
      '- ',
      '- name:',
      '- block:\n  - ',
      '{{{{{{{{{{{{{{{{{{',
      '{% if x %}{% endif %',
      'a: [{{{{, {{{{]',
    ];

    for (const input of edgeInputs) {
      const ast = parseAnsibleDocument('file:///edge.yml', input);
      expect(ast.text).toBe(input);
      expect(Array.isArray(ast.syntaxErrors)).toBe(true);
    }
  });
});
