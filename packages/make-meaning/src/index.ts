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

// Resource operations
export { ResourceOperations } from './resource-operations';
export type { UpdateResourceInput, CreateResourceInput } from './resource-operations';

// Annotation operations
export { AnnotationOperations } from './annotation-operations';
export type { CreateAnnotationResult, UpdateAnnotationBodyResult } from './annotation-operations';

// Context assembly exports
export { ResourceContext } from './resource-context';
export type { ListResourcesFilters } from './resource-context';
export { AnnotationContext } from './annotation-context';
export type { BuildContextOptions } from './annotation-context';
export { GraphContext } from './graph-context';
export type { GraphNode, GraphEdge, GraphRepresentation } from './graph-context';
export { LLMContext } from './llm-context';
export type { LLMContextOptions } from './llm-context';

// Detection exports
export { AnnotationDetection } from './annotation-assistance';
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
export { CommentAnnotationWorker } from './jobs/comment-annotation-worker';
export { HighlightAnnotationWorker } from './jobs/highlight-annotation-worker';
export { AssessmentAnnotationWorker } from './jobs/assessment-annotation-worker';
export { TagAnnotationWorker } from './jobs/tag-annotation-worker';
export { ReferenceAnnotationWorker } from './jobs/reference-annotation-worker';
export { GenerationWorker } from './jobs/generation-worker';

// Reasoning exports (future)
// export { ResourceReasoning } from './resource-reasoning';

// ID generation
export { generateUuid } from './id-generation';

// Placeholder for initial build
export const PACKAGE_NAME = '@semiont/make-meaning';
export const VERSION = '0.1.0';
