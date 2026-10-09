import { describe, it, expectTypeOf } from 'vitest';
import type { processGenerationJob } from '../processors';

describe('a generation states no result before its resource exists', () => {
  it('the processor answers what it knows: the artifact, and whether it was cut off', () => {
    // What it answers when no cancellation stopped it.
    type Generated = Exclude<Awaited<ReturnType<typeof processGenerationJob>>, { cancelled: true }>;
    expectTypeOf<Generated['truncated']>().toEqualTypeOf<boolean>();
    expectTypeOf<Generated>().not.toHaveProperty('result');
  });
});
