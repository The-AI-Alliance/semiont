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

// Generation exports (context-building reads stay here; generateResourceFromTopic moved to @semiont/jobs)
export {
  generateResourceSummary,
  generateReferenceSuggestions,
} from './generation/resource-generation';

// ID generation (re-export from core for backward compatibility during migration)
export { generateUuid } from '@semiont/core';

// Placeholder for initial build
export const PACKAGE_NAME = '@semiont/make-meaning';
export const VERSION = '0.1.0';
