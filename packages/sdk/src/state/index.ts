// Stateful units in `@semiont/sdk` — RxJS-shaped state machines that any
// consumer (web, terminal, mobile, daemon, AI agent) can subscribe to.
// The directory is named "state" rather than "view-models" because none
// of the contents presume a UI:
//
//   flows/   — wrap each of the seven flows in a stateful machine
//              (loading/error/pending observables, awaitable + reactive)
//   lib/     — substrate (`ViewModel` disposable interface, search pipeline,
//              `WorkerBus` channel-IO interface)
//
// Domain-specific worker adapters live with their domain, not here.
// `@semiont/jobs` houses `createJobClaimAdapter` and `createJobQueueVM`
// (the job-claim protocol runtime + the jobs-list state observer).
// `@semiont/make-meaning` houses `createSmelterActorVM` (the
// domain-event fan-in for the Smelter worker, co-located with the
// Smelter actor and its `smelter-main` entry point).
//
// Page-shaped state (admin tables, page routing, web shell) lives in
// `@semiont/react-ui` next to the components that render it.

export { type ViewModel, createDisposer } from './lib/view-model';
export {
  createSearchPipeline,
  type SearchPipeline,
  type SearchPipelineOptions,
  type SearchState,
} from './lib/search-pipeline';
export type { WorkerBus } from './lib/worker-bus';

// ── Flow VMs ────────────────────────────────────────────────────────────

export {
  createBeckonVM,
  type BeckonVM,
  createHoverHandlers,
  type HoverHandlers,
  HOVER_DELAY_MS,
} from './flows/beckon-vm';
export {
  createGatherVM,
  type GatherVM,
} from './flows/gather-vm';
export {
  createMatchVM,
  type MatchVM,
} from './flows/match-vm';
export {
  createYieldVM,
  type YieldVM,
  type GenerateDocumentOptions,
} from './flows/yield-vm';
export {
  createMarkVM,
  type MarkVM,
  type PendingAnnotation,
} from './flows/mark-vm';

export type { ConnectionState } from '@semiont/core';
