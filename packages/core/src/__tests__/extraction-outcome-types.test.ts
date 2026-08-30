/**
 * Type-level guard — PERSIST-ANCHORS P2a (D1's wire half).
 *
 * The stored/served anchored-text RECORD is the full extraction outcome —
 * success (`AnchoredText` + `method`/`pdfClass`/`ocrConfidence`/`unreadPages`)
 * or a named decline — not the bare `AnchoredText`. Pins all three wire
 * surfaces: the PUT body at `/anchored-text/{checksum}`, the GET response at
 * `/resources/{id}/anchored-text`, and the `browse:anchored-text-result`
 * reply. `AnchoredText` itself survives as the base vocabulary shape; what
 * this guard forbids is the ROUTE carrying it bare (a body without `method`
 * or `declined` must not typecheck).
 *
 * `ocrConfidence` is carried in the record deliberately (stored ≠ wire for
 * any *other* consumer surface — OCR-CONFIDENCE-LOST's open question stays
 * open). Enforced by `tsc --noEmit`; red before the spec + regen land, green
 * after.
 */
import { describe, it, expect } from 'vitest';
import type { components } from '../types';

// The HTTP faces are gone (ANCHORED-TEXT-TO-SMELTER P4): the store is reached
// over the bus, so the wire shapes this pins are the CHANNEL payloads. The
// union itself is unchanged — only the surfaces carrying it shrank.
type Outcome = components['schemas']['ExtractionOutcome'];
type BrowseReply = components['schemas']['BrowseAnchoredTextResult']['response'];

/**
 * A2/A3's shape for THIS union — WIRE-UNION-DISCRIMINANTS P5c (D6: Option A).
 * Both members carry a single-valued `kind`; a consumer narrows without a
 * type assertion, and an unhandled member is a compile error. Before this,
 * success carried `method` and the decline carried `declined` with NO shared
 * property — Defect 2's shape, which forced the `Exclude`/`Extract` probes
 * this phase deletes from the store.
 */
function describeOutcome(o: Outcome): string {
  switch (o.kind) {
    case 'extracted':
      return `${o.method}: ${o.text.length} chars`;
    case 'declined':
      return o.declined;
    default: {
      const unhandled: never = o;
      return unhandled;
    }
  }
}

describe('ExtractionOutcome — the union discriminates (P5c)', () => {
  it('narrows both members by kind, castless', () => {
    expect(describeOutcome({ kind: 'extracted', text: 'abc', items: [], method: 'ocr' })).toBe('ocr: 3 chars');
    expect(describeOutcome({ kind: 'declined', declined: 'encrypted' })).toBe('encrypted');
  });
});

describe('anchored-text record — extraction outcome guard (P2a)', () => {
  it('a success outcome carries geometry plus provenance', () => {
    const success: Outcome = {
      kind: 'extracted',
      text: 'scanned words',
      items: [],
      method: 'ocr',
      pdfClass: 'B',
      ocrConfidence: { mean: 91.2, lowConfidenceWords: 3, totalWords: 120 },
      unreadPages: [4],
    };
    expect(success).toBeDefined();
  });

  it('a named decline is a first-class, cacheable outcome', () => {
    const decline: Outcome = { kind: 'declined', declined: 'no-text-layer' };
    expect(decline).toBeDefined();
  });

  it('the bus reply carries the outcome', () => {
    const outcome: Outcome = { kind: 'extracted', text: 't', items: [], method: 'pdf-text-layer' };
    const browse: BrowseReply = outcome;
    const browseNull: BrowseReply = null;
    expect({ browse, browseNull }).toBeDefined();
  });
});
