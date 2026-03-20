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
export { JobQueue } from './job-queue';

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
  YieldProgress,
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
  ContentFetcher,
} from './types';

export {
  isPendingJob,
  isRunningJob,
  isCompleteJob,
  isFailedJob,
  isCancelledJob,
} from './types';

// Workers
export { ReferenceAnnotationWorker } from './workers/reference-annotation-worker';
export { GenerationWorker } from './workers/generation-worker';
export { HighlightAnnotationWorker } from './workers/highlight-annotation-worker';
export { AssessmentAnnotationWorker } from './workers/assessment-annotation-worker';
export { CommentAnnotationWorker } from './workers/comment-annotation-worker';
export { TagAnnotationWorker } from './workers/tag-annotation-worker';

// Detection utilities
export { AnnotationDetection } from './workers/annotation-detection';

// Generation utilities
export { generateResourceFromTopic } from './workers/generation/resource-generation';
