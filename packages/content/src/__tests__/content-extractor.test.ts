/**
 * Deriving text, and who is allowed to (SMELTER-MEDIA-TYPES #743;
 * READ-VS-EXTRACT P1/P2).
 *
 * The strategy-keyed `EXTRACTORS` registry these tests used to cover is gone.
 * It held one real extractor and a one-line wrapper around core's
 * `decodeRepresentation` — whose own behavior (UTF-8, charset parameters, the
 * no-charset default) is tested in `@semiont/core`'s `resource-utils.test.ts`,
 * so the wrapper's tests were duplicating that through an indirection and left
 * with it.
 *
 * What is covered here is what remains: which media types need deriving, that
 * deriving cannot be reached without the store that persists it, and that core's
 * geometry answer matches what actually runs.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { yieldsGeometryOf, decodeRepresentation, type TextExtraction, type ExtractionOutcome } from '@semiont/core';
import { derivingExtractorFor } from '../content-extractor';
import type { AnchoredTextStore } from '../anchored-text-store';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('derivingExtractorFor (READ-VS-EXTRACT P2)', () => {
  it('answers for the one media type whose text must be derived', () => {
    expect(derivingExtractorFor('application/pdf')).not.toBeNull();
  });

  it('answers null for text — decoding is not deriving, and is core\'s job', () => {
    // The deleted registry returned a passthrough extractor here, making
    // "decode UTF-8" and "OCR a scan" the same call. Callers now reach
    // `decodeRepresentation` in @semiont/core directly, as five sites in
    // @semiont/make-meaning already did.
    expect(derivingExtractorFor('text/markdown')).toBeNull();
    expect(derivingExtractorFor('text/plain')).toBeNull();
    expect(derivingExtractorFor('application/json')).toBeNull();
  });

  it('answers null where there is no text at all', () => {
    expect(derivingExtractorFor('image/png')).toBeNull();
  });

  it('tolerates parameters and case, like the core accessor it reads', () => {
    expect(derivingExtractorFor('application/pdf; version=1.7')).not.toBeNull();
    expect(derivingExtractorFor('APPLICATION/PDF')).not.toBeNull();
  });
});

describe('deriving requires the store that persists what it derives (READ-VS-EXTRACT P2)', () => {
  // The ownership rule, enforced by the type rather than by a convention: an
  // `ExtractionCache` carries an `AnchoredTextStore`, only the Smelter holds
  // one, so only the Smelter can call this. A worker cannot derive by accident
  // because it cannot construct the argument.
  //
  // These assertions are the COMPILER's — `@ts-expect-error` fails `tsc` if the
  // call ever starts type-checking, which is exactly the regression to catch.
  // Nothing is invoked; a runtime guard would be the fifth thing to remember,
  // and remembering is what this phase removes.
  it('does not type-check without a cache', () => {
    const extractor = derivingExtractorFor('application/pdf')!;
    const call = () =>
      // @ts-expect-error - deriving without the store is not reachable (P2)
      extractor.extract(Buffer.from(''), 'application/pdf');
    expect(typeof call).toBe('function');
  });

  it('type-checks with one', () => {
    const extractor = derivingExtractorFor('application/pdf')!;
    const store = { read: async () => undefined, write: async () => {} } as unknown as AnchoredTextStore;
    const call = () => extractor.extract(Buffer.from(''), 'application/pdf', { key: 'k', store });
    expect(typeof call).toBe('function');
  });
});

/**
 * The census gate for READ-VS-EXTRACT P1, restated against P2's shape.
 *
 * P1 deleted the `yieldsGeometry` boolean each extractor declared and made core's
 * `yieldsGeometryOf` the single home. That removes the chance of two
 * *declarations* disagreeing, but not the thing that matters: core can still be
 * wrong about what the code DOES. So the gate is behavioral — for every strategy,
 * check that positioned runs appear exactly where core says they will.
 *
 * Asserting core's answer against a second hand-written table would be a mirror;
 * asserting it against what actually runs cannot be.
 */
describe("core's geometry answer matches what actually runs (READ-VS-EXTRACT P1/P2)", () => {
  // Keyed by strategy, so a strategy added in core fails to compile here until
  // someone decides which media type exercises it.
  const PROBES: Record<TextExtraction, { mediaType: string; bytes: (() => Buffer) | null }> = {
    'decode': { mediaType: 'text/markdown', bytes: () => Buffer.from('# just text\n') },
    'pdf-text-layer': {
      mediaType: 'application/pdf',
      bytes: () => fs.readFileSync(path.join(FIXTURES, 'single-line.pdf')),
    },
    // Nothing reads this type at all; core must still answer.
    'none': { mediaType: 'image/png', bytes: null },
  };

  const memoryStore = (): AnchoredTextStore => {
    const kept = new Map<string, ExtractionOutcome>();
    return {
      read: async (key: string) => kept.get(key),
      write: async (key: string, outcome: ExtractionOutcome) => { kept.set(key, outcome); },
    } as unknown as AnchoredTextStore;
  };

  for (const [strategy, probe] of Object.entries(PROBES) as [TextExtraction, typeof PROBES['decode']][]) {
    it(`'${strategy}': positioned runs appear iff core says the type yields geometry`, async () => {
      const extractor = derivingExtractorFor(probe.mediaType);

      if (!probe.bytes) {
        expect(extractor).toBeNull();
        expect(yieldsGeometryOf(probe.mediaType)).toBe(false);
        return;
      }

      // Whether a deriving extractor exists at all is itself the geometry
      // answer — P2 keyed the accessor on `yieldsGeometryOf`, so this pins the
      // two together before either is run.
      expect(extractor !== null).toBe(yieldsGeometryOf(probe.mediaType));

      if (!extractor) {
        // The decode route: core's own function, the same call the Smelter and
        // the detection worker make. A string, never geometry.
        const text = decodeRepresentation(probe.bytes(), probe.mediaType);
        expect(typeof text).toBe('string');
        expect(yieldsGeometryOf(probe.mediaType)).toBe(false);
        return;
      }

      const out = await extractor.extract(probe.bytes(), probe.mediaType, { key: 'probe', store: memoryStore() });
      if (out.kind === 'declined') throw new Error(`probe for '${strategy}' declined: ${out.declined}`);

      const carriesGeometry = (out.items?.length ?? 0) > 0;
      expect(carriesGeometry).toBe(yieldsGeometryOf(probe.mediaType));
    });
  }
});
