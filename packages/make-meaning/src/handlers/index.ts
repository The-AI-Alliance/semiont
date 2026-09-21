/**
 * Bus command handlers — pure bus-event translators that bridge the
 * "request" channels callers emit (`mark:create-request`, `bind:update-body`,
 * `job:create`, `browse:annotation-context-requested`,
 * `gather:summary-requested`) to the underlying make-meaning pipeline
 * (Stower, Browser, Gatherer, JobQueue).
 *
 * These ran in `apps/gateway` historically because the HTTP gateway was
 * the only consumer that needed them. They are not HTTP-specific — moving
 * them here means `LocalTransport` consumers (and any future transport)
 * get the same contract automatically.
 */

import type { EventBus, EventMap, Logger } from '@semiont/core';
import type { SemiontState } from '@semiont/core/node';
import type { JobQueue } from '@semiont/jobs';

import type { KnowledgeSystem } from '../knowledge-system.js';
import { workingTreeContentReads } from '../knowledge-base.js';
import { anchoredTextOverBus } from '../anchored-text-ask.js';
import { asBusRequestPrimitive } from '../bus-request-local.js';
import { registerAnnotationAssemblyHandler } from './annotation-assembly.js';
import { registerAnnotationContextHandler, registerGatherSummaryHandler } from './annotation-lookups.js';
import { registerBindUpdateBodyHandler } from './bind-update-body.js';
import { registerJobCommandHandlers } from './job-commands.js';

export {
  registerAnnotationAssemblyHandler,
  registerAnnotationContextHandler,
  registerGatherSummaryHandler,
  registerBindUpdateBodyHandler,
  registerJobCommandHandlers,
};

/**
 * The `job:*` command channels `registerJobCommandHandlers` subscribes. Two
 * consumers reference this ONE list rather than restating it: the in-process /
 * embedding root (`HANDLER_CHANNELS` below, since `startMakeMeaning` registers
 * the job handlers on its own bus) and the DISPATCHER's inbound roster
 * (`service-channels.ts`) — the service that owns these handlers in the
 * deployed fleet (EXTRACT-JOBS P2). The census gate beside these files
 * (job-command-census.test.ts) pins list == actual subscriptions — the gap
 * that let `job:checkpoint`/`job:cancel` go unlisted here until 2026-09-15.
 */
export const JOB_COMMAND_CHANNELS = [
  'job:create', 'job:claim', 'job:complete', 'job:fail',
  'job:report-progress', 'job:checkpoint', 'job:cancel-requested', 'job:cancel',
  'job:status-requested',
] as const satisfies readonly (keyof EventMap)[];

/**
 * Every channel the handlers above SUBSCRIBE — the handlers' half of the
 * root-parity gate (root-parity.test.ts), which asserts the in-process
 * composition root observes all of these. The job-command subset is DERIVED
 * from `JOB_COMMAND_CHANNELS`, not restated.
 */
export const HANDLER_CHANNELS = [
  // annotation-assembly
  'mark:create-request', 'mark:added', 'mark:create-failed',
  // annotation-lookups
  'browse:annotation-context-requested', 'gather:summary-requested',
  // bind-update-body — Archivist-resident now, but the in-process root still
  // registers it, so it is listed here rather than reached via the job-command set.
  'bind:update-body', 'mark:body-updated', 'mark:body-update-failed',
  ...JOB_COMMAND_CHANNELS,
] as const satisfies readonly (keyof EventMap)[];

/**
 * Register all bus command handlers on the make-meaning EventBus. Called
 * during `startMakeMeaning` after the JobQueue and KnowledgeSystem exist.
 */
export function registerBusHandlers(
  eventBus: EventBus,
  // Narrowed to what this actually reaches for — the KB and one actor — rather
  // than the whole bundle. DERIVED from KnowledgeSystem with Pick, so it cannot
  // drift from that definition, and a full KnowledgeSystem still satisfies it.
  knowledgeSystem: Pick<KnowledgeSystem, 'kb' | 'gatherer'>,
  jobQueue: JobQueue,
  state: SemiontState,
  logger: Logger,
): void {
  const { kb } = knowledgeSystem;
  registerAnnotationAssemblyHandler(eventBus, kb, logger);
  registerAnnotationContextHandler(
    eventBus,
    {
      views: kb.views,
      content: workingTreeContentReads(kb.views, kb.content),
      // Derived text rides the same bus read everywhere; in this root the
      // Browser answers in-process.
      anchoredText: anchoredTextOverBus(asBusRequestPrimitive(eventBus)),
    },
    logger,
  );
  registerGatherSummaryHandler(eventBus, knowledgeSystem.gatherer, logger);
  registerBindUpdateBodyHandler(eventBus, logger);
  registerJobCommandHandlers(eventBus, jobQueue, state, logger);
}
