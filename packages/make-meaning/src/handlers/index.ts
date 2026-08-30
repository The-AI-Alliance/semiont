/**
 * Bus command handlers — pure bus-event translators that bridge the
 * "request" channels callers emit (`mark:create-request`, `bind:update-body`,
 * `job:create`, `browse:annotation-context-requested`,
 * `gather:summary-requested`) to the underlying make-meaning pipeline
 * (Stower, Browser, Gatherer, JobQueue).
 *
 * These ran in `apps/backend` historically because the HTTP gateway was
 * the only consumer that needed them. They are not HTTP-specific — moving
 * them here means `LocalTransport` consumers (and any future transport)
 * get the same contract automatically.
 */

import type { EventBus, Logger } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import type { JobQueue } from '@semiont/jobs';

import type { KnowledgeSystem } from '../knowledge-system.js';
import { workingTreeContentReads } from '../knowledge-base.js';
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
 * Register all bus command handlers on the make-meaning EventBus. Called
 * during `startMakeMeaning` after the JobQueue and KnowledgeSystem exist.
 */
export function registerBusHandlers(
  eventBus: EventBus,
  knowledgeSystem: KnowledgeSystem,
  jobQueue: JobQueue,
  project: SemiontProject,
  logger: Logger,
): void {
  const { kb } = knowledgeSystem;
  registerAnnotationAssemblyHandler(eventBus, kb, logger);
  registerAnnotationContextHandler(
    eventBus,
    { views: kb.views, content: workingTreeContentReads(kb.views, kb.content) },
    logger,
  );
  registerGatherSummaryHandler(eventBus, knowledgeSystem.gatherer, logger);
  registerBindUpdateBodyHandler(eventBus, logger);
  registerJobCommandHandlers(eventBus, jobQueue, project, logger);
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
  project: SemiontProject,
  logger: Logger,
): void {
  registerBindUpdateBodyHandler(eventBus, logger);
  registerJobCommandHandlers(eventBus, jobQueue, project, logger);
}
