/**
 * Anchor auditing (DETECTION-QUALITY-THROUGHPUT P5).
 *
 * The mechanical selector-vs-source check is already a write-time invariant in
 * both annotation builders, so it cannot fail and auditing it would measure a
 * constant. The uncertain part is WHICH METHOD anchored a span — and that was
 * visible only as a log line, which is how 47 degraded anchors went unreviewed
 * after the 2026-09-03 run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { recordAnchorOutcomeMock } = vi.hoisted(() => ({ recordAnchorOutcomeMock: vi.fn() }));
vi.mock('@semiont/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@semiont/observability')>()),
  recordAnchorOutcome: recordAnchorOutcomeMock,
}));

import { noteAnchor } from '../../../workers/detection/anchor-audit';

describe('noteAnchor', () => {
  beforeEach(() => recordAnchorOutcomeMock.mockClear());

  it('counts the CLEAN anchors too — without them the degraded count has no denominator', () => {
    noteAnchor('reference', 'Paris', 'unique-match');
    expect(recordAnchorOutcomeMock).toHaveBeenCalledWith('reference', 'unique-match');
  });

  it('counts a degraded anchor and warns about it', () => {
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    noteAnchor('reference', 'Paris', 'first-of-many', logger as never);

    expect(recordAnchorOutcomeMock).toHaveBeenCalledWith('reference', 'first-of-many');
    expect(logger.warn).toHaveBeenCalledWith(
      'Annotation anchored via degraded method',
      expect.objectContaining({ label: 'reference', anchorMethod: 'first-of-many' }),
    );
  });

  it('treats fuzzy-match as degraded and unique-match as clean — one decider, both callers', () => {
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    noteAnchor('comment', 'x', 'fuzzy-match', logger as never);
    noteAnchor('comment', 'y', 'context-recovered', logger as never);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Both were still counted: the rate needs every outcome.
    expect(recordAnchorOutcomeMock).toHaveBeenCalledTimes(2);
  });
});
