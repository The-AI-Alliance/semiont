/**
 * ContentExtractor registry — Phase 0 (SMELTER-MEDIA-TYPES.md, #743).
 *
 * The registry resolves by `TextExtraction` strategy, consuming core's
 * media-type vocabulary directly — no second media-type table. Phase 0
 * fills only the 'decode' slot (passthrough over `decodeRepresentation`,
 * today's exact behavior, now scoped); 'pdf-text-layer' stays null until
 * Phase 1 (#744) fills it.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { yieldsGeometryOf, type TextExtraction } from '@semiont/core';
import { EXTRACTORS } from '../content-extractor';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

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
    expect(out).toEqual({ kind: 'extracted', text, method: 'text-passthrough' });
  });

  it('honors the charset parameter via decodeRepresentation', async () => {
    // 'café' in ISO-8859-1 is a single 0xE9 byte for é — a UTF-8 decode
    // would mangle it, so this pins the charset-aware path.
    const latin1 = Buffer.from('café', 'latin1');
    const ex = EXTRACTORS['decode'];
    expect(ex).not.toBeNull();
    const out = await ex!.extract(latin1, 'text/plain; charset=iso-8859-1');
    if (out.kind === 'declined') throw new Error('unexpected decline');
    expect(out.text).toBe('café');
    expect(out.method).toBe('text-passthrough');
  });
});

/**
 * The census gate for READ-VS-EXTRACT P1.
 *
 * `yieldsGeometry` used to be a boolean declared on each extractor, beside the
 * implementations, in this package — while the strategy that determines it lives
 * in core's media-type registry. Two homes for one fact. P1 deleted the boolean
 * and made core's `yieldsGeometryOf` the single home.
 *
 * That removes the possibility of the two *declarations* disagreeing, but not the
 * thing that actually matters: core can still be wrong about what an extractor
 * DOES. So the gate is behavioral — run each strategy's extractor and check that
 * positioned runs appear exactly where core says they will. Asserting core's
 * answer against a second hand-written table would be a mirror; asserting it
 * against the extractor's output cannot be.
 */
describe('core\'s geometry answer matches what the extractors produce (READ-VS-EXTRACT P1)', () => {
  // Keyed by strategy, so a strategy added in core fails to compile here until
  // someone decides which media type exercises it — the same exhaustiveness
  // `EXTRACTORS: Record<TextExtraction, …>` already gives the registry itself.
  // `bytes: null` means the strategy runs nothing; core must still answer.
  const PROBES: Record<TextExtraction, { mediaType: string; bytes: (() => Buffer) | null }> = {
    'decode': { mediaType: 'text/markdown', bytes: () => Buffer.from('# just text\n') },
    'pdf-text-layer': {
      mediaType: 'application/pdf',
      bytes: () => fs.readFileSync(path.join(FIXTURES, 'single-line.pdf')),
    },
    'none': { mediaType: 'image/png', bytes: null },
  };

  for (const [strategy, probe] of Object.entries(PROBES) as [TextExtraction, { mediaType: string; bytes: (() => Buffer) | null }][]) {
    it(`'${strategy}': positioned runs appear iff core says the type yields geometry`, async () => {
      const extractor = EXTRACTORS[strategy];

      if (!probe.bytes) {
        // The strategy names a capability nothing provides, so there is no
        // behavior to compare against — only that both sides agree there is none.
        expect(extractor).toBeNull();
        expect(yieldsGeometryOf(probe.mediaType)).toBe(false);
        return;
      }

      expect(extractor).not.toBeNull();
      const out = await extractor!.extract(probe.bytes(), probe.mediaType);
      if (out.kind === 'declined') throw new Error(`probe for '${strategy}' declined: ${out.declined}`);

      const carriesGeometry = (out.items?.length ?? 0) > 0;
      expect(carriesGeometry).toBe(yieldsGeometryOf(probe.mediaType));
    });
  }
});
