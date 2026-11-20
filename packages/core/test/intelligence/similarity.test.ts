import { describe, expect, it } from 'vitest';
import { findClosestMatch, levenshteinDistance } from '../../src/intelligence/index.js';

describe('similarity helpers', () => {
  it('computes exact Levenshtein distance including empty and swapped strings', () => {
    expect(levenshteinDistance('copy', 'copy')).toBe(0);
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('sitting', 'kitten')).toBe(3);
  });

  it('finds closest match deterministically and respects maxDistance', () => {
    expect(findClosestMatch('copy', [])).toBeUndefined();
    expect(findClosestMatch('cpy', ['', 'copy', 'stat'])).toBe('copy');
    expect(findClosestMatch('ab', ['ac', 'ad', 'abcdefg'], 1)).toBe('ac');
    expect(findClosestMatch('xyz', ['copy', 'stat'], 1)).toBeUndefined();
    // Tie break by length difference then lexicographical order
    expect(findClosestMatch('cat', ['cats', 'bat', 'car'])).toBe('bat');
  });
});
