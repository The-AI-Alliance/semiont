/**
 * `annotationOfSpan`, beside its table
 * (specs/src/annotations/builder-cases.json, in `builder-cases.test.ts`):
 * what goes into an annotation's id, built twice and built differently; the
 * selectors of a span of a PDF's anchored text over made-up pages; and the
 * two calls that make an annotation of what a model quoted.
 */

import { describe, it, expect } from 'vitest';
import { annotationOfSpan, reconcile, SpanRefusedError, type TextSpan } from '../annotation-builders';
import type { Annotation } from '../annotation-types';
import type { Motivation } from '../branded-types';
import { resourceId } from '../identifiers';
import type { Selector } from '../payload-types';
import type { AnchoredText } from '../pdf-anchoring';
import type { components } from '../types';
import { getTargetSelector } from '../web-annotation-utils';

type Agent = components['schemas']['Agent'];

const GENERATOR: Agent = {
  '@type': 'Software',
  '@id': 'did:web:test.local:agents:test:test',
  name: 'test',
  provider: 'test',
  model: 'test',
};

/** An annotation's selectors, as a list. */
function selectors(annotation: Annotation): Selector[] {
  const selector = getTargetSelector(annotation.target);
  if (selector === undefined) return [];
  return Array.isArray(selector) ? selector : [selector];
}

describe('building an annotation again does not make another', () => {
  // Annotation ids are content-addressed — hashed from the resource,
  // motivation, anchor and body — so building an annotation again, as a retry
  // or a resumed unit does, builds the same id. `annotation-id.test.ts` holds
  // the id FUNCTION. This holds the builder: which members it feeds the hash.
  // A builder that forgot to pass `body` would still produce deterministic
  // ids and still pass every test of the function, while silently collapsing
  // every comment on a span into one annotation.
  const RID = resourceId('res-idem');
  const CONTENT = 'Ada Lovelace wrote the first algorithm.';
  const span = (start: number, end: number): TextSpan => ({ exact: CONTENT.slice(start, end), start, end });
  const comment = (value: string): Annotation['body'] => [
    { type: 'TextualBody', value, purpose: 'commenting', format: 'text/plain' },
  ];
  const build = (of: TextSpan, motivation: Motivation, body?: Annotation['body']): Annotation =>
    annotationOfSpan({ text: CONTENT, resourceId: RID, generator: GENERATOR, motivation, span: of, body });

  it('the same span, motivation and body yields the SAME id', () => {
    // The whole point: a job the janitor recovered builds this again, and the
    // record already holds it.
    const first = build(span(0, 12), 'commenting', comment('an author'));
    const second = build(span(0, 12), 'commenting', comment('an author'));
    expect(second.id).toBe(first.id);
  });

  it('survives being built at a different time by a different agent', () => {
    // Recovery happens later, in a fresh worker process. If `created` or the
    // generator leaked into the id, every recovery would duplicate.
    const other: Agent = { ...GENERATOR, '@id': 'did:web:test.local:agents:test:OTHER' };
    const first = build(span(0, 12), 'highlighting');
    const second = annotationOfSpan({ text: CONTENT, resourceId: RID, generator: other, motivation: 'highlighting', span: span(0, 12) });
    expect(second.id).toBe(first.id);
  });

  it('a whole unit run again leaves the id set unchanged', () => {
    const unit = () => [
      build(span(0, 12), 'commenting', comment('an author')),
      build(span(13, 18), 'commenting', comment('a verb')),
      build(span(0, 12), 'highlighting'),
    ].map((annotation) => annotation.id);

    expect(new Set([...unit(), ...unit()]).size).toBe(3);
  });

  it('two DIFFERENT comments on one span stay two annotations', () => {
    // The collision a comment's id must avoid: two annotations on one span that
    // differ only by body. Fails if the builder omits `body` from the hash.
    const a = build(span(0, 12), 'commenting', comment('an author'));
    const b = build(span(0, 12), 'commenting', comment('a mathematician'));
    expect(b.id).not.toBe(a.id);
  });

  it('different spans stay different annotations', () => {
    expect(build(span(13, 18), 'highlighting').id).not.toBe(build(span(0, 12), 'highlighting').id);
  });

  it('the same span under different motivations stays two annotations', () => {
    const highlight = build(span(0, 12), 'highlighting');
    const commented = build(span(0, 12), 'commenting', comment('note'));
    expect(commented.id).not.toBe(highlight.id);
  });

  it('the same offsets over DIFFERENT text is a different annotation', () => {
    // After a content update the offsets survive but no longer quote the same
    // words; `exact` is in the anchor so that is not silently the same one.
    const shifted = annotationOfSpan({
      text: 'Grace Hopper wrote the first compiler.',
      resourceId: RID,
      generator: GENERATOR,
      motivation: 'highlighting',
      span: { exact: 'Grace Hopper', start: 0, end: 12 },
    });
    expect(shifted.id).not.toBe(build(span(0, 12), 'highlighting').id);
  });

  it('a span of a PDF has the id the same span of a text has', () => {
    // Same span, same motivation, same body ⇒ same annotation, whether it is
    // anchored by offset or by rectangle. A PDF's annotation carries geometry a
    // text's does not, but geometry is DERIVED from these offsets and adds no identity.
    const anchored: AnchoredText = {
      text: CONTENT,
      items: [{ page: 1, start: 0, end: CONTENT.length, x: 10, y: 700, width: 300, height: 12 }],
    };

    const pdf = annotationOfSpan({ anchored, resourceId: RID, generator: GENERATOR, motivation: 'highlighting', span: span(0, 12) });
    expect(pdf.id).toBe(build(span(0, 12), 'highlighting').id);
  });
});

