/**
 * Annotation ids are content-addressed — hashed from the resource,
 * motivation, anchor and body — so re-emitting an annotation is a no-op. This
 * pins that at the level a recovery sees it: run the same unit twice against
 * one resource; the annotation count is unchanged the second time.
 *
 * The core test pins the id FUNCTION. This one pins the builders. Between
 * them sits the wiring — which fields each builder feeds the hash — and that
 * wiring is what a recovery depends on. A builder that forgot to pass `body`
 * would still produce deterministic ids and still pass every core test, while
 * silently collapsing every comment on a span into one annotation.
 */

import { describe, it, expect } from 'vitest';
import { buildTextAnnotation, buildPdfAnnotation, type SpanMatch } from '../processors';
import { resourceId, textOffsets } from '@semiont/core';
import type { AnchoredText, components } from '@semiont/core';

// Sourced from the generated schema the way processors.ts does — `Agent` is
// not a named export of @semiont/core.
type Agent = components['schemas']['Agent'];

const RID = resourceId('res-idem');
const GENERATOR = { '@type': 'Software', '@id': 'did:web:example.com:agents:ollama:test' } as unknown as Agent;

const CONTENT = 'Ada Lovelace wrote the first algorithm.';
const match = (start: number, end: number): SpanMatch => ({
  exact: CONTENT.slice(start, end),
  start,
  end,
});

const comment = (value: string) => [
  { type: 'TextualBody' as const, value, purpose: 'commenting' as const, format: 'text/plain' as const },
];

const build = (m: SpanMatch, motivation: Parameters<typeof buildTextAnnotation>[4], body?: unknown) =>
  buildTextAnnotation(CONTENT, textOffsets(CONTENT), RID, GENERATOR, motivation, m, body as never);

describe('re-running a unit does not mint duplicate annotations', () => {
  it('the same span, motivation and body yields the SAME id', () => {
    // The whole point: a janitor-recovered job re-emits this and the record
    // already holds it.
    const first = build(match(0, 12), 'commenting', comment('an author'));
    const second = build(match(0, 12), 'commenting', comment('an author'));
    expect(second.id).toBe(first.id);
  });

  it('survives re-emission at a different time by a different agent', () => {
    // Recovery happens later, in a fresh worker process. If `created` or the
    // generator leaked into the id, every recovery would duplicate.
    const other = { '@type': 'Software', '@id': 'did:web:example.com:agents:ollama:OTHER' } as unknown as Agent;
    const first = buildTextAnnotation(CONTENT, textOffsets(CONTENT), RID, GENERATOR, 'highlighting', match(0, 12));
    const second = buildTextAnnotation(CONTENT, textOffsets(CONTENT), RID, other, 'highlighting', match(0, 12));
    expect(second.id).toBe(first.id);
  });

  it('a whole unit re-run leaves the id set unchanged', () => {
    const unit = () => [
      build(match(0, 12), 'commenting', comment('an author')),
      build(match(13, 18), 'commenting', comment('a verb')),
      build(match(0, 12), 'highlighting'),
    ].map((a) => a.id);

    expect(new Set([...unit(), ...unit()]).size).toBe(3);
  });

  // ── the wiring the core test cannot see ───────────────────────────────

  it('two DIFFERENT comments on one span stay two annotations', () => {
    // The collision a comment's id must avoid: two annotations on one span that
    // differ only by body. Fails if the builder omits `body` from the hash.
    const a = build(match(0, 12), 'commenting', comment('an author'));
    const b = build(match(0, 12), 'commenting', comment('a mathematician'));
    expect(b.id).not.toBe(a.id);
  });

  it('different spans stay different annotations', () => {
    expect(build(match(13, 18), 'highlighting').id).not.toBe(build(match(0, 12), 'highlighting').id);
  });

  it('the same span under different motivations stays two annotations', () => {
    const h = build(match(0, 12), 'highlighting');
    const c = build(match(0, 12), 'commenting', comment('note'));
    expect(c.id).not.toBe(h.id);
  });

  it('the same offsets over DIFFERENT text is a different annotation', () => {
    // After a content update the offsets survive but no longer quote the same
    // words; `exact` is in the anchor so that is not silently the same one.
    const shifted = buildTextAnnotation(
      'Grace Hopper wrote the first compiler.', textOffsets('Grace Hopper wrote the first compiler.'), RID, GENERATOR,
      'highlighting', { exact: 'Grace Hopper', start: 0, end: 12 },
    );
    expect(shifted.id).not.toBe(build(match(0, 12), 'highlighting').id);
  });

  it('the PDF builder agrees with the text builder on identity', () => {
    // Same span, same motivation, same body ⇒ same annotation, whichever
    // builder anchored it. The PDF path persists geometry the text path does
    // not, but geometry is DERIVED from these offsets and adds no identity.
    const anchored = {
      text: CONTENT,
      items: [{ page: 1, start: 0, end: CONTENT.length, x: 10, y: 700, width: 300, height: 12 }],
    } as unknown as AnchoredText;

    const pdf = buildPdfAnnotation(anchored, textOffsets(anchored.text), RID, GENERATOR, 'highlighting', match(0, 12));
    const text = build(match(0, 12), 'highlighting');
    expect(pdf.id).toBe(text.id);
  });
});
