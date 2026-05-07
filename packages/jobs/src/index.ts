/**
 * @semiont/jobs
 *
 * Job queue and worker infrastructure
 *
 * Provides:
 * - JobQueue interface: backing-store-agnostic contract
 * - FsJobQueue: Filesystem-backed implementation
 * - JobWorker: Abstract base class for job workers
 * - Job processors: Extracted functions for each job type
 * - Job types: All job type definitions
 */

// Job Queue
export type { JobQueue } from './job-queue-interface';
export { FsJobQueue } from './fs-job-queue';

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

// Job processors (extracted, transport-agnostic)
export {
  processHighlightJob,
  processCommentJob,
  processAssessmentJob,
  processReferenceJob,
  processTagJob,
  processGenerationJob,
  type OnProgress,
  type ProcessorResult,
} from './processors';

// Detection utilities
export { AnnotationDetection } from './workers/annotation-detection';

// Generation utilities
export { generateResourceFromTopic } from './workers/generation/resource-generation';
