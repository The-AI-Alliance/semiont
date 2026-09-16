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
 * Every channel the GATEWAY-RESIDENT handler subset SUBSCRIBES
 * (`registerGatewayBusHandlers`: bind-update-body + job-commands), complete
 * — in-process relays included — and maintained beside the handlers. The
 * gateway's signal bridge (SIGNAL-PLANE P3) consumes this to reconnect the
 * handlers to a remote plane, deriving the wire subset by direction from
 * the generated classification; the census gate beside these files
 * (gateway-handler-census.test.ts) pins list == actual subscriptions —
 * the gap that let `job:checkpoint`/`job:cancel` go unlisted here until
 * 2026-09-15.
 */
export const GATEWAY_HANDLER_CHANNELS = [
  // bind-update-body
  'bind:update-body', 'mark:body-updated', 'mark:body-update-failed',
  // job-commands
  'job:create', 'job:claim', 'job:complete', 'job:fail',
  'job:report-progress', 'job:checkpoint', 'job:cancel-requested', 'job:cancel',
  'job:status-requested',
] as const satisfies readonly (keyof EventMap)[];

/**
 * Every channel that same subset EMITS (`.next`), complete and censused the
 * same way. The bridge's outbound half: wire-bound entries leave the bus
 * through `plane.ingest`, so a handler's reply reaches a remote plane's
 * subscribers — the other half of the q0(a) funnel.
 */
export const GATEWAY_HANDLER_EMITS = [
  // bind-update-body
  'mark:update-body', 'bind:body-updated', 'bind:body-update-failed',
  // job-commands
  'job:created', 'job:create-failed', 'job:claimed', 'job:claim-failed',
  'job:cancel-ok', 'job:cancel-failed', 'job:status-result', 'job:status-failed',
] as const satisfies readonly (keyof EventMap)[];

/**
 * Every channel the handlers above SUBSCRIBE — the handlers' half of the
 * root-parity gate (root-parity.test.ts), which asserts the in-process
 * composition root observes all of these. The gateway subset is DERIVED
 * from its own constant, not restated.
 */
export const HANDLER_CHANNELS = [
  // annotation-assembly
  'mark:create-request', 'mark:added', 'mark:create-failed',
  // annotation-lookups
  'browse:annotation-context-requested', 'gather:summary-requested',
  ...GATEWAY_HANDLER_CHANNELS,
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

/**
 * The gateway's handler subset (EXTRACT-ARCHIVIST P3, EXTRACT-LIBRARIAN P3,
 * SINGLE-KB-MOUNT P3). Every handler that reads the KB is ABSENT, each
 * beside what it consumes: annotation-assembly follows the `mark:added` facts
 * its Stower produces (D2 i — registering it here too would double-emit
 * `mark:create` and double-append); gather-summary follows the Gatherer into
 * librarian-main; and **annotation-context followed the BYTES into
 * archivist-main** (SINGLE-KB-MOUNT D5). That last one sat here on the
 * premise that "the gateway is the byte path" (GATEWAY.md D4) — D1 reversed
 * the premise, so the conclusion went with it.
 *
 * What remains is what the gateway genuinely owns: the bind re-emit and the
 * job queue it hosts.
 */
export function registerGatewayBusHandlers(
  eventBus: EventBus,
  jobQueue: JobQueue,
  state: SemiontState,
  logger: Logger,
): void {
  registerBindUpdateBodyHandler(eventBus, logger);
  registerJobCommandHandlers(eventBus, jobQueue, state, logger);
}
