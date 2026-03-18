// @semiont/make-meaning - Making meaning from resources
// Transforms raw resources into meaningful, interconnected knowledge

// Service (primary export)
export { startMakeMeaning } from './service';
export type { MakeMeaningService, MakeMeaningConfig } from './service';

// Bootstrap
export { bootstrapEntityTypes, resetBootstrap } from './bootstrap/entity-types';

// Views
export { readEntityTypesProjection } from './views/entity-types-reader';

// Knowledge Base
export { createKnowledgeBase } from './knowledge-base';
export type { KnowledgeBase } from './knowledge-base';

// Actors
export { Gatherer } from './gatherer';
export { Matcher } from './matcher';
export { Stower } from './stower';
export type { CreateResourceResult } from './stower';
export { CloneTokenManager } from './clone-token-manager';

// Graph Consumer
export { GraphDBConsumer } from './graph/consumer';

// Exchange (import/export)
export * from './exchange';

// Resource operations
export { ResourceOperations } from './resource-operations';
export type { UpdateResourceInput, CreateResourceInput } from './resource-operations';

// Annotation assembly (pure functions)
export { assembleAnnotation, applyBodyOperations } from './annotation-assembly';
export type { AssembledAnnotation } from './annotation-assembly';

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

// Generation exports (context-building reads stay here; generateResourceFromTopic moved to @semiont/jobs)
export {
  generateResourceSummary,
  generateReferenceSuggestions,
} from './generation/resource-generation';

// Placeholder for initial build
export const PACKAGE_NAME = '@semiont/make-meaning';
export const VERSION = '0.1.0';
