/**
 * The dispatcher's queue-sync paths whose only observable outcome is a log line.
 *
 * `job:complete`, `job:fail`, `job:report-progress`, `job:checkpoint` and
 * `job:cancel` are SIGNALS, not operations: the event log is the record and
 * the queue is a projection of it, so when the queue refuses or throws the
 * handler must not reply (there is no caller awaiting one) and must not die
 * (the subscription serves every later job). What it does instead is log —
 * which makes the log line the contract, and a contract nobody asserts is one
 * that drifts. Every branch below was unexercised when the dispatcher shipped
 * (EXTRACT-JOBS P4 coverage pass): the `catch` of each sync handler, the two
 * "not in running" warnings, and the two refusals that DO reply
 * (`job:cancel-requested`'s failure channel, `job:create` without `_userId`).
 *
 * Each case also proves the subscription survived: a second signal after the
 * failure reaches the queue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, filter, map, take } from 'rxjs';
import { EventBus, type EventMap, type Logger } from '@semiont/core';
import { registerJobCommandHandlers } from '../../handlers/job-commands';
import type { ProjectionReads } from '../../projection-reads-ask';
import { makeJobQueueMock, type JobQueueMock } from '../helpers/job-queue-mock';

// No case here reaches `job:create`'s validation reads.
const stubReads: ProjectionReads = { entityTypes: async () => [], tagSchemas: async () => [] };

/** A fresh, assertable logger per test; `child` returns itself so the handler's lines land here. */
function makeLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

describe('registerJobCommandHandlers — queue-sync failures are logged, not fatal', () => {
  let eventBus: EventBus;
  let jobQueue: JobQueueMock;
  let logger: Logger;

  beforeEach(() => {
    eventBus = new EventBus();
    jobQueue = makeJobQueueMock();
    logger = makeLogger();
    registerJobCommandHandlers(eventBus, jobQueue, stubReads, logger);
  });

  afterEach(() => {
    eventBus.destroy();
  });

  it('job:complete for a job the queue does not hold as running WARNS, naming the job', async () => {
    jobQueue.completeJob.mockResolvedValueOnce(false);

    eventBus.emit('job:complete', { resourceId: 'rid', jobId: 'job-c', jobType: 'generation' } as never);

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith('job:complete for a job not in running', { jobId: 'job-c' });
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('job:complete when the queue throws logs the failure with its message and keeps serving', async () => {
    jobQueue.completeJob.mockRejectedValueOnce(new Error('disk full'));

    eventBus.emit('job:complete', { resourceId: 'rid', jobId: 'job-c1', jobType: 'generation' } as never);
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith('Failed to sync job completion to queue', { jobId: 'job-c1', error: 'disk full' });
    });

    eventBus.emit('job:complete', { resourceId: 'rid', jobId: 'job-c2', jobType: 'generation' } as never);
    await vi.waitFor(() => {
      expect(jobQueue.completeJob).toHaveBeenLastCalledWith('job-c2', {});
    });
  });

  it('job:fail that the queue RE-QUEUES is logged as a retry, not a failure', async () => {
    jobQueue.failJob.mockResolvedValueOnce('retried');

    eventBus.emit('job:fail', { resourceId: 'rid', jobId: 'job-r', jobType: 'generation', error: 'boom' } as never);

    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith('Job re-queued for retry', { jobId: 'job-r' });
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('job:fail for a job the queue does not hold as running WARNS, naming the job', async () => {
    jobQueue.failJob.mockResolvedValueOnce(null);

    eventBus.emit('job:fail', { resourceId: 'rid', jobId: 'job-f', jobType: 'generation', error: 'boom' } as never);

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith('job:fail for a job not in running', { jobId: 'job-f' });
    });
  });

  it('job:fail when the queue throws logs the failure and keeps serving', async () => {
    jobQueue.failJob.mockRejectedValueOnce(new Error('lock held'));

    eventBus.emit('job:fail', { resourceId: 'rid', jobId: 'job-f1', jobType: 'generation', error: 'boom' } as never);
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith('Failed to sync job failure to queue', { jobId: 'job-f1', error: 'lock held' });
    });

    eventBus.emit('job:fail', { resourceId: 'rid', jobId: 'job-f2', jobType: 'generation', error: 'boom' } as never);
    await vi.waitFor(() => {
      expect(jobQueue.failJob).toHaveBeenLastCalledWith('job-f2', 'boom', undefined, undefined, undefined);
    });
  });

  it('job:report-progress when the queue throws logs the failure and keeps serving', async () => {
    jobQueue.recordProgress.mockRejectedValueOnce(new Error('read-only'));

    eventBus.emit('job:report-progress', { resourceId: 'rid', jobId: 'job-p1', jobType: 'generation', percentage: 10 } as never);
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith('Failed to record job progress', { jobId: 'job-p1', error: 'read-only' });
    });

    eventBus.emit('job:report-progress', { resourceId: 'rid', jobId: 'job-p2', jobType: 'generation', percentage: 20 } as never);
    await vi.waitFor(() => {
      expect(jobQueue.recordProgress).toHaveBeenLastCalledWith('job-p2', { percentage: 20 });
    });
  });

  it('job:checkpoint when the queue throws logs the failure and keeps serving', async () => {
    jobQueue.checkpointUnits.mockRejectedValueOnce(new Error('read-only'));

    eventBus.emit('job:checkpoint', { resourceId: 'rid', jobId: 'job-k1', jobType: 'reference-annotation', completedUnits: ['Person'] } as never);
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith('Failed to checkpoint job units', { jobId: 'job-k1', error: 'read-only' });
    });

    eventBus.emit('job:checkpoint', { resourceId: 'rid', jobId: 'job-k2', jobType: 'reference-annotation', completedUnits: ['Place'] } as never);
    await vi.waitFor(() => {
      expect(jobQueue.checkpointUnits).toHaveBeenLastCalledWith('job-k2', ['Place'], undefined);
    });
  });

  it('job:cancel (the worker\'s confirmation) when the queue throws logs the failure and keeps serving', async () => {
    jobQueue.cancelJob.mockRejectedValueOnce(new Error('gone'));

    eventBus.emit('job:cancel', { resourceId: 'rid', jobId: 'job-x1', jobType: 'generation' } as never);
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith('Failed to cancel job', { jobId: 'job-x1', error: 'gone' });
    });

    eventBus.emit('job:cancel', { resourceId: 'rid', jobId: 'job-x2', jobType: 'generation' } as never);
    await vi.waitFor(() => {
      expect(jobQueue.cancelJob).toHaveBeenLastCalledWith('job-x2');
    });
  });
});

