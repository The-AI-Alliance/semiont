/**
 * What makes a text offset and what applies one, in the functions under the
 * source view and under the overlay.
 *
 * A text offset counts Unicode code points from the start of the content,
 * exactly as decoded. A JavaScript string, a DOM text node and CodeMirror's
 * document are indexed in UTF-16 code units, where a character outside the
 * Basic Multilingual Plane is two; and CodeMirror's document holds every line
 * break as one unit, where the content's CRLF is two code points.
 *
 * The first part runs specs/src/text/offset-cases.json, the table every
 * implementation that makes or applies an offset is held to, through the
 * selection builder and the segmenter. Every other expected number was counted
 * by hand and again in Python, whose strings count code points; none is read
 * from a run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { annotationId, resourceId, textOffsets, type Annotation } from '@semiont/core';
import { buildTextSelectors, fallbackTextPosition } from '../text-selection-handler';
import { segmentTextWithAnnotations, _resetDegradedAnchorWarnings } from '../text-segmentation';
import {
  documentPositions,
  convertSegmentPositions,
  computeAnnotationDecorations,
  computeWidgetDecorations,
  type TextSegment,
} from '../codemirror-logic';
import {
  buildSourceToRenderedMap,
  buildTextNodeIndex,
  resolveAnnotationSpans,
  applyHighlights,
  toOverlayAnnotations,
} from '../annotation-overlay';

// ─── The calls under test, each spelled once ─────────────────────────────────

/** The selector pair of a selection of `content` from one offset to another. */
function selectorsOf(content: string, start: number, end: number) {
  return buildTextSelectors(content, textOffsets(content), start, end);
}

/** Where `content` first has `words`. */
function firstPlaceOf(content: string, words: string) {
  return fallbackTextPosition(content, textOffsets(content), words);
}

/** The segments of `content`, each annotation anchored. */
function segmentsOf(content: string, annotations: Annotation[]): TextSegment[] {
  return segmentTextWithAnnotations(content, textOffsets(content), annotations);
}

/** The same segments, placed in CodeMirror's document. */
function placed(content: string, segments: TextSegment[]): TextSegment[] {
  return convertSegmentPositions(segments, documentPositions(content, textOffsets(content)));
}

/** The position in CodeMirror's document of an offset into `content`. */
function positionAt(content: string, offset: number): number {
  return documentPositions(content, textOffsets(content)).positionAt(offset);
}

/** The offset into `content` of a position in CodeMirror's document. */
function offsetAt(content: string, position: number): number {
  return documentPositions(content, textOffsets(content)).offsetAt(position);
}

/** Light `annotations` over the DOM that `source` rendered to; answers each one's stretch of the rendered text. */
function overlay(source: string, container: HTMLElement, annotations: Annotation[]): Array<[string, number, number]> {
  const sourceToRendered = buildSourceToRenderedMap(source, container);
  const spans = resolveAnnotationSpans(toOverlayAnnotations(annotations), textOffsets(source), sourceToRendered);
  applyHighlights(spans, buildTextNodeIndex(container));
  return spans.map((span) => [span.annotation.id, span.start, span.end]);
}

// ─── Texts ───────────────────────────────────────────────────────────────────

/** One line. 199 code points and 204 UTF-16 code units: five characters are outside the basic plane. */
const LONG =
  '😀 Opening line with a mathematical 𝑥 and a rare 𠮷 character, long enough that the context is cut. ' +
  'The chosen words sit here, after the 🎉 and before the 🙂; the same chosen words come again at the end.';

/** The offset table's third text. 19 code points and 20 units. */
const PLAIN = '😀 first, then words';

/** Three lines ending in CRLF, all of the basic plane. 48 code points. */
const CRLF = 'first line\r\nsecond line here\r\nthird line words\r\n';

/** Three lines ending in CRLF, a character outside the basic plane on each. 49 code points, 52 units. */
const CRLF_ASTRAL = '😀 first line\r\nsecond 𝑥 line\r\nthird line 🎉 words\r\n';

