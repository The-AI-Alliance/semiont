// @semiont/make-meaning - Making meaning from resources
// Transforms raw resources into meaningful, interconnected knowledge

// Service (primary export)
export { startMakeMeaning } from './service';
export type { MakeMeaningService } from './service';

// Graph Consumer
export { GraphDBConsumer } from './graph/consumer';

// Context assembly exports
export { ResourceContext } from './resource-context';
export type { ListResourcesFilters } from './resource-context';
export { AnnotationContext } from './annotation-context';
export type { BuildContextOptions } from './annotation-context';
export { GraphContext } from './graph-context';

// Detection exports
export { AnnotationDetection } from './annotation-detection';

// Re-export match types from @semiont/inference for convenience
export type {
  CommentMatch,
  HighlightMatch,
  AssessmentMatch,
  TagMatch,
} from '@semiont/inference';

// Job workers (exported for direct instantiation if needed)
export { CommentDetectionWorker } from './jobs/workers/comment-detection-worker';
export { HighlightDetectionWorker } from './jobs/workers/highlight-detection-worker';
export { AssessmentDetectionWorker } from './jobs/workers/assessment-detection-worker';
export { TagDetectionWorker } from './jobs/workers/tag-detection-worker';
export { ReferenceDetectionWorker } from './jobs/workers/reference-detection-worker';
export { GenerationWorker } from './jobs/workers/generation-worker';

// Reasoning exports (future)
// export { ResourceReasoning } from './resource-reasoning';

// Placeholder for initial build
export const PACKAGE_NAME = '@semiont/make-meaning';
export const VERSION = '0.1.0';
