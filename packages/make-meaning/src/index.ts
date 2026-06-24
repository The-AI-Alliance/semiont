// @semiont/make-meaning - Making meaning from resources
// Transforms raw resources into meaningful, interconnected knowledge

// Service (primary export)
export { startMakeMeaning } from './service';
export type { MakeMeaningService, MakeMeaningConfig } from './service';

// Knowledge System
export type { KnowledgeSystem } from './knowledge-system';
export { stopKnowledgeSystem } from './knowledge-system';

// Local transport (in-process ITransport / IContentTransport for the SemiontClient)
export { LocalTransport, type LocalTransportConfig } from './local-transport';
export { LocalContentTransport } from './local-content-transport';

// Bus command handlers — registered automatically by `startMakeMeaning`;
// also exported individually for callers that bring their own bootstrap.
export {
  registerBusHandlers,
  registerAnnotationAssemblyHandler,
  registerAnnotationLookupHandlers,
  registerBindUpdateBodyHandler,
  registerJobCommandHandlers,
} from './handlers';

// Bootstrap
export { bootstrapEntityTypes } from './bootstrap/entity-types';

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
export { Browser } from './browser';
export { CloneTokenManager } from './clone-token-manager';

// Smelter — event-to-vector pipeline plus its domain-event fan-in state unit.
// `smelter-main` (the standalone container entry point) wires the two together;
// both are exported for callers that want to run the pipeline on top of their
// own `WorkerBus`.
export {
  Smelter,
  type ReconcileSummary,
  type ReconcileState,
  type SmelterTiming,
  type SmelterWorkItem,
  type SmelterInput,
} from './smelter';
export {
  createSmelterActorStateUnit,
  type SmelterActorStateUnit,
  type SmelterActorStateUnitOptions,
  type SmelterEvent,
} from './smelter-actor-state-unit';

// Exchange (import/export)
export * from './exchange';

// Resource operations
export { ResourceOperations } from './resource-operations';
export type { CreateResourceInput } from './resource-operations';

// Annotation operations
export { AnnotationOperations } from './annotation-operations';
export type { CreateAnnotationResult, UpdateAnnotationBodyResult } from './annotation-operations';

// Context assembly exports
export { ResourceContext } from './resource-context';
export type { ListResourcesFilters } from './resource-context';
export { AnnotationContext } from './annotation-context';
export type { BuildContextOptions } from './annotation-context';
export { GraphContext } from './graph-context';
// The graph shape is the core/spec type `KnowledgeGraph` (`@semiont/core`);
// make-meaning no longer defines local graph-shape twins.
export { LLMContext } from './llm-context';
export type { LLMContextOptions } from './llm-context';

// Generation exports (context-building reads stay here; generateResourceFromTopic moved to @semiont/jobs)
export {
  generateResourceSummary,
  generateReferenceSuggestions,
} from './generation/resource-generation';
