/**
 * Rendered markdown, from a stored selector to the words the overlay lights.
 *
 * A text offset counts Unicode code points from the start of the content. The
 * rendered text is DOM text, indexed in UTF-16 code units, where a character
 * outside the Basic Multilingual Plane is two; and it has none of the
 * source's markdown syntax. These tests put such characters and such syntax
 * before the annotated words.
 *
 * The real markdown renderer and the real overlay are used. Every offset was
 * counted by hand and again in Python, whose strings count code points.
 */
import { describe, it, expect } from 'vitest';
import '@testing-library/jest-dom';
import { annotationId, resourceId, type Annotation } from '@semiont/core';
import { createTestSemiontWrapper, renderInEnglish } from '../../../test-utils';
import { BrowseView } from '../BrowseView';

/** A heading, a blank line and a paragraph with bold words. 49 code points; its "words" are at 42 to 47, and at 44 to 49 in the string. */
const MARKDOWN = '# 😀 Title\n\nSome **bold 𝑥** text, then the words.\n';

/** The offset table's third text. 19 code points and 20 UTF-16 code units. */
const PLAIN = '😀 first, then words';

const RESOURCE = resourceId('res-1');
const NO_ANNOTATIONS = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

function highlight(id: string, start: number, end: number): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(id),
    motivation: 'highlighting',
    target: { source: RESOURCE, selector: { type: 'TextPositionSelector', start, end } },
    created: '2026-01-01T00:00:00Z',
  };
}

function mount(content: string, mimeType: string, highlights: Annotation[]): HTMLElement {
  const { session } = createTestSemiontWrapper();
  return renderInEnglish(
    <BrowseView
      content={content}
      mimeType={mimeType}
      resourceUri={RESOURCE}
      annotations={{ ...NO_ANNOTATIONS, highlights }}
      annotateMode={false}
      session={session}
      showToolbar={false}
    />,
  ).container;
}

/** The rendered text lit for an annotation: its spans' text, in order, as one. */
function lit(container: HTMLElement, id: string): string {
  return Array.from(container.querySelectorAll(`[data-annotation-id="${id}"]`)).map((span) => span.textContent).join('');
}

describe('a stored selector lights exactly its words over rendered markdown', () => {
  it('after a character outside the basic plane and markdown syntax', () => {
    const container = mount(MARKDOWN, 'text/markdown', [
      highlight('title', 4, 9),
      highlight('bold', 18, 24),
      highlight('words', 42, 47),
    ]);

    expect(lit(container, 'title')).toBe('Title');
    expect(lit(container, 'bold')).toBe('bold 𝑥');
    expect(lit(container, 'words')).toBe('words');
  });

  it('from such a character, across the syntax that closes the bold words', () => {
    const container = mount(MARKDOWN, 'text/markdown', [highlight('across', 23, 31)]);

    // The source there is "𝑥** text"; the two asterisks are not rendered.
    expect(lit(container, 'across')).toBe('𝑥 text');
  });

  it('in a plain text, which the same renderer shows', () => {
    const container = mount(PLAIN, 'text/plain', [highlight('first', 2, 7), highlight('words', 14, 19)]);

    expect(lit(container, 'first')).toBe('first');
    expect(lit(container, 'words')).toBe('words');
  });

  it('an offset the content does not have lights nothing, and the rest is still lit', () => {
    // 20 is a position in the string, which is 20 code units; the content is 19 code points.
    const container = mount(PLAIN, 'text/plain', [
      highlight('past-the-end', 15, 20),
      highlight('not-whole', 2.5, 7.5),
      highlight('first', 2, 7),
    ]);

    expect(lit(container, 'past-the-end')).toBe('');
    expect(lit(container, 'not-whole')).toBe('');
    expect(lit(container, 'first')).toBe('first');
  });
});