const RID = resourceId('res-pdf');

// Two lines on one page — "alpha beta" (line 1, y=720) / "gamma delta" (line 2, y=700):
//   a0 l1 p2 h3 a4 _5 b6 e7 t8 a9 \n10 g11 a12 m13 m14 a15 _16 d17 e18 l19 t20 a21
const LAYER: AnchoredText = {
  text: 'alpha beta\ngamma delta',
  items: [
    { start: 0,  end: 5,  page: 1, x: 72,  y: 720, width: 40, height: 12 }, // alpha
    { start: 6,  end: 10, page: 1, x: 118, y: 720, width: 34, height: 12 }, // beta
    { start: 11, end: 16, page: 1, x: 72,  y: 700, width: 45, height: 12 }, // gamma
    { start: 17, end: 22, page: 1, x: 125, y: 700, width: 42, height: 12 }, // delta
  ],
};

// The SAME continuous text over two pages: "alpha beta" sits on page 1 and
// "gamma delta" on page 2. A span from "beta" through "gamma" straddles the
// page break.
const CROSS_PAGE_LAYER: AnchoredText = {
  text: 'alpha beta\ngamma delta',
  items: [
    { start: 0,  end: 5,  page: 1, x: 72,  y: 720, width: 40, height: 12 }, // alpha (p1)
    { start: 6,  end: 10, page: 1, x: 118, y: 720, width: 34, height: 12 }, // beta  (p1)
    { start: 11, end: 16, page: 2, x: 72,  y: 720, width: 45, height: 12 }, // gamma (p2)
    { start: 17, end: 22, page: 2, x: 125, y: 720, width: 42, height: 12 }, // delta (p2)
  ],
};

// LAYER, with one character of leading text inserted — the shape a
// re-extraction takes if it ever emits one more (or one fewer) character
// before the same visual span. Every offset shifts by one; the GEOMETRY is
// untouched, because the words are still drawn in the same places.
const SHIFTED_LAYER: AnchoredText = {
  text: ' alpha beta\ngamma delta',
  items: [
    { start: 1,  end: 6,  page: 1, x: 72,  y: 720, width: 40, height: 12 }, // alpha
    { start: 7,  end: 11, page: 1, x: 118, y: 720, width: 34, height: 12 }, // beta
    { start: 12, end: 17, page: 1, x: 72,  y: 700, width: 45, height: 12 }, // gamma
    { start: 18, end: 23, page: 1, x: 125, y: 700, width: 42, height: 12 }, // delta
  ],
};

