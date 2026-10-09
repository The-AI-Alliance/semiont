/**
 * The source view, from a selection to the selectors it is recorded with, and
 * from a stored selector to the words it lights.
 *
 * A text offset counts Unicode code points from the start of the content,
 * exactly as decoded. The editor counts another way twice over: its document
 * is indexed in UTF-16 code units, where a character outside the Basic
 * Multilingual Plane is two, and every line break in it is one unit, where the
 * content's CRLF is two code points. So a place in the content has three
 * numbers, and these tests use texts in which all three differ.
 *
 * The real editor is mounted: nothing of CodeMirror, of the renderer or of the
 * segmenter is replaced. Every expected number was counted by hand and again
 * in Python, whose strings count code points; none is read from a run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { annotationId, resourceId, type Annotation } from '@semiont/core';
import type { AnnotationUIState } from '../../../types/annotation-props';
import { createTestSemiontWrapper, renderInEnglish } from '../../../test-utils';
import { AnnotateView } from '../AnnotateView';

/** One line. 199 code points and 204 UTF-16 code units: five characters are outside the basic plane. */
const LONG =
  '😀 Opening line with a mathematical 𝑥 and a rare 𠮷 character, long enough that the context is cut. ' +
  'The chosen words sit here, after the 🎉 and before the 🙂; the same chosen words come again at the end.';

/** Three lines ending in CRLF, all of the basic plane. 48 code points. */
const CRLF = 'first line\r\nsecond line here\r\nthird line words\r\n';

/** Three lines ending in CRLF, a character outside the basic plane on each. 49 code points, 52 units. */
const CRLF_ASTRAL = '😀 first line\r\nsecond 𝑥 line\r\nthird line 🎉 words\r\n';

const RESOURCE = resourceId('res-1');
const NO_ANNOTATIONS = { highlights: [], references: [], assessments: [], comments: [], tags: [] };
const UI_STATE: AnnotationUIState = {
  selectedMotivation: 'highlighting',
  selectedClick: 'detail',
  selectedShape: 'rectangle',
  hoveredAnnotationId: null,
  scrollToAnnotationId: null,
};

function mount(content: string, highlights: Annotation[] = [], showToolbar = false) {
  const { session, client } = createTestSemiontWrapper();
  const request = vi.spyOn(client.mark, 'request');
  const view = renderInEnglish(
    <AnnotateView
      content={content}
      mimeType="text/plain"
      resourceUri={RESOURCE}
      annotations={{ ...NO_ANNOTATIONS, highlights }}
      uiState={UI_STATE}
      session={session}
      annotateMode
      showToolbar={showToolbar}
    />,
  );
  return { ...view, request };
}

/** The editor's `number`-th line, counted from 1. */
function line(container: HTMLElement, number: number): Element {
  const found = container.querySelectorAll('.cm-line')[number - 1];
  if (!found) throw new Error(`the editor has no line ${number}`);
  return found;
}

/** Where `words` are in a line's own text, the `occurrence`-th time, as the DOM counts: in UTF-16 code units. */
function placeIn(lineElement: Element, words: string, occurrence: number): number {
  const text = lineElement.textContent;
  let at = -1;
  for (let n = 0; n < occurrence; n++) {
    at = text.indexOf(words, at + 1);
    if (at === -1) throw new Error(`"${text}" does not have "${words}" ${occurrence} time(s)`);
  }
  return at;
}

/** The text nodes under an element, in the order a reader meets them. */
function textNodes(root: Element): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text) nodes.push(node);
  }
  return nodes;
}

/** The text node of a line that holds its `units`-th code unit, and where in that node it is. */
function pointIn(lineElement: Element, units: number): [Node, number] {
  let before = 0;
  for (const node of textNodes(lineElement)) {
    if (units <= before + node.length) return [node, units - before];
    before += node.length;
  }
  throw new Error(`the line has no code unit ${units}`);
}

/** The text the toolbar shows. */
function toolbarText(container: HTMLElement): Text[] {
  const toolbar = container.querySelector('.semiont-annotate-toolbar');
  if (!toolbar) throw new Error('no toolbar is shown');
  return textNodes(toolbar);
}

/** Drag from a point to a point and let go, as a reader's selection does. */
function select(from: [Node, number], to: [Node, number], releasedOn: Element): void {
  const range = document.createRange();
  range.setStart(...from);
  range.setEnd(...to);
  const selection = window.getSelection();
  if (!selection) throw new Error('no selection');
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(releasedOn);
}

/** Select `words` where a line has them the `occurrence`-th time. */
function selectWords(container: HTMLElement, lineNumber: number, words: string, occurrence = 1): void {
  const lineElement = line(container, lineNumber);
  const at = placeIn(lineElement, words, occurrence);
  select(pointIn(lineElement, at), pointIn(lineElement, at + words.length), lineElement);
}

