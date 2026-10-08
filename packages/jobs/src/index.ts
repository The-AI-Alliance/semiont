/**
 * @semiont/jobs
 *
 * The job worker: the processors for each job type, the job types, and the
 * worker process that claims jobs from the dispatcher over the bus.
 */

// What a worker is handed, typed from the spec
export { isHeldMark, type MarkMotivation, type HeldMarkParams } from './types';

// Job processors (transport-agnostic)
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

/**
 * The worker's complete subscription manifest: every channel its transport is
 * constructed with, declared once. Exported so a composition-grain test can
 * subscribe the REAL set rather than a hand-written list of the channel it is
 * testing.
 */
export { WORKER_CHANNELS, type AgentVitals } from './worker-runtime';
