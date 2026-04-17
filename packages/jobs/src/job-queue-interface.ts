import type { AnyJob, JobStatus } from './types';
import type { JobId } from '@semiont/core';

export interface JobQueue {
  initialize(): Promise<void>;
  destroy(): void;
  createJob(job: AnyJob): Promise<void>;
  getJob(jobId: JobId): Promise<AnyJob | null>;
  updateJob(job: AnyJob, oldStatus?: JobStatus): Promise<void>;
  pollNextPendingJob(predicate?: (job: AnyJob) => boolean): Promise<AnyJob | null>;
  cancelJob(jobId: JobId): Promise<boolean>;
  getStats(): Promise<{ pending: number; running: number; complete: number; failed: number; cancelled: number }>;
}