/** A heading, a blank line, and a paragraph with bold words. */
const MARKDOWN = '# 😀 Title\n\nSome **bold 𝑥** text, then the words.\n';
const MARKDOWN_RENDERED = '<h1>😀 Title</h1>\n<p>Some <strong>bold 𝑥</strong> text, then the words.</p>';

/** CodeMirror's document for a content: every CRLF is one line break. */
const editorDocument = (content: string): string => content.replace(/\r\n/g, '\n');

function stored(
  id: string,
  start: number,
  end: number,
  exact?: string,
  motivation: Annotation['motivation'] = 'highlighting',
): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(id),
    motivation,
    target: {
      source: resourceId('res-1'),
      selector: exact === undefined
        ? { type: 'TextPositionSelector', start, end }
        : [{ type: 'TextPositionSelector', start, end }, { type: 'TextQuoteSelector', exact }],
    },
    created: '2026-01-01T00:00:00Z',
  };
}

/** A segment as its text, its two ends, and the annotation it is of. */
const brief = (segments: TextSegment[]): Array<[string, number, number, string | null]> =>
  segments.map((segment) => [segment.exact, segment.start, segment.end, segment.annotation?.id ?? null]);

/** The rendered text lit for an annotation: its spans' text, in order, as one. */
const lit = (container: HTMLElement, id: string): string =>
  Array.from(container.querySelectorAll(`[data-annotation-id="${id}"]`)).map((span) => span.textContent).join('');

function rendered(html: string): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

