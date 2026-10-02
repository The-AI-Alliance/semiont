import { describe, it, expectTypeOf } from 'vitest';
import type { EventMap } from '@semiont/core';
import type { ActiveJob } from '../job-claim-adapter';
import type { processGenerationJob } from '../processors';

/**
 * tsc-enforced contract for the job a worker holds: it is the record a
 * `job:claimed` reply carries, as the spec types it (`JobRunning`), read field
 * by field. Nothing between the reply and the worker restates that shape, so
 * a field cannot be typed wider here than the spec types it there — a job's
 * type is a `JobType` and not text to be recognised again, and its params are
 * the record's params, with the resource they name.
 */
type Claimed = EventMap['job:claimed']['response'];

describe('the job a worker holds is the claimed record', () => {
  it('each field has the type of the field it is read from', () => {
    expectTypeOf<ActiveJob['jobId']>().toEqualTypeOf<Claimed['metadata']['id']>();
    expectTypeOf<ActiveJob['type']>().toEqualTypeOf<Claimed['metadata']['type']>();
    expectTypeOf<ActiveJob['resourceId']>().toEqualTypeOf<Claimed['params']['resourceId']>();
    expectTypeOf<ActiveJob['params']>().toEqualTypeOf<Claimed['params']>();
    expectTypeOf<ActiveJob['retryCount']>().toEqualTypeOf<Claimed['metadata']['retryCount']>();
    expectTypeOf<ActiveJob['maxRetries']>().toEqualTypeOf<Claimed['metadata']['maxRetries']>();
    expectTypeOf<ActiveJob['completedUnits']>().toEqualTypeOf<NonNullable<Claimed['metadata']['completedUnits']>>();
    expectTypeOf<ActiveJob['unitCursors']>().toEqualTypeOf<NonNullable<Claimed['metadata']['unitCursors']>>();
  });
});

describe('a generation states no result before its resource exists', () => {
  it('the processor answers what it knows: the artifact, and whether it was cut off', () => {
    type Generated = Awaited<ReturnType<typeof processGenerationJob>>;
    expectTypeOf<Generated['truncated']>().toEqualTypeOf<boolean>();
    expectTypeOf<Generated>().not.toHaveProperty('result');
  });
});
