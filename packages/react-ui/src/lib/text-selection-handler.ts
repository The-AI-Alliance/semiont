/**
 * Text selection handler logic for AnnotateView
 *
 * Builds W3C annotation selectors (TextPositionSelector + TextQuoteSelector)
 * from a text selection. No DOM, React, or CodeMirror dependencies.
 *
 * A selection is two offsets into the content: they count Unicode code
 * points from its start, as a `TextPositionSelector` does.
 */

import { extractContext, type TextOffsets, type components } from '@semiont/core';

/**
 * A pair of selectors for a text annotation:
 * TextPositionSelector (exact position) + TextQuoteSelector (fuzzy anchoring)
 */
export type SelectorPair = [
  components['schemas']['TextPositionSelector'],
  components['schemas']['TextQuoteSelector'],
];

/**
 * Build a TextPositionSelector + TextQuoteSelector pair for a selection of
 * the content from one offset to another. The quote is the content's own
 * text between them, so the two selectors agree, and its context is the
 * content's text around it.
 *
 * @param content - Full document text
 * @param offsets - The content's own conversions (`textOffsets(content)`)
 * @param start - The offset the selection starts at
 * @param end - The offset just after it
 * @returns Selector pair ready for mark:requested event, or null if the content has no such stretch
 */
export function buildTextSelectors(
  content: string,
  offsets: TextOffsets,
  start: number,
  end: number
): SelectorPair | null {
  if (start < 0 || end <= start || end > offsets.length) {
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
      exact: content.slice(offsets.indexAt(start), offsets.indexAt(end)),
      ...(context.prefix && { prefix: context.prefix }),
      ...(context.suffix && { suffix: context.suffix })
    }
  ];
}

/**
 * Where the content first has the selected text, as two offsets. Used when
 * the selection was not made in a CodeMirror editor, whose own positions
 * say where a selection is.
 *
 * @param content - Full document text
 * @param offsets - The content's own conversions (`textOffsets(content)`)
 * @param selectedText - The selected text
 * @returns The two offsets, or null if the content does not have the text
 */
export function fallbackTextPosition(
  content: string,
  offsets: TextOffsets,
  selectedText: string
): { start: number; end: number } | null {
  const index = content.indexOf(selectedText);
  if (index === -1) return null;
  return { start: offsets.offsetAt(index), end: offsets.offsetAt(index + selectedText.length) };
}
