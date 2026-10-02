/**
 * @semiont/jobs
 *
 * The job worker: the processors for each job type, the job types, and the
 * worker process that claims jobs from the dispatcher over the bus.
 */

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
  RunningAnyJob,
  StoredProgress,
  PendingJob,
  RunningJob,
  CompleteJob,
  FailedJob,
  CancelledJob,
  DetectionParams,
  HighlightDetectionParams,
  AssessmentDetectionParams,
  CommentDetectionParams,
  TagDetectionParams,
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

// The job-claim protocol runtime: what a worker built outside this package
// claims jobs with (docs/protocol/skills/semiont-worker).
export {
  createJobClaimAdapter,
  type JobClaimAdapter,
  type JobClaimAdapterOptions,
  type ActiveJob,
  type ClaimRefusal,
  type WorkerVitals,
} from './job-claim-adapter';

// Worker liveness bounds (WORKER-LIVENESS P3). STALL_THRESHOLD_MS also
// participates in the A4 nesting assertion at make-meaning's composition
// root: gather read-barrier budgets must degrade before this watchdog
// fails fast.
export { STALL_THRESHOLD_MS } from './worker-runtime';
/**
 * The worker's complete subscription manifest
 * (CLIENT-SUBSCRIPTION-MANIFEST D2). Exported so a composition-grain test can
 * subscribe the REAL set rather than a hand-written list of the channel it is
 * testing — the grain every 2026-09-16 bring-up bug slipped through.
 */
export { WORKER_CHANNELS, WORKER_CONSUMED_BROADCASTS } from './worker-runtime';
