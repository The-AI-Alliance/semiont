// @semiont/make-meaning — the services that keep, index and find a knowledge
// base's contents. Each runs from its own entry point (`./archivist-main`,
// `./librarian-main`, `./smelter-main`, `./weaver-main`); what is exported
// here is what a caller composing its own process builds from.

export { makeMeaningConfigFrom, requireKBName } from './config';
export type { MakeMeaningConfig } from './config';

// In-process BusRequestPrimitive over a raw EventBus.
export { asBusRequestPrimitive } from './bus-request-local';

// Librarian
export { Gatherer } from './gatherer';
export { Matcher } from './matcher';
export { registerGatherSummaryHandler } from './handlers/gather-summary';

// Smelter — event-to-vector pipeline plus its domain-event fan-in.
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

// Context assembly
export { ResourceContext } from './resource-context';
export type { ListResourcesFilters, ListResourcesResult } from './resource-context';
export { anchoredTextOverBus } from './anchored-text-ask';
export type { AnchoredTextAsk } from './anchored-text-ask';
export { AnnotationContext } from './annotation-context';
export { AnnotationGather } from './annotation-gather';
export type { BuildContextOptions } from './annotation-gather';
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
