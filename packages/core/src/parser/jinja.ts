import type {
  JinjaBlockKind,
  JinjaBlockNode,
  JinjaToken,
  JinjaTokenKind,
  JinjaVariableRef,
  SourcePosition,
  SourceRange,
} from '../contracts/types.js';
import { advancePosition } from './sourceMap.js';

const JINJA_KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'in',
  'is',
  'if',
  'else',
  'elif',
  'endif',
  'for',
  'endfor',
  'set',
  'block',
  'endblock',
  'macro',
  'endmacro',
  'include',
  'import',
  'from',
  'as',
  'with',
  'without',
  'context',
  'true',
  'false',
  'none',
  'True',
  'False',
  'None',
  'loop',
  'defined',
  'undefined',
]);

const COMPARISON_KEYWORDS = new Set(['is', 'in', 'not', 'and', 'or']);

const TWO_CHAR_OPERATORS = new Set(['==', '!=', '<=', '>=', '//', '**', '~=', '|>']);
const ONE_CHAR_OPERATORS = new Set(['+', '-', '*', '/', '%', '=', '<', '>', '~', '|', '!']);
const PUNCTUATION_CHARS = new Set(['.', ',', ':', '(', ')', '[', ']', '{', '}']);

function isIdentStart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95; /* _ */
}

function isIdentPart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return isIdentStart(ch) || (code >= 48 && code <= 57);
}