describe('registerJobCommandHandlers — refusals that DO reply', () => {
  let eventBus: EventBus;
  let jobQueue: JobQueueMock;
  let logger: Logger;

  beforeEach(() => {
    eventBus = new EventBus();
    jobQueue = makeJobQueueMock();
    logger = makeLogger();
    registerJobCommandHandlers(eventBus, jobQueue, stubReads, logger);
  });

  afterEach(() => {
    eventBus.destroy();
  });

  it('job:cancel-requested when the queue throws answers job:cancel-failed, correlated, and logs what it was asked', async () => {
    // A request/reply operation: a silent drop strands the caller until its
    // timeout, so the failure channel is the contract here, not the log alone.
    jobQueue.cancelPendingJobs.mockRejectedValueOnce(new Error('lock held'));
    const failed = firstValueFrom(
      eventBus.frames('job:cancel-failed').pipe(
        filter((f) => f.correlationId === 'cid-cancel'),
        map((f) => f.payload),
        take(1),
      ),
    );

    eventBus.emit('job:cancel-requested', { jobType: 'generation' } as never, { correlationId: 'cid-cancel' });

    expect((await failed as EventMap['job:cancel-failed']).message).toBe('lock held');
    expect(logger.error).toHaveBeenCalledWith('Failed to cancel jobs', {
      jobId: undefined,
      jobType: 'generation',
      error: 'lock held',
    });
  });

  it('job:create without the gateway-injected _userId is refused with job:create-failed and never reaches the queue', async () => {
    const failed = firstValueFrom(
      eventBus.frames('job:create-failed').pipe(
        filter((f) => f.correlationId === 'cid-nouser'),
        map((f) => f.payload),
        take(1),
      ),
    );

    eventBus.emit('job:create', {
      jobType: 'reference-annotation',
      resourceId: 'rid-1',
      params: {},
    } as never, { correlationId: 'cid-nouser' });

    expect((await failed as EventMap['job:create-failed']).message).toMatch(/_userId is required/);
    expect(jobQueue.createJob).not.toHaveBeenCalled();
  });
});
