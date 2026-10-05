// @semiont/make-meaning - Making meaning from resources
// Transforms raw resources into meaningful, interconnected knowledge

// Service (primary export)
export { startMakeMeaning } from './service';
export type { MakeMeaningService, MakeMeaningConfig } from './service';

// The Archivist's address, and the byte read that rides it, live in
// `@semiont/content`: the Worker needs them too, and `make-meaning` depends on
// `jobs`, so a shared fact has to sit under both.
export { makeMeaningConfigFrom, requireKBName } from './config';

// Knowledge System
export type { KnowledgeSystem } from './knowledge-system';
export { stopKnowledgeSystem } from './knowledge-system';

// Local transport (in-process ITransport / IContentTransport for the SemiontClient)
export { LocalTransport, type LocalTransportConfig } from './local-transport';
export { LocalContentTransport } from './local-content-transport';
// In-process BusRequestPrimitive over a raw EventBus — callers beside the
// bus they ask (e.g. the entity-type bootstrap, the Archivist's recording
// upload) share busRequest's correlated request/reply path.
export { asBusRequestPrimitive } from './bus-request-local';

// Bus command handlers — registered automatically by `startMakeMeaning`;
// also exported individually for callers that bring their own bootstrap.
export {
  registerBusHandlers,
  registerAnnotationAssemblyHandler,
  registerAnnotationContextHandler,
  registerGatherSummaryHandler,
  registerBindUpdateBodyHandler,
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

// Smelter — event-to-vector pipeline plus its domain-event fan-in.
// `smelter-main` (the standalone container entry point) wires the two together;
// both are exported for callers that want to run the pipeline on top of their
// own `BusRequestPrimitive`.
export {
  Smelter,
  type ReconcileSummary,
  type ReconcileState,
  type SmelterTiming,
  type SmelterWorkItem,
  type SmelterInput,
} from './smelter';
export {
  smelterFanIn,
  type SmelterFanIn,
  type SmelterEvent,
} from './smelter-fan-in';

// Annotation operations
export { AnnotationOperations } from './annotation-operations';
export type { CreateAnnotationResult, UpdateAnnotationBodyResult } from './annotation-operations';

// Context assembly exports
export { ResourceContext } from './resource-context';
export type { ListResourcesFilters, ListResourcesResult } from './resource-context';
export { anchoredTextOverBus } from './anchored-text-ask';
export type { AnchoredTextAsk } from './anchored-text-ask';
export { AnnotationContext } from './annotation-context';
export type { BuildContextOptions } from './annotation-context';
export { GraphContext } from './graph-context';
// The graph shape is the core/spec type `KnowledgeGraph` (`@semiont/core`).
export { LLMContext } from './llm-context';
export type { LLMContextOptions } from './llm-context';

// Generation exports: the context-building reads. Topic generation
// (`generateResourceFromTopic`) is in `@semiont/jobs`.
export {
  generateResourceSummary,
  generateReferenceSuggestions,
} from './generation/resource-generation';
