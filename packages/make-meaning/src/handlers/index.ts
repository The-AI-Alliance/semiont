/**
 * Bus command handlers — pure bus-event translators that bridge the
 * "request" channels callers emit (`mark:create-request`, `bind:update-body`,
 * `browse:annotation-context-requested`, `gather:summary-requested`) to the
 * underlying make-meaning pipeline (Stower, Browser, Gatherer).
 *
 * These ran in `apps/gateway` historically because the HTTP gateway was
 * the only consumer that needed them. They are not HTTP-specific — moving
 * them here means `LocalTransport` consumers (and any future transport)
 * get the same contract automatically.
 */

import type { EventBus, EventMap, Logger } from '@semiont/core';

import type { KnowledgeSystem } from '../knowledge-system.js';
import { workingTreeContentReads } from '../knowledge-base.js';
import { anchoredTextOverBus } from '../anchored-text-ask.js';
import { asBusRequestPrimitive } from '../bus-request-local.js';
import { registerAnnotationAssemblyHandler } from './annotation-assembly.js';
import { registerAnnotationContextHandler, registerGatherSummaryHandler } from './annotation-lookups.js';
import { registerBindUpdateBodyHandler } from './bind-update-body.js';

export {
  registerAnnotationAssemblyHandler,
  registerAnnotationContextHandler,
  registerGatherSummaryHandler,
  registerBindUpdateBodyHandler,
};

/**
 * Every channel the handlers above SUBSCRIBE — the handlers' half of the
 * root-parity gate (root-parity.test.ts), which asserts the in-process
 * composition root observes all of these.
 */
export const HANDLER_CHANNELS = [
  // annotation-assembly
  'mark:create-request', 'mark:added', 'mark:create-failed',
  // annotation-lookups
  'browse:annotation-context-requested', 'gather:summary-requested',
  // bind-update-body — Archivist-resident now, but the in-process root still
  // registers it, so it is listed here.
  'bind:update-body', 'mark:body-updated', 'mark:body-update-failed',
] as const satisfies readonly (keyof EventMap)[];

/**
 * Register all bus command handlers on the make-meaning EventBus. Called
 * during `startMakeMeaning` after the KnowledgeSystem exists.
 */
export function registerBusHandlers(
  eventBus: EventBus,
  // Narrowed to what this actually reaches for — the KB and one actor — rather
  // than the whole bundle. DERIVED from KnowledgeSystem with Pick, so it cannot
  // drift from that definition, and a full KnowledgeSystem still satisfies it.
  knowledgeSystem: Pick<KnowledgeSystem, 'kb' | 'gatherer'>,
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
}
