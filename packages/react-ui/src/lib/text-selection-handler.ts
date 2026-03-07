/**
 * Text selection handler logic extracted from AnnotateView
 *
 * Builds W3C annotation selectors (TextPositionSelector + TextQuoteSelector)
 * from a text selection. No DOM, React, or CodeMirror dependencies.
 */

import { extractContext } from '@semiont/api-client';

/**
 * A pair of selectors for a text annotation:
 * TextPositionSelector (exact position) + TextQuoteSelector (fuzzy anchoring)
 */
export type SelectorPair = [
  { type: 'TextPositionSelector'; start: number; end: number },
  { type: 'TextQuoteSelector'; exact: string; prefix?: string; suffix?: string }
];

/**
 * Build a TextPositionSelector + TextQuoteSelector pair for a text selection.
 *
 * @param content - Full document text
 * @param selectedText - The selected text
 * @param start - Start position in the document
 * @param end - End position in the document
 * @returns Selector pair ready for mark:requested event, or null if invalid
 */
export function buildTextSelectors(
  content: string,
  selectedText: string,
  start: number,
  end: number
): SelectorPair | null {
  if (!selectedText || start < 0 || end <= start || end > content.length) {
    return null;
  }

  const context = extractContext(content, start, end);

  return [
    {
      type: 'TextPositionSelector',
      start,
      end
    },
    {
      type: 'TextQuoteSelector',
      exact: selectedText,
      ...(context.prefix && { prefix: context.prefix }),
      ...(context.suffix && { suffix: context.suffix })
    }
  ];
}

/**
 * Determine the start position of selected text using a fallback strategy.
 * Tries indexOf when CodeMirror's posAtDOM is unavailable.
 *
 * @param content - Full document text
 * @param selectedText - The selected text
 * @returns Position or null if not found
 */
export function fallbackTextPosition(
  content: string,
  selectedText: string
): { start: number; end: number } | null {
  const start = content.indexOf(selectedText);
  if (start === -1) return null;
  return { start, end: start + selectedText.length };
}
