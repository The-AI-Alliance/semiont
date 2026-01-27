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
  JobMetadata,
  DetectionJob,
  GenerationJob,
  HighlightDetectionJob,
  AssessmentDetectionJob,
  CommentDetectionJob,
  TagDetectionJob,
  AnyJob,
  PendingJob,
  RunningJob,
  CompleteJob,
  FailedJob,
  CancelledJob,
  JobQueryFilters,
  DetectionParams,
  GenerationParams,
  HighlightDetectionParams,
  AssessmentDetectionParams,
  CommentDetectionParams,
  TagDetectionParams,
  DetectionProgress,
  GenerationProgress,
  HighlightDetectionProgress,
  AssessmentDetectionProgress,
  CommentDetectionProgress,
  TagDetectionProgress,
  DetectionResult,
  GenerationResult,
  HighlightDetectionResult,
  AssessmentDetectionResult,
  CommentDetectionResult,
  TagDetectionResult,
  isPendingJob,
  isRunningJob,
  isCompleteJob,
  isFailedJob,
  isCancelledJob,
} from './types';