const pdf = (anchored: AnchoredText, motivation: Motivation, span: TextSpan, body?: Annotation['body']): Annotation =>
  annotationOfSpan({ anchored, resourceId: RID, generator: GENERATOR, motivation, span, body });
const fragments = (annotation: Annotation) => selectors(annotation).filter((selector) => selector.type === 'FragmentSelector');
const quotes = (annotation: Annotation) => selectors(annotation).filter((selector) => selector.type === 'TextQuoteSelector');
const positions = (annotation: Annotation) => selectors(annotation).filter((selector) => selector.type === 'TextPositionSelector');

describe('a PDF annotation is identified by offsets it does not carry', () => {
  // `annotationOfSpan` stores NO TextPositionSelector for a span of a PDF —
  // the anchored text is derived, and an offset into it is no durable anchor —
  // and hashes the id over exactly those offsets.
  //
  // So two builds of the SAME visual span, against two extractions that differ
  // only by a leading character, produce annotations that are identical in every
  // stored field and different in `id`. Every dedupe layer keys on `id` and
  // therefore lets both through, correctly; the identity is wrong upstream, and
  // an operator sees duplicates with no error anywhere.
  //
  // This test pins that behavior, and it is written to be FLIPPED if the
  // identity is ever moved onto the durable anchor: the two ids would then be
  // equal and the assertion below becomes `toBe`.
  const span = { exact: 'gamma', start: 11, end: 16 };
  const shifted = { exact: 'gamma', start: 12, end: 17 };

  it('mints a DIFFERENT id for the same span when the extraction shifts by one character', () => {
    const a = pdf(LAYER, 'highlighting', span);
    const b = pdf(SHIFTED_LAYER, 'highlighting', shifted);

    expect(a.id).not.toBe(b.id);
  });

  it('…while every field it actually STORES is identical — which is why the drift has no signature', () => {
    const a = pdf(LAYER, 'highlighting', span);
    const b = pdf(SHIFTED_LAYER, 'highlighting', shifted);

    // Geometry: same page, same rectangle — the span did not move on the page.
    expect(fragments(b)).toEqual(fragments(a));
    // Quoted text: same.
    expect(quotes(b)).toEqual(quotes(a));
    // And neither carries the offsets their ids were computed from.
    for (const annotation of [a, b]) {
      expect(positions(annotation)).toEqual([]);
    }
  });
});

