/**
 * The process reports its own ceiling.
 *
 * Node's default old-space ceiling sits well below a container's allotment
 * (about 1016 MB inside a 2048 MB container), and a process dies at its OWN
 * ceiling, not the container's.
 *
 * `heapLimit` is the one that matters most and is the least obvious: it is
 * what the process will actually die at, and it is also how you verify a
 * configured `--max-old-space-size` took effect at all.
 */

import { describe, it, expect } from 'vitest';
import { heapStats } from '../runtime-stats';

describe('heapStats', () => {
  it('reports used, total, limit and rss as positive numbers', () => {
    const s = heapStats();

    for (const key of ['heapUsed', 'heapTotal', 'heapLimit', 'rss'] as const) {
      expect(typeof s[key]).toBe('number');
      expect(s[key]).toBeGreaterThan(0);
    }
  });

  it('reports a limit that used is measured against — the number the process dies at', () => {
    const s = heapStats();

    expect(s.heapUsed).toBeLessThanOrEqual(s.heapLimit);
    // The pair is the point: `used` alone cannot say how close to death the
    // process is, and `limit` is what a configured cap changes.
    expect(s.heapTotal).toBeLessThanOrEqual(s.heapLimit);
  });

  it('is a fresh reading each call, not a cached snapshot', () => {
    const a = heapStats();
    const churn: unknown[] = [];
    for (let i = 0; i < 20000; i++) churn.push({ i, pad: 'x'.repeat(20) });
    const b = heapStats();

    expect(churn.length).toBe(20000);
    expect(b.heapUsed).not.toBe(a.heapUsed);
  });
});
