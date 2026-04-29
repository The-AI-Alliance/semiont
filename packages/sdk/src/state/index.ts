// State units in `@semiont/sdk` — RxJS-shaped state machines that any
// consumer (web, terminal, mobile, daemon, AI agent) can subscribe to.
// None presume a UI. See packages/sdk/docs/STATE-UNITS.md for the pattern.
//
//   flows/   — wrap the long-running content flows in stateful machines
//              (loading/error/pending observables, awaitable + reactive).
//              Currently five state units (mark, gather, match, yield, beckon).
//              The eighth flow, Frame, has no state unit — its MVP methods
//              are atomic `Promise<void>` writes with no progress
//              observables; a Frame state unit lands when the surface earns one.
//   lib/     — substrate (`StateUnit` disposable interface, search pipeline,
//              `WorkerBus` channel-IO interface)
//
// Domain-specific worker adapters live with their domain, not here.
// `@semiont/jobs` houses `createJobClaimAdapter` and `createJobQueueStateUnit`
// (the job-claim protocol runtime + the jobs-list state observer).
// `@semiont/make-meaning` houses `createSmelterActorStateUnit` (the
// domain-event fan-in for the Smelter worker, co-located with the
// Smelter actor and its `smelter-main` entry point).
//
// Page-shaped state (admin tables, page routing, web shell) lives in
// `@semiont/react-ui` next to the components that render it.

export { type StateUnit, createDisposer } from './lib/state-unit';
export {
  createSearchPipeline,
  type SearchPipeline,
  type SearchPipelineOptions,
  type SearchState,
} from './lib/search-pipeline';
export type { WorkerBus } from './lib/worker-bus';

// ── Flow state units ────────────────────────────────────────────────────

export {
  createBeckonStateUnit,
  type BeckonStateUnit,
  createHoverHandlers,
  type HoverHandlers,
  HOVER_DELAY_MS,
} from './flows/beckon-state-unit';
export {
  createGatherStateUnit,
  type GatherStateUnit,
} from './flows/gather-state-unit';
export {
  createMatchStateUnit,
  type MatchStateUnit,
} from './flows/match-state-unit';
export {
  createYieldStateUnit,
  type YieldStateUnit,
  type GenerateDocumentOptions,
} from './flows/yield-state-unit';
export {
  createMarkStateUnit,
  type MarkStateUnit,
  type PendingAnnotation,
} from './flows/mark-state-unit';

export type { ConnectionState } from '@semiont/core';