describe('annotationOfSpan over a PDF\'s anchored text', () => {
  it('single-line span -> one FragmentSelector + a TextQuoteSelector, and no TextPositionSelector', () => {
    const annotation = pdf(LAYER, 'highlighting', { exact: 'alpha beta', start: 0, end: 10 });
    expect(fragments(annotation)).toEqual([
      { type: 'FragmentSelector', conformsTo: 'http://tools.ietf.org/rfc/rfc3778', value: 'page=1&viewrect=72,720,80,12' },
    ]);
    expect(quotes(annotation)).toEqual([{ type: 'TextQuoteSelector', exact: 'alpha beta' }]);
    expect(positions(annotation)).toEqual([]);
    expect(annotation.motivation).toBe('highlighting');
  });

  it('multi-line span -> one FragmentSelector per line (2), each a distinct viewrect', () => {
    const found = fragments(pdf(LAYER, 'highlighting', { exact: 'beta\ngamma', start: 6, end: 16 }));
    expect(found).toHaveLength(2);
    expect(new Set(found.map((fragment) => fragment.value)).size).toBe(2);
  });

  it('TextQuoteSelector carries exact + optional prefix/suffix', () => {
    const annotation = pdf(LAYER, 'highlighting', { exact: 'beta', start: 6, end: 10, prefix: 'alpha ', suffix: '\ngamma' });
    expect(quotes(annotation)).toEqual([{ type: 'TextQuoteSelector', exact: 'beta', prefix: 'alpha ', suffix: '\ngamma' }]);
  });

  it('refuses a span whose covered text does not have exact in it', () => {
    let refusal: unknown;
    try {
      pdf(LAYER, 'highlighting', { exact: 'zzz not present', start: 0, end: 5 });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SpanRefusedError);
    expect(refusal).toMatchObject({ code: 'exact-not-covered' });
  });

  it('holds exact to the covered text with white space apart (a space where the text breaks a line)', () => {
    // `exact` uses a single space where the anchored text has a line break.
    const annotation = pdf(LAYER, 'highlighting', { exact: 'beta gamma', start: 6, end: 16 });
    expect(fragments(annotation).length).toBeGreaterThanOrEqual(1);
  });

  it('attaches a body when provided (e.g. commenting)', () => {
    const body: Annotation['body'] = { type: 'TextualBody', value: 'a note', format: 'text/plain' };
    expect(pdf(LAYER, 'commenting', { exact: 'alpha', start: 0, end: 5 }, body).body).toEqual(body);
  });

  it('linking motivation carries its detection-time body through the shared geometry', () => {
    // At detection time a linking reference's body is the entity type as a
    // TextualBody (the SpecificResource target is appended later, at bind). The
    // geometry is as a highlight's; only motivation + body differ.
    const body: Annotation['body'] = { type: 'TextualBody', value: 'Person', purpose: 'tagging', format: 'text/plain' };
    const annotation = pdf(LAYER, 'linking', { exact: 'gamma delta', start: 11, end: 22 }, body);
    expect(annotation.motivation).toBe('linking');
    expect(annotation.body).toEqual(body);
    expect(fragments(annotation).length).toBeGreaterThanOrEqual(1);
    expect(quotes(annotation)).toHaveLength(1);
    expect(positions(annotation)).toEqual([]);
  });

  it('carries an array body (as commenting/tagging pass) unchanged', () => {
    // A comment and a tag are built with an ARRAY of bodies; either shape
    // (single object | array) is carried through verbatim.
    const body: Annotation['body'] = [
      { type: 'TextualBody', value: 'Rule',   purpose: 'tagging',    format: 'text/plain' },
      { type: 'TextualBody', value: 'a note', purpose: 'commenting', format: 'text/plain' },
    ];
    const annotation = pdf(LAYER, 'tagging', { exact: 'alpha', start: 0, end: 5 }, body);
    expect(annotation.body).toEqual(body);
    expect(Array.isArray(annotation.body)).toBe(true);
  });

  it('cross-page: a span straddling a page break yields one FragmentSelector per page', () => {
    // "beta\ngamma" (offsets 6..16) — beta on page 1, gamma on page 2.
    const annotation = pdf(CROSS_PAGE_LAYER, 'highlighting', { exact: 'beta\ngamma', start: 6, end: 16 });
    const found = fragments(annotation);
    expect(found).toHaveLength(2);
    // One viewrect on page 1, one on page 2 (order-independent).
    const pages = found.map((fragment) => fragment.value.match(/^page=(\d+)&/)?.[1]).sort();
    expect(pages).toEqual(['1', '2']);
    // The covered text spans the break: 'beta\ngamma' has the exact in it, and
    // the span is not refused.
    expect(quotes(annotation)).toEqual([{ type: 'TextQuoteSelector', exact: 'beta\ngamma' }]);
    expect(positions(annotation)).toEqual([]);
  });
});

describe('the span reconcile finds is the span annotationOfSpan takes', () => {
  it('makes, in two calls, an annotation whose selectors are the text\'s own', () => {
    const text = '😀 Ada Lovelace wrote the first algorithm.';
    // The model's letter case is not the text's, and its prefix is not in the text at all.
    const span = reconcile(text, { exact: 'ada lovelace', prefix: 'nothing the text has ' });
    if (span === null) throw new Error('the words are in the text');

    const annotation = annotationOfSpan({ text, resourceId: RID, generator: GENERATOR, motivation: 'highlighting', span });
    expect(selectors(annotation)).toEqual([
      { type: 'TextPositionSelector', start: 2, end: 14 },
      { type: 'TextQuoteSelector', exact: 'Ada Lovelace', prefix: '😀 ', suffix: ' wrote the first algorithm.' },
    ]);
    // How the span was found is the caller's to log, and no member of the annotation.
    expect(span).toMatchObject({ anchorMethod: 'fuzzy-match', matchQuality: 'case-insensitive' });
    expect(JSON.stringify(annotation)).not.toMatch(/anchorMethod|matchQuality|fuzzy-match|case-insensitive/);
  });
});
