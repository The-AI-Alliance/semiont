/**
 * ContentExtractor registry — Phase 0 (SMELTER-MEDIA-TYPES.md, #743).
 *
 * The registry resolves by `TextExtraction` strategy, consuming core's
 * media-type vocabulary directly — no second media-type table. Phase 0
 * fills only the 'decode' slot (passthrough over `decodeRepresentation`,
 * today's exact behavior, now scoped); 'pdf-text-layer' stays null until
 * Phase 1 (#744) fills it.
 */

import { describe, it, expect } from 'vitest';
import { EXTRACTORS } from '../content-extractor';

describe('EXTRACTORS registry (Phase 0)', () => {
  it("resolves 'decode' to the passthrough extractor", () => {
    expect(EXTRACTORS['decode']).not.toBeNull();
  });

  it("resolves 'pdf-text-layer' to the pdf extractor (Phase 1, #744)", () => {
    expect(EXTRACTORS['pdf-text-layer']).not.toBeNull();
  });

  it("resolves 'none' to null — nothing to extract", () => {
    expect(EXTRACTORS['none']).toBeNull();
  });
});

describe('passthrough extractor', () => {
  it('decodes UTF-8 bytes verbatim as text-passthrough', async () => {
    const text = '# Heading\n\nStig Dagerman — swedish prose, naïve façade.';
    const ex = EXTRACTORS['decode'];
    expect(ex).not.toBeNull();
    const out = await ex!.extract(Buffer.from(text, 'utf8'), 'text/markdown');
    expect(out).toEqual({ text, method: 'text-passthrough' });
  });

  it('honors the charset parameter via decodeRepresentation', async () => {
    // 'café' in ISO-8859-1 is a single 0xE9 byte for é — a UTF-8 decode
    // would mangle it, so this pins the charset-aware path.
    const latin1 = Buffer.from('café', 'latin1');
    const ex = EXTRACTORS['decode'];
    expect(ex).not.toBeNull();
    const out = await ex!.extract(latin1, 'text/plain; charset=iso-8859-1');
    if ('declined' in out) throw new Error('unexpected decline');
    expect(out.text).toBe('café');
    expect(out.method).toBe('text-passthrough');
  });
});
