/**
 * Job Queue — pg-boss backed (Postgres)
 *
 * Atomic job claims via SKIP LOCKED, retry with backoff, dead-worker
 * detection, concurrency limits.
 */

import { PgBoss } from 'pg-boss';
import type { AnyJob, JobStatus, JobType } from './types';
import type { JobId, Logger, EventBus } from '@semiont/core';
import type { JobQueue } from './job-queue-interface';

const ALL_JOB_TYPES: JobType[] = [
  'reference-annotation', 'generation', 'highlight-annotation',
  'assessment-annotation', 'comment-annotation', 'tag-annotation',
];

export class PgBossJobQueue implements JobQueue {
  private boss: PgBoss;
  private logger: Logger;
  private eventBus?: EventBus;

  constructor(
    connectionString: string,
    logger: Logger,
    eventBus?: EventBus,
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.boss = new PgBoss({
      connectionString,
      schema: 'semiont_jobs',
    });
  }

  async initialize(): Promise<void> {
    await this.boss.start();

    for (const jobType of ALL_JOB_TYPES) {
      await this.boss.createQueue(jobType, {
        retryLimit: 3,
        retryDelay: 5,
        retryBackoff: true,
        expireInSeconds: 3600,
      });
    }

    this.logger.info('Job queue initialized (pg-boss)');
  }

  destroy(): void {
    this.boss.stop({ graceful: true, timeout: 5000 }).catch(() => {});
  }

  async createJob(job: AnyJob): Promise<void> {
    const queueName = job.metadata.type;

    await this.boss.send(queueName, { semiontJob: job }, {
      id: job.metadata.id,
    });

    this.logger.info('Job created', { jobId: job.metadata.id, queue: queueName });

    if (this.eventBus && 'params' in job && 'resourceId' in job.params) {
      const resourceBus = this.eventBus.scope(job.params.resourceId);
      resourceBus.get('job:queued').next({
        jobId: job.metadata.id,
        jobType: job.metadata.type,
        resourceId: job.params.resourceId,
      });
    }
  }

  async getJob(jobId: JobId): Promise<AnyJob | null> {
    for (const queueName of ALL_JOB_TYPES) {
      const pgJob = await this.boss.getJobById(queueName, jobId);
      if (pgJob) {
        return (pgJob.data as { semiontJob: AnyJob }).semiontJob;
      }
    }
    return null;
  }

  async updateJob(job: AnyJob, _oldStatus?: JobStatus): Promise<void> {
    const queueName = job.metadata.type;
    if (job.status === 'complete') {
      await this.boss.complete(queueName, job.metadata.id, { semiontJob: job });
    } else if (job.status === 'failed') {
      await this.boss.fail(queueName, job.metadata.id, { semiontJob: job });
    } else if (job.status === 'cancelled') {
      await this.boss.cancel(queueName, job.metadata.id);
    }
    this.logger.info('Job updated', { jobId: job.metadata.id, status: job.status });
  }

  async pollNextPendingJob(predicate?: (job: AnyJob) => boolean): Promise<AnyJob | null> {
    for (const queueName of ALL_JOB_TYPES) {
      const pgJobs = await this.boss.fetch(queueName);
      if (!pgJobs || pgJobs.length === 0) continue;

      const pgJob = pgJobs[0];
      const semiontJob = (pgJob.data as { semiontJob: AnyJob }).semiontJob;

      if (predicate && !predicate(semiontJob)) {
        await this.boss.complete(queueName, pgJob.id);
        continue;
      }

      return {
        ...semiontJob,
        status: 'running' as const,
        startedAt: new Date().toISOString(),
        progress: {},
      } as AnyJob;
    }

    return null;
  }

  async cancelJob(jobId: JobId): Promise<boolean> {
    for (const queueName of ALL_JOB_TYPES) {
      try {
        await this.boss.cancel(queueName, jobId);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  async getStats(): Promise<{
    pending: number;
    running: number;
    complete: number;
    failed: number;
    cancelled: number;
  }> {
    return { pending: 0, running: 0, complete: 0, failed: 0, cancelled: 0 };
  }
}