function isDigit(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function stripBlockDelimiters(
  raw: string,
  kind: JinjaBlockKind,
): { content: string; contentStartDelta: number; unclosed: boolean } {
  if (kind === 'implicit') {
    return { content: raw, contentStartDelta: 0, unclosed: false };
  }

  const openDelim = kind === 'expression' ? '{{' : kind === 'statement' ? '{%' : '{#';
  const closeDelim = kind === 'expression' ? '}}' : kind === 'statement' ? '%}' : '#}';

  const hasOpen = raw.startsWith(openDelim);
  const startOffset = hasOpen ? openDelim.length : 0;
  // Support whitespace-trimming markers like {{- ... -}} or {%- ... -%}
  const afterOpen = hasOpen && raw[startOffset] === '-' ? startOffset + 1 : startOffset;

  const rest = raw.slice(afterOpen);
  const closeIdx = rest.lastIndexOf(closeDelim);
  if (closeIdx === -1) {
    return {
      content: rest,
      contentStartDelta: afterOpen,
      unclosed: hasOpen,
    };
  }

  const endInRest = closeIdx > 0 && rest[closeIdx - 1] === '-' ? closeIdx - 1 : closeIdx;
  return {
    content: rest.slice(0, endInRest),
    contentStartDelta: afterOpen,
    unclosed: false,
  };
}

interface RawSegment {
  value: string;
  start: number;
  end: number;
  kind: JinjaTokenKind;
}

function scanContentTokens(content: string): {
  segments: RawSegment[];
  variables: { root: string; path: string[]; raw: string; start: number; end: number }[];
  filters: string[];
  tests: string[];
} {
  const segments: RawSegment[] = [];
  const variables: { root: string; path: string[]; raw: string; start: number; end: number }[] = [];
  const filters: string[] = [];
  const tests: string[] = [];

  let i = 0;
  const len = content.length;

  let expectFilter = false;
  let expectTest = false;
  let afterNotInTest = false;

  while (i < len) {
    const ch = content[i] ?? '';

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }

    // String literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < len) {
        const cur = content[i] ?? '';
        if (cur === '\\' && i + 1 < len) {
          i += 2;
          continue;
        }
        if (cur === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      segments.push({
        value: content.slice(start, i),
        start,
        end: i,
        kind: 'literal',
      });
      expectFilter = false;
      expectTest = false;
      afterNotInTest = false;
      continue;
    }

    // Numeric literal
    if (isDigit(ch)) {
      const start = i;
      i += 1;
      while (i < len && (isDigit(content[i] ?? '') || content[i] === '.')) {
        if (content[i] === '.' && !isDigit(content[i + 1] ?? '')) {
          break;
        }
        i += 1;
      }
      segments.push({
        value: content.slice(start, i),
        start,
        end: i,
        kind: 'literal',
      });
      expectFilter = false;
      expectTest = false;
      afterNotInTest = false;
      continue;
    }

    // Two-char operator
    const two = content.slice(i, i + 2);
    if (TWO_CHAR_OPERATORS.has(two)) {
      segments.push({ value: two, start: i, end: i + 2, kind: 'operator' });
      expectFilter = false;
      expectTest = false;
      afterNotInTest = false;
      i += 2;
      continue;
    }

    // Single-char operator
    if (ONE_CHAR_OPERATORS.has(ch)) {
      segments.push({ value: ch, start: i, end: i + 1, kind: 'operator' });
      expectFilter = ch === '|';
      expectTest = false;
      afterNotInTest = false;
      i += 1;
      continue;
    }

    // Punctuation
    if (PUNCTUATION_CHARS.has(ch)) {
      segments.push({ value: ch, start: i, end: i + 1, kind: 'punctuation' });
      if (ch !== '(') {
        expectFilter = false;
      }
      expectTest = false;
      afterNotInTest = false;
      i += 1;
      continue;
    }

    // Identifier / dotted+bracketed variable / filter / test / keyword
    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (i < len && isIdentPart(content[i] ?? '')) {
        i += 1;
      }
      const word = content.slice(start, i);

      if (expectFilter) {
        filters.push(word);
        segments.push({ value: word, start, end: i, kind: 'filter' });
        expectFilter = false;
        expectTest = false;
        afterNotInTest = false;
        continue;
      }

      if (expectTest) {
        if (word === 'not' && !afterNotInTest) {
          segments.push({ value: word, start, end: i, kind: 'keyword' });
          afterNotInTest = true;
          continue;
        }
        tests.push(word);
        segments.push({ value: word, start, end: i, kind: 'test' });
        expectTest = false;
        afterNotInTest = false;
        continue;
      }

      if (word === 'is') {
        segments.push({ value: word, start, end: i, kind: 'keyword' });
        expectTest = true;
        afterNotInTest = false;
        continue;
      }

      if (JINJA_KEYWORDS.has(word) && !isChainStart(content, i)) {
        const tokenKind: JinjaTokenKind =
          word === 'true' ||
          word === 'false' ||
          word === 'none' ||
          word === 'True' ||
          word === 'False' ||
          word === 'None'
            ? 'literal'
            : COMPARISON_KEYWORDS.has(word)
              ? 'keyword'
              : 'keyword';
        segments.push({ value: word, start, end: i, kind: tokenKind });
        continue;
      }

      // Parse full dotted / bracketed access chain: e.g. res.results[0].item or ansible_facts['os_family']
      // If followed by `(` directly without `.` or `[`, it's a function call (e.g. `lookup(...)`) unless chained.
      const path: string[] = [];
      let chainEnd = i;
      let cursor = i;

      while (cursor < len) {
        const nextCh = content[cursor];
        if (nextCh === '.') {
          const propStart = cursor + 1;
          if (propStart < len && isIdentStart(content[propStart] ?? '')) {
            let propEnd = propStart + 1;
            while (propEnd < len && isIdentPart(content[propEnd] ?? '')) {
              propEnd += 1;
            }
            path.push(content.slice(propStart, propEnd));
            cursor = propEnd;
            chainEnd = propEnd;
            continue;
          }
          // Trailing dot while user is typing (e.g., `res.`): include trailing dot in raw range
          chainEnd = propStart;
          cursor = propStart;
          break;
        }
        if (nextCh === '[') {
          const closeBracket = content.indexOf(']', cursor + 1);
          if (closeBracket === -1) {
            break;
          }
          const inner = content.slice(cursor + 1, closeBracket).trim();
          const normalized =
            (inner.startsWith("'") && inner.endsWith("'")) ||
            (inner.startsWith('"') && inner.endsWith('"'))
              ? inner.slice(1, -1)
              : inner;
          if (normalized.length > 0) {
            path.push(normalized);
          }
          cursor = closeBracket + 1;
          chainEnd = cursor;
          continue;
        }
        break;
      }

      // Check if this is a standalone function call like `lookup(...)` or `range(...)` without property access
      const isFunctionCall = path.length === 0 && content[chainEnd] === '(';
      const rawVar = content.slice(start, chainEnd);

      if (isFunctionCall) {
        segments.push({ value: word, start, end: i, kind: 'keyword' });
      } else {
        segments.push({ value: rawVar, start, end: chainEnd, kind: 'variable' });
        variables.push({
          root: word,
          path,
          raw: rawVar,
          start,
          end: chainEnd,
        });
      }

      i = chainEnd;
      expectFilter = false;
      expectTest = false;
      afterNotInTest = false;
      continue;
    }

    // Unknown single character: consume safely without throwing
    i += 1;
  }

  return { segments, variables, filters, tests };
}

