/**
 * JobQueue conformance harness (JOB-QUEUE-DRIVER P0).
 *
 * THE suite a driver must pass — contract-level on purpose: everything in
 * here is asserted through the `JobQueue` interface, never through a
 * driver's mechanism. No directory peeking, no mtimes, no SQL, no subjects.
 * With more than one driver, every ambiguity in the contract becomes N
 * divergent behaviors; this file is what stands between the interface and
 * N−1.
 *
 * What is deliberately NOT here:
 *   - `job:queued` announcements — FsJobQueue-era wire protocol, not a
 *     queue-contract obligation (they dissolve under claim-by-type,
 *     JOB-QUEUE-DRIVER P1). Announce behavior is pinned in the fs driver's
 *     own test file.
 *   - `listJobs` / retention (`cleanupOldJobs`) — off the interface; reads
 *     and retention migrate to event-log views (P0).
 *   - Driver construction details (loggers, buses, directories) — the
 *     fixture's concern, hidden behind `open()`.
 *
 * Time is the one thing a contract test cannot reach through the interface,
 * so the fixture provides it: `ageRunningJob` makes a running job look
 * progress-less for longer than the stale window, and `recoverStale` runs
 * one orphan-recovery sweep. Each driver implements those with its own
 * mechanism (fs: mtime; SQL: `last_progress_at`; JetStream: `AckWait`
 * configuration) — the CONTRACT the tests state is mechanism-free.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { JobQueue } from '../job-queue-interface';
import type { PendingJob, RunningJob, CompleteJob, FailedJob, DetectionParams, DetectionProgress } from '../types';
import type { JobReferenceAnnotationResult, GenerationJobParams, JobId } from '@semiont/core';
import { entityType, jobId, userId, resourceId } from '@semiont/core';
import { minimalContext } from './fixtures/generation-fixtures';

/** One test's worth of backing store, plus the two time hooks. */
export interface JobQueueConformanceHarness {
  /** A queue over THIS harness's backing. May be called more than once —
   *  a second open over the same backing is the restart shape. */
  open(): Promise<JobQueue>;
  /** Make a running job look progress-less past the stale window. */
  ageRunningJob(id: JobId): Promise<void>;
  /** Run one orphan-recovery sweep; returns how many jobs were recovered. */
  recoverStale(queue: JobQueue): Promise<number>;
  teardown(): Promise<void>;
}

export interface JobQueueConformanceHooks {
  setup(): Promise<JobQueueConformanceHarness>;
}

// ── Job factories — contract-shaped fixtures, shared with driver files ──────

