/**
 * @semiont/jobs
 *
 * Job queue and worker infrastructure
 *
 * Provides:
 * - JobQueue interface: backing-store-agnostic contract
 * - FsJobQueue: Filesystem-backed implementation
 * - Job processors: Extracted functions for each job type
 * - Job types: All job type definitions
 */

// Job Queue
export type { JobQueue } from './job-queue-interface';
export { FsJobQueue } from './fs-job-queue';

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

// Worker liveness bounds (WORKER-LIVENESS P3). STALL_THRESHOLD_MS also
// participates in the A4 nesting assertion at make-meaning's composition
// root: gather read-barrier budgets must degrade before this watchdog
// fails fast.
export { STALL_THRESHOLD_MS } from './worker-runtime';
