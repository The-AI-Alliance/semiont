/**
 * The dedupe decider is ONE mechanism (`makeSpanDeduper`), five call sites.
 * The failure mode this gate prevents is a half-migration: a post-pass
 * reintroduced beside the seen-set means overlap duplicates survive on
 * exactly one path, which no per-loop unit test notices. Source-level on
 * purpose — only the source can say there is one mechanism.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf-8');

describe('the dedupe decider moved, it did not multiply (RD3)', () => {
  it('the batch post-pass is gone from every detection source', () => {
    for (const rel of ['processors.ts', 'workers/annotation-detection.ts', 'workers/detection/entity-extractor.ts']) {
      const calls = read(rel).match(/dedupeAnnotations\(/g) ?? [];
      expect(calls, `${rel} calls dedupeAnnotations — the post-pass is the OLD decider`).toEqual([]);
    }
  });

  it('one seen-set per emission stream: exactly five call sites, one per detection type', () => {
    const src = read('processors.ts');
    const calls = (src.match(/= makeSpanDeduper\(\)/g) ?? []).length;
    expect(calls, 'a detection type gained or lost its deduper — five streams, five sites').toBe(5);
    for (const rel of ['workers/annotation-detection.ts', 'workers/detection/entity-extractor.ts']) {
      const loopCalls = read(rel).match(/makeSpanDeduper\(/g) ?? [];
      expect(loopCalls, `${rel} must not hold a second decider (prose mentions are fine; calls are not)`).toEqual([]);
    }
  });
});