/** What one request to mark carried. */
function recorded(request: ReturnType<typeof mount>['request']): unknown {
  expect(request).toHaveBeenCalledTimes(1);
  const [source, selectors, motivation] = request.mock.calls[0]!;
  expect(source).toBe(RESOURCE);
  expect(motivation).toBe('highlighting');
  return selectors;
}

function highlight(id: string, start: number, end: number, exact?: string): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(id),
    motivation: 'highlighting',
    target: {
      source: RESOURCE,
      selector: exact === undefined
        ? { type: 'TextPositionSelector', start, end }
        : [{ type: 'TextPositionSelector', start, end }, { type: 'TextQuoteSelector', exact }],
    },
    created: '2026-01-01T00:00:00Z',
  };
}

/** The text the editor lights for an annotation: one piece for each line it is on. */
function lit(container: HTMLElement, id: string): string[] {
  return Array.from(container.querySelectorAll(`[data-annotation-id="${id}"]`)).map((span) => span.textContent);
}

beforeEach(() => {
  window.getSelection()?.removeAllRanges();
});

describe('a selection in the source view is recorded at its offsets in the content', () => {
  it('after characters outside the basic plane: each is one, and the context is the text around the words', () => {
    const { container, request } = mount(LONG);
    selectWords(container, 1, 'chosen words');

    // In the string and in the editor these words are at 105 to 117.
    expect(recorded(request)).toEqual([
      { type: 'TextPositionSelector', start: 102, end: 114 },
      {
        type: 'TextQuoteSelector',
        exact: 'chosen words',
        prefix: 'and a rare 𠮷 character, long enough that the context is cut. The ',
        suffix: ' sit here, after the 🎉 and before the 🙂; the same chosen words come',
      },
    ]);
  });

  it('the second place the content has the same words is recorded as the second', () => {
    const { container, request } = mount(LONG);
    selectWords(container, 1, 'chosen words', 2);

    expect(recorded(request)).toEqual([
      { type: 'TextPositionSelector', start: 164, end: 176 },
      {
        type: 'TextQuoteSelector',
        exact: 'chosen words',
        prefix: 'The chosen words sit here, after the 🎉 and before the 🙂; the same ',
        suffix: ' come again at the end.',
      },
    ]);
  });

  it('a selection that begins on such a character begins at its offset', () => {
    const { container, request } = mount(LONG);
    selectWords(container, 1, '🎉 and');

    expect(recorded(request)).toEqual([
      { type: 'TextPositionSelector', start: 135, end: 140 },
      {
        type: 'TextQuoteSelector',
        exact: '🎉 and',
        prefix: 'enough that the context is cut. The chosen words sit here, after the ',
        suffix: ' before the 🙂; the same chosen words come again at the end.',
      },
    ]);
  });

  it('the offset table\'s own repeated words, with such a character between them', () => {
    const { container, request } = mount('ab 🎉 ab');
    selectWords(container, 1, 'ab', 2);

    expect(recorded(request)).toEqual([
      { type: 'TextPositionSelector', start: 5, end: 7 },
      { type: 'TextQuoteSelector', exact: 'ab', prefix: 'ab 🎉 ' },
    ]);
  });
});

describe('a selection in a CRLF document is recorded at its offsets in the content, which count each CR and LF', () => {
  it('on the second line: one CRLF is above it', () => {
    const { container, request } = mount(CRLF);
    selectWords(container, 2, 'second');

    // In the editor's document, where a line break is one, these words are at 11 to 17.
    expect(recorded(request)).toEqual([
      { type: 'TextPositionSelector', start: 12, end: 18 },
      { type: 'TextQuoteSelector', exact: 'second', prefix: 'first line\r\n', suffix: ' line here\r\nthird line words\r\n' },
    ]);
  });

  it('on the third line: two are above it', () => {
    const { container, request } = mount(CRLF);
    selectWords(container, 3, 'words');

    expect(recorded(request)).toEqual([
      { type: 'TextPositionSelector', start: 41, end: 46 },
      { type: 'TextQuoteSelector', exact: 'words', prefix: 'first line\r\nsecond line here\r\nthird line ', suffix: '\r\n' },
    ]);
  });

  it('words every line has are recorded on the line they were selected on', () => {
    const { container, request } = mount(CRLF);
    selectWords(container, 3, 'line');

    expect(recorded(request)).toEqual([
      { type: 'TextPositionSelector', start: 36, end: 40 },
      { type: 'TextQuoteSelector', exact: 'line', prefix: 'first line\r\nsecond line here\r\nthird ', suffix: ' words\r\n' },
    ]);
  });

  it('with a character outside the basic plane on every line: offset, string position and editor position all differ', () => {
    const { container, request } = mount(CRLF_ASTRAL);
    selectWords(container, 3, 'words');

    // In the string these words are at 45 to 50, and in the editor's document at 43 to 48.
    expect(recorded(request)).toEqual([
      { type: 'TextPositionSelector', start: 42, end: 47 },
      { type: 'TextQuoteSelector', exact: 'words', prefix: '😀 first line\r\nsecond 𝑥 line\r\nthird line 🎉 ', suffix: '\r\n' },
    ]);
  });

  it('a selection that begins on such a character, on the second line', () => {
    const { container, request } = mount(CRLF_ASTRAL);
    selectWords(container, 2, '𝑥 line');

    expect(recorded(request)).toEqual([
      { type: 'TextPositionSelector', start: 21, end: 27 },
      { type: 'TextQuoteSelector', exact: '𝑥 line', prefix: '😀 first line\r\nsecond ', suffix: '\r\nthird line 🎉 words\r\n' },
    ]);
  });

  it('a selection across a line break quotes the content\'s own line ending', () => {
    const { container, request } = mount(CRLF);
    const second = line(container, 2);
    const third = line(container, 3);
    select(pointIn(second, placeIn(second, 'here', 1)), pointIn(third, 'third'.length), third);

    expect(recorded(request)).toEqual([
      { type: 'TextPositionSelector', start: 24, end: 35 },
      { type: 'TextQuoteSelector', exact: 'here\r\nthird', prefix: 'first line\r\nsecond line ', suffix: ' line words\r\n' },
    ]);
  });

  it('and the same across a line break after characters outside the basic plane', () => {
    const { container, request } = mount(CRLF_ASTRAL);
    const second = line(container, 2);
    const third = line(container, 3);
    select(pointIn(second, placeIn(second, 'line', 1)), pointIn(third, 'third'.length), third);

    expect(recorded(request)).toEqual([
      { type: 'TextPositionSelector', start: 23, end: 34 },
      { type: 'TextQuoteSelector', exact: 'line\r\nthird', prefix: '😀 first line\r\nsecond 𝑥 ', suffix: ' line 🎉 words\r\n' },
    ]);
  });
});

