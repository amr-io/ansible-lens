import type { SourcePosition, SourceRange } from '../contracts/types.js';

/**
 * Maps character offsets in a source document to 0-indexed `SourcePosition` (`line`, `column`, `offset`).
 * Supports both LF (`\n`) and CRLF (`\r\n`) line endings deterministically.
 */
export class OffsetIndex {
  private readonly lineStarts: number[];
  public readonly textLength: number;

  public constructor(text: string) {
    this.textLength = text.length;
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 /* \n */) {
        starts.push(i + 1);
      }
    }
    this.lineStarts = starts;
  }

  /**
   * Converts a 0-indexed character offset into a 0-indexed `SourcePosition`.
   */
  public positionAt(offset: number): SourcePosition {
    const clamped = Math.max(0, Math.min(offset, this.textLength));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const start = this.lineStarts[mid] ?? 0;
      if (start <= clamped) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const line = Math.max(0, high);
    const lineStart = this.lineStarts[line] ?? 0;
    return {
      line,
      column: clamped - lineStart,
      offset: clamped,
    };
  }

  /**
   * Builds a `SourceRange` from half-open `[startOffset, endOffset)` character offsets.
   */
  public rangeAt(startOffset: number, endOffset: number): SourceRange {
    const safeStart = Math.max(0, Math.min(startOffset, this.textLength));
    const safeEnd = Math.max(safeStart, Math.min(endOffset, this.textLength));
    return {
      start: this.positionAt(safeStart),
      end: this.positionAt(safeEnd),
    };
  }
}

/**
 * Advances a `SourcePosition` across a substring slice starting from `base`.
 */
export function advancePosition(base: SourcePosition, slice: string): SourcePosition {
  let line = base.line;
  let column = base.column;
  for (let i = 0; i < slice.length; i++) {
    if (slice.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return {
    line,
    column,
    offset: base.offset + slice.length,
  };
}
