/**
 * Pure, deterministic helpers for Smart `{{ | }}` Auto-Space in Ansible YAML and `.j2` files.
 *
 * - Pressing `Space` when the cursor is inside `{{|}}` (meaning `{{ |}}` after VS Code inserts
 *   the space character) inserts a trailing space (`{{ | }}`) and keeps the cursor centered.
 * - Pressing `Backspace` inside empty `{{ | }}` (meaning `{{| }}` after VS Code deletes the
 *   leading space character) deletes the trailing space back to `{{|}}`.
 */

export interface AutoSpaceReaction {
  readonly kind: 'space-expand' | 'backspace-collapse';
  /** Line-relative `[startCol, endCol)` range to replace in the document. */
  readonly replaceStartCol: number;
  readonly replaceEndCol: number;
  /** Replacement text for `[replaceStartCol, replaceEndCol)`. */
  readonly newText: string;
  /** Desired 0-indexed cursor column on the line after applying the edit. */
  readonly cursorCol: number;
}

/**
 * Inspects a single-line content change and returns an `AutoSpaceReaction` if it matches:
 * 1. Typing a single space `' '` inside `{{|}}` (resulting in `...{{ }}...` at `changeStartCol`).
 * 2. Pressing Backspace inside `{{ | }}` (deleting 1 char before `' }}'`, leaving `...{{ }}...`).
 */
export function evaluateJinjaBraceAutoSpace(
  lineTextAfterChange: string,
  changeStartCol: number,
  rangeLength: number,
  insertedText: string,
): AutoSpaceReaction | undefined {
  // Case 1: User pressed Space inside `{{|}}`.
  // Before the keystroke: `...{{}}...` with cursor at `changeStartCol` (right after `{{`).
  // After the keystroke: `lineTextAfterChange` has `{{ ` at `[changeStartCol - 2, changeStartCol + 1)`
  // and `}}` immediately at `[changeStartCol + 1, changeStartCol + 3)`.
  if (rangeLength === 0 && insertedText === ' ') {
    if (
      changeStartCol >= 2 &&
      lineTextAfterChange.slice(changeStartCol - 2, changeStartCol + 3) === '{{ }}'
    ) {
      return {
        kind: 'space-expand',
        replaceStartCol: changeStartCol + 1,
        replaceEndCol: changeStartCol + 1,
        newText: ' ',
        cursorCol: changeStartCol + 1,
      };
    }
  }

  // Case 2: User pressed Backspace inside empty `{{ | }}`.
  // Before the keystroke: `...{{  }}...` with cursor between the two spaces (`changeStartCol + 1`).
  // After the keystroke (deleted 1 character at `changeStartCol`):
  // `lineTextAfterChange` has `{{` at `[changeStartCol - 2, changeStartCol)` and ` }}` at
  // `[changeStartCol, changeStartCol + 3)`.
  if (rangeLength === 1 && insertedText === '') {
    if (
      changeStartCol >= 2 &&
      lineTextAfterChange.slice(changeStartCol - 2, changeStartCol + 3) === '{{ }}'
    ) {
      return {
        kind: 'backspace-collapse',
        replaceStartCol: changeStartCol,
        replaceEndCol: changeStartCol + 1,
        newText: '',
        cursorCol: changeStartCol,
      };
    }
  }

  return undefined;
}
