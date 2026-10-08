import { describe, it, expectTypeOf } from 'vitest';
import type { processGenerationJob } from '../processors';

describe('a generation states no result before its resource exists', () => {
  it('the processor answers what it knows: the artifact, and whether it was cut off', () => {
    type Generated = Awaited<ReturnType<typeof processGenerationJob>>;
    expectTypeOf<Generated['truncated']>().toEqualTypeOf<boolean>();
    expectTypeOf<Generated>().not.toHaveProperty('result');
  });
});
