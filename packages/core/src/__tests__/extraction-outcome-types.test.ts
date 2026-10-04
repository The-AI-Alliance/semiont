/**
 * Type-level guard — the anchored-text record is the extraction outcome, as
 * the wire carries it.
 *
 * The reply half was amended since: `BrowseAnchoredTextResult.response`
 * is `AnchoredTextAnswer`, which widens this union with named absences and is
 * never null. The STORED record is untouched and is still what this file pins.
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
 * any *other* consumer surface — whether a viewer should tell a reader how
 * well a scan was read stays an open question). Enforced by `tsc --noEmit`;
 * red before the spec + regen land, green after.
 */
import { describe, it, expect } from 'vitest';
import type { components } from '../types';

// The HTTP faces are gone: the store is reached only over the bus, so the
// wire shapes this pins are the CHANNEL payloads. The union itself is
// unchanged — only the surfaces carrying it shrank.
type Outcome = components['schemas']['ExtractionOutcome'];
type BrowseReply = components['schemas']['BrowseAnchoredTextResult']['response'];

/**
 * Axioms A2 and A3 of job-result-types.test.ts, for THIS union. Both members
 * carry a single-valued `kind` — a two-member discriminant, with the decline's
 * reason enum kept as its detail; a consumer narrows without a type
 * assertion, and an unhandled member is a compile error. Before this,
 * success carried `method` and the decline carried `declined` with NO shared
 * property — a union with nothing in band to switch on, which forced
 * `Exclude`/`Extract` probes on the store.
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

describe('ExtractionOutcome — the union discriminates', () => {
  it('narrows both members by kind, castless', () => {
    expect(describeOutcome({ kind: 'extracted', text: 'abc', items: [], method: 'ocr' })).toBe('ocr: 3 chars');
    expect(describeOutcome({ kind: 'declined', declined: 'encrypted' })).toBe('encrypted');
  });
});

describe('anchored-text record — extraction outcome guard', () => {
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
    expect(browse).toBeDefined();
  });

  it('the bus reply is NEVER null — absence is named', () => {
    // This case previously asserted `const browseNull: BrowseReply = null`.
    // That contract is gone: one `null` covered four facts — barrier expired,
    // settled-skipped, no content identity, fold disposed — two of which a
    // caller should retry and two of which are terminal, and a reader that
    // blocks on this read cannot classify its own failure without knowing
    // which. `AnchoredTextAnswer` names them instead.
    // @ts-expect-error null is no longer an inhabitant of the reply type
    const browseNull: BrowseReply = null;
    expect(browseNull).toBeNull();
  });

  it('the reply widens ExtractionOutcome rather than replacing it', () => {
    // The stored record is unchanged: an outcome is still a valid answer, and
    // the store's own type never gains the absence members — it can hold an
    // extraction or a decline, never a "not yet".
    const stored: Outcome = { kind: 'declined', declined: 'encrypted' };
    const asReply: BrowseReply = stored;
    const absent: BrowseReply = { kind: 'not-yet' };
    expect({ asReply, absent }).toBeDefined();
  });
});