export function createPendingDetectionJob(id: string): PendingJob<DetectionParams> {
  return {
    status: 'pending',
    metadata: {
      id: jobId(id),
      type: 'reference-annotation',
      userId: userId('did:web:test:users:user-1'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person'), entityType('Organization')],
    },
  };
}

export function createRunningDetectionJob(id: string): RunningJob<DetectionParams, DetectionProgress> {
  return {
    status: 'running',
    metadata: {
      id: jobId(id),
      type: 'reference-annotation',
      userId: userId('did:web:test:users:user-1'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person'), entityType('Organization')],
    },
    startedAt: new Date().toISOString(),
    progress: {
      totalEntityTypes: 2,
      processedEntityTypes: 1,
      entitiesFound: 5,
      entitiesEmitted: 5,
    },
  };
}

export function createCompleteDetectionJob(id: string): CompleteJob<DetectionParams, JobReferenceAnnotationResult> {
  return {
    status: 'complete',
    metadata: {
      id: jobId(id),
      type: 'reference-annotation',
      userId: userId('did:web:test:users:user-1'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person'), entityType('Organization')],
    },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    result: {
      kind: 'reference-annotation',
      totalFound: 10,
      totalEmitted: 10,
      errors: 0,
    },
  };
}

export function createFailedDetectionJob(id: string): FailedJob<DetectionParams> {
  return {
    status: 'failed',
    metadata: {
      id: jobId(id),
      type: 'reference-annotation',
      userId: userId('did:web:test:users:user-1'),
      created: new Date().toISOString(),
      retryCount: 1,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person')],
    },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: 'Test error',
  };
}

export function createPendingGenerationJob(id: string): PendingJob<GenerationJobParams> {
  return {
    status: 'pending',
    metadata: {
      id: jobId(id),
      type: 'generation',
      userId: userId('did:web:test:users:user-1'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      prompt: 'Generate a summary',
      title: 'Summary',
      storageUri: 'file://generated/summary.md',
      context: minimalContext('annotation'),
    },
  };
}

// ── The conformance suite ───────────────────────────────────────────────────

export function runJobQueueConformance(driverName: string, hooks: JobQueueConformanceHooks): void {
  describe(`JobQueue conformance — ${driverName}`, () => {
    let h: JobQueueConformanceHarness;
    let jobQueue: JobQueue;

    beforeEach(async () => {
      h = await hooks.setup();
      jobQueue = await h.open();
    });

    afterEach(async () => {
      await h.teardown();
    });

    describe('createJob() / getJob()', () => {
      test('a created job reads back whole, in every status', async () => {
        const pending = createPendingDetectionJob('job-p');
        const running = createRunningDetectionJob('job-r');
        const generation = createPendingGenerationJob('job-g');
        await jobQueue.createJob(pending);
        await jobQueue.createJob(running);
        await jobQueue.createJob(generation);

        expect(await jobQueue.getJob(jobId('job-p'))).toEqual(pending);
        expect(await jobQueue.getJob(jobId('job-r'))).toEqual(running);
        expect(await jobQueue.getJob(jobId('job-g'))).toEqual(generation);
      });

      test('getJob returns null for a job that does not exist', async () => {
        expect(await jobQueue.getJob(jobId('nonexistent'))).toBeNull();
      });
    });

    describe('claimNextJob() — the one atomic claim, by TYPE (JOB-QUEUE-DRIVER P2)', () => {
      // Contract-level on purpose: everything asserted through the interface,
      // nothing through the mechanism. Claim-by-type replaced claim-by-jobId:
      // an announcement is a WAKE-UP, not a reservation — the claimed job may
      // differ from any announced one, and no ordering among matching pending
      // jobs is promised.

      test('claims a pending job of a requested type: running, startedAt stamped, empty progress', async () => {
        await jobQueue.createJob(createPendingDetectionJob('job-123'));
        await jobQueue.createJob(createPendingGenerationJob('job-gen'));

        const result = await jobQueue.claimNextJob(['reference-annotation']);

        if ('declined' in result) throw new Error(`unexpected decline: ${result.declined}`);
        expect(result.job.metadata.id).toBe(jobId('job-123'));
        expect(result.job.status).toBe('running');
        expect((result.job as { startedAt?: string }).startedAt).toBeTruthy();
        expect((result.job as { progress?: object }).progress).toEqual({});

        expect((await jobQueue.getJob(jobId('job-123')))?.status).toBe('running');
        expect((await jobQueue.getJob(jobId('job-gen')))?.status).toBe('pending');
      });

      test('respects the type filter: no matching pending job declines as none-available', async () => {
        await jobQueue.createJob(createPendingDetectionJob('job-only-detection'));

        expect(await jobQueue.claimNextJob(['generation'])).toEqual({ declined: 'none-available' });
        expect((await jobQueue.getJob(jobId('job-only-detection')))?.status).toBe('pending');
      });

      test('an empty types list accepts any type', async () => {
        await jobQueue.createJob(createPendingGenerationJob('job-any'));

        const result = await jobQueue.claimNextJob([]);
        if ('declined' in result) throw new Error(`unexpected decline: ${result.declined}`);
        expect(result.job.metadata.id).toBe(jobId('job-any'));
      });

      test('declines as none-available when nothing is pending at all', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-already-running'));
        await jobQueue.createJob(createCompleteDetectionJob('job-done'));

        expect(await jobQueue.claimNextJob([])).toEqual({ declined: 'none-available' });
      });

      test('CONTRACT: concurrent claims for one pending job — exactly one wins', async () => {
        // The reason claim is atomic and on the interface. Simultaneous
        // claims for a type with ONE pending job admit exactly one winner;
        // the losers are DECLINED, not errors.
        await jobQueue.createJob(createPendingDetectionJob('job-contested'));

        const results = await Promise.all(
          Array.from({ length: 5 }, () => jobQueue.claimNextJob(['reference-annotation'])),
        );

        const winners = results.filter((r) => 'job' in r);
        const declined = results.filter((r) => 'declined' in r);
        expect(winners).toHaveLength(1);
        expect(declined).toHaveLength(4);
        for (const d of declined) {
          expect(d).toEqual({ declined: 'none-available' });
        }
      });

      test('CONTRACT: two claims against two pending jobs BOTH win, on different jobs', async () => {
        // The property claim-by-type buys over claim-by-jobId: after one
        // announcement two workers used to race for the SAME id and one
        // always lost; now each claim takes the next available job.
        await jobQueue.createJob(createPendingDetectionJob('job-race-1'));
        await jobQueue.createJob(createPendingDetectionJob('job-race-2'));

        const [r1, r2] = await Promise.all([
          jobQueue.claimNextJob(['reference-annotation']),
          jobQueue.claimNextJob(['reference-annotation']),
        ]);

        if ('declined' in r1 || 'declined' in r2) throw new Error('both claims must win');
        expect(new Set([r1.job.metadata.id, r2.job.metadata.id]).size).toBe(2);
      });
    });

    describe('completeJob()', () => {
      test('moves a running job to complete with result and completedAt', async () => {
        const job = createRunningDetectionJob('job-done');
        await jobQueue.createJob(job);

        const result = { totalFound: 3, totalEmitted: 3, errors: 0 };
        const moved = await jobQueue.completeJob(jobId('job-done'), result);

        expect(moved).toBe(true);
        const updated = await jobQueue.getJob(jobId('job-done'));
        expect(updated?.status).toBe('complete');
        if (updated?.status === 'complete') {
          expect(updated.result).toEqual(result);
          expect(updated.startedAt).toBe(job.startedAt);
          expect(updated.completedAt).toBeTruthy();
        }
      });

      test('is a no-op for a job that is not running', async () => {
        await jobQueue.createJob(createPendingDetectionJob('job-still-pending'));

        expect(await jobQueue.completeJob(jobId('job-still-pending'), {})).toBe(false);
        expect((await jobQueue.getJob(jobId('job-still-pending')))?.status).toBe('pending');
      });

      test('returns false for an unknown job', async () => {
        expect(await jobQueue.completeJob(jobId('job-missing'), {})).toBe(false);
      });
    });

    describe('failJob()', () => {
      test('moves a running job back to pending while retries remain', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-flaky')); // retryCount 0, maxRetries 3

        const outcome = await jobQueue.failJob(jobId('job-flaky'), 'inference timeout');

        expect(outcome).toBe('retried');
        const updated = await jobQueue.getJob(jobId('job-flaky'));
        expect(updated?.status).toBe('pending');
        expect(updated?.metadata.retryCount).toBe(1);
      });

      test('moves a running job to failed when retries are exhausted', async () => {
        const job = createRunningDetectionJob('job-doomed');
        job.metadata.retryCount = 3; // maxRetries is 3
        await jobQueue.createJob(job);

        const outcome = await jobQueue.failJob(jobId('job-doomed'), 'inference exploded');

        expect(outcome).toBe('failed');
        const updated = await jobQueue.getJob(jobId('job-doomed'));
        expect(updated?.status).toBe('failed');
        if (updated?.status === 'failed') {
          expect(updated.error).toBe('inference exploded');
          expect(updated.completedAt).toBeTruthy();
        }
      });

      test('returns null for a job that is not running', async () => {
        await jobQueue.createJob(createPendingDetectionJob('job-not-started'));

        expect(await jobQueue.failJob(jobId('job-not-started'), 'irrelevant')).toBeNull();
        expect((await jobQueue.getJob(jobId('job-not-started')))?.status).toBe('pending');
      });
    });

    describe('failJob checkpoint (ABANDONED-INFERENCE P2, A3 iv)', () => {
      test('records completedUnits on the retried job — the checkpoint survives the rebuild', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-ckpt'));

        const outcome = await jobQueue.failJob(jobId('job-ckpt'), 'Location stalled', ['Person', 'Date']);

        expect(outcome).toBe('retried');
        const retried = await jobQueue.getJob(jobId('job-ckpt'));
        expect(retried?.status).toBe('pending');
        expect(retried?.metadata.completedUnits).toEqual(['Person', 'Date']);
      });

      test('unions with units recorded by earlier attempts — attempt 3 keeps attempt 1', async () => {
        const job = createRunningDetectionJob('job-ckpt-union');
        job.metadata.completedUnits = ['Person'];
        await jobQueue.createJob(job);

        await jobQueue.failJob(jobId('job-ckpt-union'), 'Date stalled', ['Date']);

        const retried = await jobQueue.getJob(jobId('job-ckpt-union'));
        expect(retried?.metadata.completedUnits?.slice().sort()).toEqual(['Date', 'Person']);
      });

      test('the terminal failed record carries the units too — the waste is visible (D3)', async () => {
        const job = createRunningDetectionJob('job-ckpt-terminal');
        job.metadata.retryCount = 3; // maxRetries is 3 — exhausted
        await jobQueue.createJob(job);

        const outcome = await jobQueue.failJob(jobId('job-ckpt-terminal'), 'stalled again', ['Person']);

        expect(outcome).toBe('failed');
        const failed = await jobQueue.getJob(jobId('job-ckpt-terminal'));
        expect(failed?.metadata.completedUnits).toEqual(['Person']);
      });
    });

    describe('failJob classification (ABANDONED-INFERENCE P3, A4)', () => {
      test('a deterministic failure goes straight to failed — budget remaining or not', async () => {
        // retryCount 0, maxRetries 3: plenty of budget, and it must not be spent.
        await jobQueue.createJob(createRunningDetectionJob('job-det'));

        const outcome = await jobQueue.failJob(jobId('job-det'), 'request exceeds size limits', undefined, 'deterministic');

        expect(outcome).toBe('failed');
        expect((await jobQueue.getJob(jobId('job-det')))?.status).toBe('failed');
      });

      test('an explicit transient failure retries exactly as an unclassified one does', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-transient'));

        const outcome = await jobQueue.failJob(jobId('job-transient'), 'timed out', undefined, 'transient');

        expect(outcome).toBe('retried');
        expect((await jobQueue.getJob(jobId('job-transient')))?.status).toBe('pending');
      });

      test('a deterministic failure still keeps its checkpoint on the terminal record (D3)', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-det-ckpt'));

        const outcome = await jobQueue.failJob(jobId('job-det-ckpt'), 'schema rejected', ['Person', 'Date'], 'deterministic');

        expect(outcome).toBe('failed');
        const failed = await jobQueue.getJob(jobId('job-det-ckpt'));
        expect(failed?.metadata.completedUnits).toEqual(['Person', 'Date']);
      });
    });

    describe('recordProgress()', () => {
      test('writes progress into the running job', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-progress'));

        await jobQueue.recordProgress(jobId('job-progress'), { percentage: 40 });

        const updated = await jobQueue.getJob(jobId('job-progress'));
        expect(updated?.status).toBe('running');
        if (updated?.status === 'running') {
          expect(updated.progress).toEqual({ percentage: 40 });
        }
      });

      test('throttles rapid successive writes', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-chatty'));

        await jobQueue.recordProgress(jobId('job-chatty'), { percentage: 10 });
        await jobQueue.recordProgress(jobId('job-chatty'), { percentage: 11 });

        const updated = await jobQueue.getJob(jobId('job-chatty'));
        expect(updated?.status).toBe('running');
        if (updated?.status === 'running') {
          expect(updated.progress).toEqual({ percentage: 10 });
        }
      });

      test('writes again once the throttle window has passed', async () => {
        vi.useFakeTimers();
        try {
          await jobQueue.createJob(createRunningDetectionJob('job-patient'));

          await jobQueue.recordProgress(jobId('job-patient'), { percentage: 10 });
          vi.advanceTimersByTime(6_000);
          await jobQueue.recordProgress(jobId('job-patient'), { percentage: 80 });

          const updated = await jobQueue.getJob(jobId('job-patient'));
          expect(updated?.status).toBe('running');
          if (updated?.status === 'running') {
            expect(updated.progress).toEqual({ percentage: 80 });
          }
        } finally {
          vi.useRealTimers();
        }
      });

      test('ignores progress for jobs that are not running', async () => {
        await jobQueue.createJob(createPendingDetectionJob('job-early-progress'));

        await jobQueue.recordProgress(jobId('job-early-progress'), { percentage: 50 });

        expect((await jobQueue.getJob(jobId('job-early-progress')))?.status).toBe('pending');
      });
    });

    describe('cancelJob()', () => {
      test('cancels a pending job', async () => {
        await jobQueue.createJob(createPendingDetectionJob('job-cancel'));

        expect(await jobQueue.cancelJob(jobId('job-cancel'))).toBe(true);
        expect((await jobQueue.getJob(jobId('job-cancel')))?.status).toBe('cancelled');
      });

      test('cancels a running job, keeping its startedAt', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-cancel-running'));

        expect(await jobQueue.cancelJob(jobId('job-cancel-running'))).toBe(true);
        const retrieved = await jobQueue.getJob(jobId('job-cancel-running'));
        expect(retrieved?.status).toBe('cancelled');
        if (retrieved?.status === 'cancelled') {
          expect(retrieved.startedAt).toBeDefined();
        }
      });

      test('does not cancel a completed job', async () => {
        await jobQueue.createJob(createCompleteDetectionJob('job-complete'));

        expect(await jobQueue.cancelJob(jobId('job-complete'))).toBe(false);
      });

      test('returns false for a job that does not exist', async () => {
        expect(await jobQueue.cancelJob(jobId('nonexistent'))).toBe(false);
      });
    });

    describe('cancelPendingJobs()', () => {
      test('cancels pending annotation jobs, leaves generation and running jobs alone', async () => {
        await jobQueue.createJob(createPendingDetectionJob('job-ann-1'));
        await jobQueue.createJob(createPendingDetectionJob('job-ann-2'));
        await jobQueue.createJob(createPendingGenerationJob('job-gen-1'));
        await jobQueue.createJob(createRunningDetectionJob('job-ann-running'));

        const cancelled = await jobQueue.cancelPendingJobs('annotation');

        expect(cancelled).toBe(2);
        expect((await jobQueue.getJob(jobId('job-ann-1')))?.status).toBe('cancelled');
        expect((await jobQueue.getJob(jobId('job-ann-2')))?.status).toBe('cancelled');
        expect((await jobQueue.getJob(jobId('job-gen-1')))?.status).toBe('pending');
        expect((await jobQueue.getJob(jobId('job-ann-running')))?.status).toBe('running');
      });

      test("cancels pending generation jobs for the 'generation' category", async () => {
        await jobQueue.createJob(createPendingDetectionJob('job-ann-3'));
        await jobQueue.createJob(createPendingGenerationJob('job-gen-2'));

        const cancelled = await jobQueue.cancelPendingJobs('generation');

        expect(cancelled).toBe(1);
        expect((await jobQueue.getJob(jobId('job-gen-2')))?.status).toBe('cancelled');
        expect((await jobQueue.getJob(jobId('job-ann-3')))?.status).toBe('pending');
      });
    });

    describe('getStats()', () => {
      test('returns correct counts for each status', async () => {
        await jobQueue.createJob(createPendingDetectionJob('job-pending-1'));
        await jobQueue.createJob(createPendingDetectionJob('job-pending-2'));
        await jobQueue.createJob(createRunningDetectionJob('job-running'));
        await jobQueue.createJob(createCompleteDetectionJob('job-complete'));
        await jobQueue.createJob(createFailedDetectionJob('job-failed'));

        const stats = await jobQueue.getStats();

        expect(stats.pending).toBe(2);
        expect(stats.running).toBe(1);
        expect(stats.complete).toBe(1);
        expect(stats.failed).toBe(1);
        expect(stats.cancelled).toBe(0);
      });
    });

    describe('checkpointUnits() — durable resume without a job:fail (JOB-RESTART-SAFETY P2)', () => {
      test('a checkpoint written at unit completion survives a worker death into recovery', async () => {
        // The worker completes unit 1 and checkpoints it, then DIES without
        // ever emitting job:fail (crash / OOM / kill). The orphan recovery
        // must re-queue the job STILL carrying the checkpoint.
        await jobQueue.createJob(createRunningDetectionJob('job-ckpt'));
        await jobQueue.checkpointUnits(jobId('job-ckpt'), ['Person']);

        // The running record itself carries it — the crash-durable state,
        // persisted before any failure event.
        const running = await jobQueue.getJob(jobId('job-ckpt'));
        expect(running?.metadata.completedUnits).toEqual(['Person']);

        // Worker died > stale window ago; no job:fail was sent.
        await h.ageRunningJob(jobId('job-ckpt'));

        expect(await h.recoverStale(jobQueue)).toBe(1);
        const requeued = await jobQueue.getJob(jobId('job-ckpt'));
        expect(requeued?.status).toBe('pending');
        expect(requeued?.metadata.completedUnits).toEqual(['Person']);
      });

      test('unions successive checkpoints, never dropping earlier units', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-ckpt2'));
        await jobQueue.checkpointUnits(jobId('job-ckpt2'), ['Person']);
        await jobQueue.checkpointUnits(jobId('job-ckpt2'), ['Location']);

        const j = await jobQueue.getJob(jobId('job-ckpt2'));
        expect(new Set(j?.metadata.completedUnits)).toEqual(new Set(['Person', 'Location']));
      });

      test('is a no-op for a job that is not running', async () => {
        await jobQueue.createJob(createPendingDetectionJob('job-ckpt3'));
        await jobQueue.checkpointUnits(jobId('job-ckpt3'), ['Person']);

        const j = await jobQueue.getJob(jobId('job-ckpt3'));
        expect(j?.metadata.completedUnits).toBeUndefined();
      });
    });

    // ── per-unit cursors (CHUNK-GRAIN-RESUME P2) ──────────────────────────
    //
    // `completedUnits` records whole units, so a job with ONE unit could
    // record nothing until the entire document was done. A cursor is the
    // finer grain, and it cannot be merged the way a set is: a set only
    // grows, so a union converges on its own, while a cursor converges only
    // if a stale snapshot can never move it back.
    describe('checkpointUnits() — per-unit cursors', () => {
      test('records how far an unfinished unit got, beside the finished ones', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-cur1'));
        await jobQueue.checkpointUnits(jobId('job-cur1'), [], { Person: { next: 5_000, size: 800, found: 0, emitted: 0 } });

        const j = await jobQueue.getJob(jobId('job-cur1'));
        expect(j?.metadata.unitCursors).toEqual({ Person: { next: 5_000, size: 800, found: 0, emitted: 0 } });
        // The unit is NOT complete — that is the whole point of the grain.
        expect(j?.metadata.completedUnits ?? []).toEqual([]);
      });

      test('advances a cursor as its unit progresses', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-cur2'));
        await jobQueue.checkpointUnits(jobId('job-cur2'), [], { Person: { next: 5_000, size: 800, found: 0, emitted: 0 } });
        await jobQueue.checkpointUnits(jobId('job-cur2'), [], { Person: { next: 9_000, size: 560, found: 0, emitted: 0 } });

        const j = await jobQueue.getJob(jobId('job-cur2'));
        expect(j?.metadata.unitCursors).toEqual({ Person: { next: 9_000, size: 560, found: 0, emitted: 0 } });
      });

      test('an out-of-order checkpoint never moves a cursor backward', async () => {
        // Two snapshots in flight; the older one lands last. A union would be
        // safe here and a last-writer-wins would not: the resume position would
        // regress and the job would re-pay for chunks it already committed.
        await jobQueue.createJob(createRunningDetectionJob('job-cur3'));
        await jobQueue.checkpointUnits(jobId('job-cur3'), [], { Person: { next: 9_000, size: 560, found: 0, emitted: 0 } });
        await jobQueue.checkpointUnits(jobId('job-cur3'), [], { Person: { next: 2_000, size: 4_500, found: 0, emitted: 0 } });

        const j = await jobQueue.getJob(jobId('job-cur3'));
        // And `size` did not come from the loser either — the pair is ONE
        // observation, and a mix would describe a chunk that never existed.
        expect(j?.metadata.unitCursors).toEqual({ Person: { next: 9_000, size: 560, found: 0, emitted: 0 } });
      });

      test('tracks each unit independently', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-cur4'));
        await jobQueue.checkpointUnits(jobId('job-cur4'), [], { Person: { next: 5_000, size: 800, found: 0, emitted: 0 } });
        await jobQueue.checkpointUnits(jobId('job-cur4'), [], { Location: { next: 1_200, size: 900, found: 0, emitted: 0 } });

        const j = await jobQueue.getJob(jobId('job-cur4'));
        expect(j?.metadata.unitCursors).toEqual({
          Person: { next: 5_000, size: 800, found: 0, emitted: 0 },
          Location: { next: 1_200, size: 900, found: 0, emitted: 0 },
        });
      });

      test('a unit that completes drops its cursor — the two states are exclusive', async () => {
        // "Skipped whole, whatever cursor it last carried" is made structural
        // rather than left as a rule every reader has to remember: a completed
        // unit simply has no cursor to misread.
        await jobQueue.createJob(createRunningDetectionJob('job-cur5'));
        await jobQueue.checkpointUnits(jobId('job-cur5'), [], { Person: { next: 5_000, size: 800, found: 0, emitted: 0 } });
        await jobQueue.checkpointUnits(jobId('job-cur5'), ['Person']);

        const j = await jobQueue.getJob(jobId('job-cur5'));
        expect(j?.metadata.completedUnits).toEqual(['Person']);
        expect(j?.metadata.unitCursors ?? {}).toEqual({});
      });

      test('a late cursor for an already-completed unit is dropped again', async () => {
        // The convergence half of the rule above: a stale snapshot naming a unit
        // that has since completed must not resurrect its cursor.
        await jobQueue.createJob(createRunningDetectionJob('job-cur6'));
        await jobQueue.checkpointUnits(jobId('job-cur6'), ['Person']);
        await jobQueue.checkpointUnits(jobId('job-cur6'), [], { Person: { next: 5_000, size: 800, found: 0, emitted: 0 } });

        const j = await jobQueue.getJob(jobId('job-cur6'));
        expect(j?.metadata.unitCursors ?? {}).toEqual({});
      });

      test('a job that dies BETWEEN units behaves exactly as today', async () => {
        // No regression to the landed unit-grain path: with no cursor reported,
        // nothing new appears on the record — not an empty object, which would be
        // a claim that units were tracked and none had progress.
        await jobQueue.createJob(createRunningDetectionJob('job-cur7'));
        await jobQueue.checkpointUnits(jobId('job-cur7'), ['Person']);

        const j = await jobQueue.getJob(jobId('job-cur7'));
        expect(j?.metadata.completedUnits).toEqual(['Person']);
        expect('unitCursors' in (j?.metadata ?? {})).toBe(false);
      });

      test('a cursor survives a worker death into recovery', async () => {
        // The worker dies mid-unit without emitting job:fail, so only the
        // durable checkpoint write can carry the cursor into the re-queued
        // job for a later claim to read.
        await jobQueue.createJob(createRunningDetectionJob('job-cur8'));
        await jobQueue.checkpointUnits(jobId('job-cur8'), [], { Person: { next: 5_000, size: 800, found: 0, emitted: 0 } });

        await h.ageRunningJob(jobId('job-cur8'));

        expect(await h.recoverStale(jobQueue)).toBe(1);
        const requeued = await jobQueue.getJob(jobId('job-cur8'));
        expect(requeued?.status).toBe('pending');
        expect(requeued?.metadata.unitCursors).toEqual({ Person: { next: 5_000, size: 800, found: 0, emitted: 0 } });
      });
    });

    describe('orphan recovery — no progress past the stale window (contract, mechanism per driver)', () => {
      test('re-queues a stale running job with retries remaining', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-stale-retry'));
        await h.ageRunningJob(jobId('job-stale-retry'));

        expect(await h.recoverStale(jobQueue)).toBe(1);
        const updated = await jobQueue.getJob(jobId('job-stale-retry'));
        expect(updated?.status).toBe('pending');
        expect(updated?.metadata.retryCount).toBe(1);
      });

      test('fails a stale running job whose retries are exhausted', async () => {
        const job = createRunningDetectionJob('job-stale-dead');
        job.metadata.retryCount = 3;
        await jobQueue.createJob(job);
        await h.ageRunningJob(jobId('job-stale-dead'));

        expect(await h.recoverStale(jobQueue)).toBe(1);
        const updated = await jobQueue.getJob(jobId('job-stale-dead'));
        expect(updated?.status).toBe('failed');
        if (updated?.status === 'failed') {
          expect(updated.error).toContain('presumed dead');
        }
      });

      test('leaves fresh running jobs untouched', async () => {
        await jobQueue.createJob(createRunningDetectionJob('job-fresh'));

        expect(await h.recoverStale(jobQueue)).toBe(0);
        expect((await jobQueue.getJob(jobId('job-fresh')))?.status).toBe('running');
      });

      test('a progress write rescues an otherwise-stale running job', async () => {
        // Pins the heartbeat contract: a progress write counts as liveness,
        // or recovery would take live jobs out from under their workers.
        await jobQueue.createJob(createRunningDetectionJob('job-heartbeat'));
        await h.ageRunningJob(jobId('job-heartbeat'));

        await jobQueue.recordProgress(jobId('job-heartbeat'), { percentage: 50 });

        expect(await h.recoverStale(jobQueue)).toBe(0);
        expect((await jobQueue.getJob(jobId('job-heartbeat')))?.status).toBe('running');
      });
    });

    describe('persistence across process restart (JOB-RESTART-SAFETY P1)', () => {
      // Job state outlives the process that created it: a SECOND queue
      // instance over the SAME backing recovers a job the first left
      // running. This pins that recovery holds no in-memory handoff a
      // restart would drop.
      test("a fresh queue over the same backing recovers the previous instance's orphaned running job", async () => {
        const dead = jobQueue;
        await dead.createJob(createRunningDetectionJob('job-across-restart'));
        dead.destroy();

        // The worker died > the stale window ago; no job:fail was ever sent.
        await h.ageRunningJob(jobId('job-across-restart'));

        // A brand-new instance — no shared state with `dead` beyond the backing.
        const reborn = await h.open();
        const recovered = await h.recoverStale(reborn);

        expect(recovered).toBe(1);
        const requeued = await reborn.getJob(jobId('job-across-restart'));
        expect(requeued?.status).toBe('pending');
        expect(requeued?.metadata.retryCount).toBe(1);
      });
    });
  });
}