beforeEach(() => {
  _resetDegradedAnchorWarnings();
  // A selector with a position and no quote is anchored at its position and said so, once.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

// ─── The offset table ────────────────────────────────────────────────────────

interface Span { exact: string; occurrence: number; start: number; end: number }
interface Case { why: string; text: string; codePoints: number; spans: Span[] }

const TABLE = 'specs/src/text/offset-cases.json';
const table: { cases: Case[] } = JSON.parse(readFileSync(resolve(__dirname, '../../../../..', TABLE), 'utf8'));

describe('the offset table, through what makes an offset and what applies one (specs/src/text/offset-cases.json)', () => {
  it('has cases, and one at least with a character outside the basic plane', () => {
    expect(table.cases.length).toBeGreaterThan(0);
    expect(table.cases.some(({ text }) => /[\u{10000}-\u{10FFFF}]/u.test(text))).toBe(true);
  });

  describe.each(table.cases)('$why', ({ text, spans }) => {
    it.each(spans)('"$exact" ($occurrence): a selection from the table\'s offsets is recorded with them, and quotes those words', ({ exact, start, end }) => {
      const pair = selectorsOf(text, start, end);
      expect(pair?.[0]).toEqual({ type: 'TextPositionSelector', start, end });
      expect(pair?.[1]).toMatchObject({ type: 'TextQuoteSelector', exact });
    });

    it.each(spans.filter(({ occurrence }) => occurrence === 1))('"$exact": searched for in the content, it is found at the table\'s offsets', ({ exact, start, end }) => {
      expect(firstPlaceOf(text, exact)).toEqual({ start, end });
    });

    it.each(spans)('"$exact" ($occurrence): a selector stored with the table\'s offsets is a segment of exactly those words', ({ exact, start, end }) => {
      const segments = segmentsOf(text, [stored('a', start, end)]);
      expect(brief(segments).filter(([, , , id]) => id === 'a')).toEqual([[exact, start, end, 'a']]);
      expect(segments.map((segment) => segment.exact).join('')).toBe(text);
    });

    it.each(spans)('"$exact" ($occurrence): and CodeMirror is given the place its document has those words', ({ exact, start, end }) => {
      const [decoration] = computeAnnotationDecorations(placed(text, segmentsOf(text, [stored('a', start, end)])));
      expect(decoration).toBeDefined();
      expect(editorDocument(text).slice(decoration!.start, decoration!.end)).toBe(exact);
    });
  });
});

// ─── Capture ─────────────────────────────────────────────────────────────────

describe('the selector pair of a selection', () => {
  it('has the offsets it was given, the content\'s text between them, and the text around that', () => {
    expect(selectorsOf(LONG, 102, 114)).toEqual([
      { type: 'TextPositionSelector', start: 102, end: 114 },
      {
        type: 'TextQuoteSelector',
        exact: 'chosen words',
        prefix: 'and a rare 𠮷 character, long enough that the context is cut. The ',
        suffix: ' sit here, after the 🎉 and before the 🙂; the same chosen words come',
      },
    ]);
  });

  it('quotes a CRLF of the content as the content has it', () => {
    expect(selectorsOf(CRLF_ASTRAL, 23, 34)).toEqual([
      { type: 'TextPositionSelector', start: 23, end: 34 },
      { type: 'TextQuoteSelector', exact: 'line\r\nthird', prefix: '😀 first line\r\nsecond 𝑥 ', suffix: ' line 🎉 words\r\n' },
    ]);
  });

  it('a selection to the end of the content ends at its count of code points, and has no suffix', () => {
    expect(selectorsOf(PLAIN, 14, 19)).toEqual([
      { type: 'TextPositionSelector', start: 14, end: 19 },
      { type: 'TextQuoteSelector', exact: 'words', prefix: '😀 first, then ' },
    ]);
  });

  it('is not made for an end the content does not have: 20 is a position in this string, and no offset of its 19 code points', () => {
    expect(selectorsOf(PLAIN, 15, 20)).toBeNull();
  });

  it.each([[-1, 3], [5, 5], [7, 2]])('is not made from %s to %s', (start, end) => {
    expect(selectorsOf(PLAIN, start, end)).toBeNull();
  });
});

describe('the first place a content has some words', () => {
  it('is given as offsets', () => {
    expect(firstPlaceOf(LONG, 'chosen words')).toEqual({ start: 102, end: 114 });
    expect(firstPlaceOf(CRLF_ASTRAL, 'words')).toEqual({ start: 42, end: 47 });
  });

  it('ends at the content\'s count of code points when the words end it', () => {
    expect(firstPlaceOf('end 🙂', '🙂')).toEqual({ start: 4, end: 5 });
  });

  it('is nowhere for words the content does not have', () => {
    expect(firstPlaceOf(LONG, 'not in it')).toBeNull();
  });
});

// ─── An offset into the content and a position in CodeMirror's document ──────

describe('an offset into the content and a position in CodeMirror\'s document', () => {
  /** Code points: a 😀 CR LF b CR LF 𝑥 c CR d. The document: a 😀(2) break b break 𝑥(2) c break d. */
  const SMALL = 'a😀\r\nb\r\n𝑥c\rd';

  it('every offset has its position: a character outside the basic plane is two further on, a CRLF one', () => {
    const positions = Array.from({ length: 12 }, (_, offset) => positionAt(SMALL, offset));
    // An offset between the CR and the LF of a CRLF is before that line break, as the CR is.
    expect(positions).toEqual([0, 1, 3, 3, 4, 5, 5, 6, 8, 9, 10, 11]);
  });

  it('every position between two characters has its offset: before a line break is the CR, after it is past the LF', () => {
    const offsets = [0, 1, 3, 4, 5, 6, 8, 9, 10, 11].map((position) => offsetAt(SMALL, position));
    expect(offsets).toEqual([0, 1, 2, 4, 5, 7, 8, 9, 10, 11]);
  });

  it.each([2, 7])('position %s is inside a character, and has no offset', (position) => {
    expect(() => offsetAt(SMALL, position)).toThrow(RangeError);
  });

  it.each([-1, 12, 0.5])('position %s is not in the document', (position) => {
    expect(() => offsetAt(SMALL, position)).toThrow(RangeError);
  });

  it.each([-1, 12, 0.5])('offset %s is not in the content', (offset) => {
    expect(() => positionAt(SMALL, offset)).toThrow(RangeError);
  });

  it('a content with neither is the same number each way', () => {
    const content = 'plain words\non two lines';
    for (let n = 0; n <= content.length; n++) {
      expect(positionAt(content, n)).toBe(n);
      expect(offsetAt(content, n)).toBe(n);
    }
  });

  it('in a CRLF document a position is short of its offset by the lines above it', () => {
    // "second" on the second line, "words" on the third.
    expect([positionAt(CRLF, 12), positionAt(CRLF, 18)]).toEqual([11, 17]);
    expect([positionAt(CRLF, 41), positionAt(CRLF, 46)]).toEqual([39, 44]);
    expect([offsetAt(CRLF, 11), offsetAt(CRLF, 17)]).toEqual([12, 18]);
    expect([offsetAt(CRLF, 39), offsetAt(CRLF, 44)]).toEqual([41, 46]);
  });

  it('and with characters outside the basic plane above it, further on by each of those', () => {
    // "words" on the third line: offsets 42 to 47, the string's 45 to 50, the document's 43 to 48.
    expect([positionAt(CRLF_ASTRAL, 42), positionAt(CRLF_ASTRAL, 47)]).toEqual([43, 48]);
    expect([offsetAt(CRLF_ASTRAL, 43), offsetAt(CRLF_ASTRAL, 48)]).toEqual([42, 47]);
  });

  it('from an offset to a position and back is the offset, for every offset not inside a CRLF', () => {
    for (const content of [SMALL, CRLF, CRLF_ASTRAL, LONG]) {
      const text = Array.from(content);
      for (let offset = 0; offset <= text.length; offset++) {
        if (text[offset - 1] === '\r' && text[offset] === '\n') continue;
        expect(offsetAt(content, positionAt(content, offset))).toBe(offset);
      }
    }
  });
});

// ─── Display, source view ────────────────────────────────────────────────────

describe('the segments of a content, and where CodeMirror is told they are', () => {
  it('a content with no annotation is one segment, which ends at its count of code points', () => {
    expect(brief(segmentsOf(PLAIN, []))).toEqual([[PLAIN, 0, 19, null]]);
  });

  it('after a character outside the basic plane: segments are in offsets and cover the content', () => {
    const segments = segmentsOf(PLAIN, [stored('first', 2, 7, 'first'), stored('words', 14, 19, 'words')]);

    expect(brief(segments)).toEqual([
      ['😀 ', 0, 2, null],
      ['first', 2, 7, 'first'],
      [', then ', 7, 14, null],
      ['words', 14, 19, 'words'],
    ]);
    expect(computeAnnotationDecorations(placed(PLAIN, segments)).map(({ start, end, meta }) => [meta.annotationId, start, end]))
      .toEqual([['first', 3, 8], ['words', 15, 20]]);
  });

  it('a long line with five such characters, the same words twice', () => {
    const segments = segmentsOf(LONG, [
      stored('first-chosen', 102, 114, 'chosen words'),
      stored('party', 135, 140, '🎉 and'),
      stored('second-chosen', 164, 176, 'chosen words'),
    ]);

    expect(brief(segments).filter(([, , , id]) => id !== null)).toEqual([
      ['chosen words', 102, 114, 'first-chosen'],
      ['🎉 and', 135, 140, 'party'],
      ['chosen words', 164, 176, 'second-chosen'],
    ]);
    expect(brief(segments).at(-1)).toEqual([' come again at the end.', 176, 199, null]);
    expect(segments.map((segment) => segment.exact).join('')).toBe(LONG);
    expect(computeAnnotationDecorations(placed(LONG, segments)).map(({ start, end }) => [start, end]))
      .toEqual([[105, 117], [138, 144], [169, 181]]);
  });

  it('a CRLF document: segments count each CR and LF, and CodeMirror\'s positions count a line break once', () => {
    const segments = segmentsOf(CRLF, [
      stored('second', 12, 18, 'second'),
      stored('across', 24, 35, 'here\r\nthird'),
      stored('words', 41, 46, 'words'),
    ]);

    expect(brief(segments).filter(([, , , id]) => id !== null)).toEqual([
      ['second', 12, 18, 'second'],
      ['here\r\nthird', 24, 35, 'across'],
      ['words', 41, 46, 'words'],
    ]);
    const decorations = computeAnnotationDecorations(placed(CRLF, segments));
    expect(decorations.map(({ start, end }) => [start, end])).toEqual([[11, 17], [23, 33], [39, 44]]);
    expect(decorations.map(({ start, end }) => editorDocument(CRLF).slice(start, end))).toEqual(['second', 'here\nthird', 'words']);
  });

  it('a CRLF document with a character outside the basic plane on every line', () => {
    const segments = segmentsOf(CRLF_ASTRAL, [
      stored('first', 2, 7, 'first', 'linking'),
      stored('x-line', 21, 27),
      stored('words', 42, 47, 'words'),
    ]);

    expect(brief(segments)).toEqual([
      ['😀 ', 0, 2, null],
      ['first', 2, 7, 'first'],
      [' line\r\nsecond ', 7, 21, null],
      ['𝑥 line', 21, 27, 'x-line'],
      ['\r\nthird line 🎉 ', 27, 42, null],
      ['words', 42, 47, 'words'],
      ['\r\n', 47, 49, null],
    ]);
    const inEditor = placed(CRLF_ASTRAL, segments);
    const decorations = computeAnnotationDecorations(inEditor);
    expect(decorations.map(({ start, end }) => [start, end])).toEqual([[3, 8], [21, 28], [43, 48]]);
    expect(decorations.map(({ start, end }) => editorDocument(CRLF_ASTRAL).slice(start, end))).toEqual(['first', '𝑥 line', 'words']);
    // A reference's widget sits where its words end.
    expect(computeWidgetDecorations(inEditor, null).map(({ annotationId: id, position }) => [id, position])).toEqual([['first', 8]]);
  });

  it('a stored position that is not two offsets of the content draws nothing, and the rest is drawn', () => {
    const segments = segmentsOf(PLAIN, [
      stored('not-whole', 2.5, 7.5),
      stored('past-the-end', 15, 20),
      stored('words', 14, 19),
    ]);

    expect(brief(segments)).toEqual([['😀 first, then ', 0, 14, null], ['words', 14, 19, 'words']]);
  });
});

// ─── Display, rendered markdown ──────────────────────────────────────────────

describe('the overlay\'s stretch of the rendered text for a stored selector', () => {
  it('after a character outside the basic plane and markdown syntax, each lights its words', () => {
    const container = rendered(MARKDOWN_RENDERED);
    const spans = overlay(MARKDOWN, container, [stored('title', 4, 9), stored('bold', 18, 24), stored('words', 42, 47)]);

    // The rendered text is DOM text: its stretches are in UTF-16 code units.
    expect(spans).toEqual([['title', 3, 8], ['bold', 14, 21], ['words', 37, 42]]);
    expect(lit(container, 'title')).toBe('Title');
    expect(lit(container, 'bold')).toBe('bold 𝑥');
    expect(lit(container, 'words')).toBe('words');
  });

  it('from such a character, across syntax that is not rendered', () => {
    const container = rendered(MARKDOWN_RENDERED);
    // The source there is "𝑥** text".
    expect(overlay(MARKDOWN, container, [stored('across', 23, 31)])).toEqual([['across', 19, 26]]);
    expect(lit(container, 'across')).toBe('𝑥 text');
  });

  it('in a text rendered as it is', () => {
    const container = rendered(`<p>${PLAIN}</p>`);

    expect(overlay(PLAIN, container, [stored('first', 2, 7), stored('words', 14, 19)])).toEqual([['first', 3, 8], ['words', 15, 20]]);
    expect(lit(container, 'first')).toBe('first');
    expect(lit(container, 'words')).toBe('words');
  });

  it.each([
    ['past the end: 20 is a position in the string, and no offset of its 19 code points', 15, 20],
    ['below zero', -2, 3],
    ['not whole numbers', 2.5, 7.5],
  ])('offsets the content does not have light nothing (%s)', (_why, start, end) => {
    const container = rendered(`<p>${PLAIN}</p>`);

    expect(overlay(PLAIN, container, [stored('none', start, end), stored('first', 2, 7)])).toEqual([['first', 3, 8]]);
    expect(lit(container, 'none')).toBe('');
    expect(lit(container, 'first')).toBe('first');
  });

  it('the overlay\'s form of a selector carries its offset and its length, in code points', () => {
    expect(toOverlayAnnotations([stored('words', 42, 47)])).toEqual([
      { id: 'words', exact: '', offset: 42, length: 5, type: 'highlight', source: null },
    ]);
  });
});