function isChainStart(content: string, index: number): boolean {
  const next = content[index];
  return next === '.' || next === '[';
}

/**
 * Tokenizes a single Jinja2 block (`{{ ... }}`, `{% ... %}`, `{# ... #}`) or an implicit
 * conditional expression (`when:`, `changed_when:`, `failed_when:`, `until:`).
 *
 * Fault-tolerant: never throws on unclosed braces, malformed quotes, or partial tokens.
 */
export function tokenizeJinjaBlock(
  raw: string,
  kind: JinjaBlockKind = 'expression',
  baseOffset = 0,
  baseLine = 0,
  baseColumn = 0,
): JinjaBlockNode {
  const basePos: SourcePosition = {
    line: baseLine,
    column: baseColumn,
    offset: baseOffset,
  };
  const endPos = advancePosition(basePos, raw);
  const blockRange: SourceRange = { start: basePos, end: endPos };

  const { content, contentStartDelta, unclosed } = stripBlockDelimiters(raw, kind);
  const contentBase = advancePosition(basePos, raw.slice(0, contentStartDelta));

  if (kind === 'comment') {
    return {
      kind,
      raw,
      content,
      range: blockRange,
      tokens: [],
      variables: [],
      filters: [],
      tests: [],
      unclosed,
    };
  }

  const scanned = scanContentTokens(content);

  const tokens: JinjaToken[] = scanned.segments.map((seg) => {
    const start = advancePosition(contentBase, content.slice(0, seg.start));
    const end = advancePosition(start, content.slice(seg.start, seg.end));
    return {
      kind: seg.kind,
      value: seg.value,
      range: { start, end },
    };
  });

  const variables: JinjaVariableRef[] = scanned.variables.map((v) => {
    const start = advancePosition(contentBase, content.slice(0, v.start));
    const end = advancePosition(start, content.slice(v.start, v.end));
    return {
      root: v.root,
      path: v.path,
      raw: v.raw,
      range: { start, end },
    };
  });

  return {
    kind,
    raw,
    content,
    range: blockRange,
    tokens,
    variables,
    filters: scanned.filters,
    tests: scanned.tests,
    unclosed,
  };
}

/**
 * Extracts all explicit Jinja2 blocks (`{{ ... }}`, `{% ... %}`, `{# ... #}`) from an arbitrary text slice.
 * Handles unclosed blocks cleanly while preserving exact source coordinates.
 */
export function extractJinjaBlocksFromText(
  text: string,
  baseOffset: number,
  baseLine: number,
  baseColumn: number,
): JinjaBlockNode[] {
  const blocks: JinjaBlockNode[] = [];
  const basePos: SourcePosition = { line: baseLine, column: baseColumn, offset: baseOffset };

  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];
    if (ch === '{') {
      const next = text[i + 1];
      let kind: JinjaBlockKind | undefined;
      let closeDelim = '';
      if (next === '{') {
        kind = 'expression';
        closeDelim = '}}';
      } else if (next === '%') {
        kind = 'statement';
        closeDelim = '%}';
      } else if (next === '#') {
        kind = 'comment';
        closeDelim = '#}';
      }

      if (kind !== undefined) {
        const startIdx = i;
        const startPos = advancePosition(basePos, text.slice(0, startIdx));
        let cursor = i + 2;
        let inQuote: string | undefined;
        let foundClose = false;

        while (cursor < len) {
          const cur = text[cursor] ?? '';
          if (kind !== 'comment') {
            if (inQuote !== undefined) {
              if (cur === '\\' && cursor + 1 < len) {
                cursor += 2;
                continue;
              }
              if (cur === inQuote) {
                inQuote = undefined;
              }
              cursor += 1;
              continue;
            }
            if (cur === '"' || cur === "'") {
              inQuote = cur;
              cursor += 1;
              continue;
            }
          }

          if (text.slice(cursor, cursor + 2) === closeDelim) {
            cursor += 2;
            foundClose = true;
            break;
          }
          cursor += 1;
        }

        // If unclosed, stop at end of line or end of text so a stray `{{` doesn't swallow the whole document
        let endIdx = cursor;
        if (!foundClose) {
          const newlineIdx = text.indexOf('\n', startIdx);
          endIdx = newlineIdx === -1 ? len : newlineIdx;
        }

        const raw = text.slice(startIdx, endIdx);
        blocks.push(tokenizeJinjaBlock(raw, kind, startPos.offset, startPos.line, startPos.column));
        i = Math.max(endIdx, startIdx + 2);
        continue;
      }
    }
    i += 1;
  }

  return blocks;
}
