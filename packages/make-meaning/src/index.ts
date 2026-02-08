// @semiont/make-meaning - Making meaning from resources
// Transforms raw resources into meaningful, interconnected knowledge

// Service (primary export)
export { startMakeMeaning } from './service';
export type { MakeMeaningService } from './service';

// Bootstrap
export { bootstrapEntityTypes, resetBootstrap } from './bootstrap/entity-types';

// Views
export { readEntityTypesProjection } from './views/entity-types-reader';

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
export { MotivationPrompts } from './detection/motivation-prompts';
export { MotivationParsers } from './detection/motivation-parsers';
export type {
  CommentMatch,
  HighlightMatch,
  AssessmentMatch,
  TagMatch,
} from './detection/motivation-parsers';
export { extractEntities } from './detection/entity-extractor';
export type { ExtractedEntity } from './detection/entity-extractor';

// Generation exports
export {
  generateResourceFromTopic,
  generateResourceSummary,
  generateReferenceSuggestions,
} from './generation/resource-generation';

// Job workers (exported for direct instantiation if needed)
export { CommentDetectionWorker } from './jobs/comment-detection-worker';
export { HighlightDetectionWorker } from './jobs/highlight-detection-worker';
export { AssessmentDetectionWorker } from './jobs/assessment-detection-worker';
export { TagDetectionWorker } from './jobs/tag-detection-worker';
export { ReferenceDetectionWorker } from './jobs/reference-detection-worker';
export { GenerationWorker } from './jobs/generation-worker';

// Reasoning exports (future)
// export { ResourceReasoning } from './resource-reasoning';

// Placeholder for initial build
export const PACKAGE_NAME = '@semiont/make-meaning';
export const VERSION = '0.1.0';
