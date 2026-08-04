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
import type { components, paths } from '../types';

type Outcome = components['schemas']['ExtractionOutcome'];
type PutBody =
  paths['/anchored-text/{checksum}']['put']['requestBody']['content']['application/json'];
type BrowseReply = components['schemas']['BrowseAnchoredTextResult']['response'];
type GetResponse =
  paths['/resources/{id}/anchored-text']['get']['responses']['200']['content']['application/json'];

describe('anchored-text record — extraction outcome guard (P2a)', () => {
  it('a success outcome carries geometry plus provenance', () => {
    const success: Outcome = {
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
    const decline: Outcome = { declined: 'no-text-layer' };
    expect(decline).toBeDefined();
  });

  it('the PUT body and browse/GET replies carry the outcome, and the bare AnchoredText no longer typechecks', () => {
    const outcome: Outcome = { text: 't', items: [], method: 'pdf-text-layer' };
    const put: PutBody = outcome;
    const browse: BrowseReply = outcome;
    const browseNull: BrowseReply = null;
    const got: GetResponse = outcome;

    // The pre-P2a record: geometry with no provenance. Neither branch of the
    // outcome admits it — success requires `method`, a decline requires
    // `declined` — so the route can no longer carry the bare shape.
    // @ts-expect-error — bare { text, items } is not an ExtractionOutcome
    const bare: PutBody = { text: 't', items: [] };

    expect({ put, browse, browseNull, got, bare }).toBeDefined();
  });
});