describe('a selection that is not of the content records nothing', () => {
  it('text selected in the toolbar, which the content also has', () => {
    const probe = mount('anything', [], true);
    const words = toolbarText(probe.container).find((node) => node.data.trim() !== '')?.data;
    if (!words) throw new Error('the toolbar shows no text');
    probe.unmount();

    // The content has the toolbar's words too, so a search of the content for the selected text finds them.
    const { container, request } = mount(`${words} is in the content as well`, [], true);
    const inToolbar = toolbarText(container).find((node) => node.data === words);
    if (!inToolbar?.parentElement) throw new Error('the toolbar no longer shows its words');
    select([inToolbar, 0], [inToolbar, words.length], inToolbar.parentElement);

    expect(request).not.toHaveBeenCalled();
  });

  it('a selection that begins in the toolbar and ends in the content', () => {
    const { container, request } = mount(LONG, [], true);
    const inToolbar = toolbarText(container).find((node) => node.data.trim() !== '');
    if (!inToolbar) throw new Error('the toolbar shows no text');
    const first = line(container, 1);
    select([inToolbar, 0], pointIn(first, placeIn(first, 'Opening', 1)), first);

    expect(request).not.toHaveBeenCalled();
  });
});

describe('a stored selector lights exactly its words in the source view', () => {
  it('after characters outside the basic plane', () => {
    const { container } = mount(LONG, [
      highlight('first-chosen', 102, 114, 'chosen words'),
      highlight('party', 135, 140, '🎉 and'),
      highlight('second-chosen', 164, 176, 'chosen words'),
    ]);

    expect(lit(container, 'first-chosen')).toEqual(['chosen words']);
    expect(lit(container, 'party')).toEqual(['🎉 and']);
    expect(lit(container, 'second-chosen')).toEqual(['chosen words']);
  });

  it('with a position and no quote: the offsets alone place it', () => {
    const { container } = mount('😀 first, then words', [highlight('first', 2, 7), highlight('words', 14, 19)]);

    expect(lit(container, 'first')).toEqual(['first']);
    expect(lit(container, 'words')).toEqual(['words']);
  });

  it('in a CRLF document, on lines that are not the first', () => {
    const { container } = mount(CRLF, [
      highlight('second', 12, 18, 'second'),
      highlight('across', 24, 35, 'here\r\nthird'),
      highlight('words', 41, 46, 'words'),
    ]);

    expect(lit(container, 'second')).toEqual(['second']);
    expect(lit(container, 'across')).toEqual(['here', 'third']);
    expect(lit(container, 'words')).toEqual(['words']);
  });

  it('in a CRLF document with a character outside the basic plane on every line', () => {
    const { container } = mount(CRLF_ASTRAL, [
      highlight('first', 2, 7, 'first'),
      highlight('x-line', 21, 27),
      highlight('words', 42, 47, 'words'),
    ]);

    expect(lit(container, 'first')).toEqual(['first']);
    expect(lit(container, 'x-line')).toEqual(['𝑥 line']);
    expect(lit(container, 'words')).toEqual(['words']);
  });

  it('across a line break of such a document', () => {
    const { container } = mount(CRLF_ASTRAL, [highlight('across', 23, 34, 'line\r\nthird')]);

    expect(lit(container, 'across')).toEqual(['line', 'third']);
  });
});
