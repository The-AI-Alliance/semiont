// Stateful units in `@semiont/sdk` — RxJS-shaped state machines and
// worker adapters that any consumer (web, terminal, mobile, daemon, AI
// agent) can subscribe to. The directory is named "state" rather than
// "view-models" because none of the contents presume a UI:
//
//   flows/   — wrap each of the seven flows in a stateful machine
//              (loading/error/pending observables, awaitable + reactive)
//   workers/ — worker-side adapters (already used headlessly by `@semiont/jobs`)
//   lib/     — substrate (`ViewModel` disposable interface, search pipeline,
//              `WorkerBus` channel-IO interface)
//
// Page-shaped state (admin tables, page routing, web shell) lives in
// `@semiont/react-ui` next to the components that render it — those are
// framework-neutral but tied to the Semiont web frontend's page taxonomy
// and don't apply to a TUI / mobile / daemon consumer.

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

// ── Worker adapters ─────────────────────────────────────────────────────

export {
  createSmelterActorVM,
  type SmelterActorVM,
  type SmelterActorVMOptions,
  type SmelterEvent,
} from './workers/smelter-actor-vm';
export {
  createJobClaimAdapter,
  type JobClaimAdapter,
  type JobClaimAdapterOptions,
  type JobAssignment,
  type ActiveJob,
} from './workers/job-claim-adapter';
export {
  createJobQueueVM,
  type JobQueueVM,
  type Job,
} from './workers/job-queue-vm';

export type { ConnectionState } from '@semiont/core';
