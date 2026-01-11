/**
 * @semiont/jobs
 *
 * Filesystem-based job queue and worker infrastructure
 *
 * Provides:
 * - JobQueue: Filesystem-based job queue with status directories
 * - JobWorker: Abstract base class for job workers
 * - Job types: All job type definitions
 */

// Job Queue
export { JobQueue, type JobQueueConfig, getJobQueue, initializeJobQueue } from './job-queue';

// Job Worker
export { JobWorker } from './job-worker';

// Types
export type {
  JobType,
  JobStatus,
  BaseJob,
  DetectionJob,
  GenerationJob,
  HighlightDetectionJob,
  AssessmentDetectionJob,
  CommentDetectionJob,
  TagDetectionJob,
  Job,
  JobQueryFilters,
} from './types';
