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
 * The gateway's handler subset (EXTRACT-ARCHIVIST P3, EXTRACT-LIBRARIAN P3).
 * Annotation-assembly is deliberately ABSENT: it consumes the `mark:added`
 * facts Stower produces, so it registers in archivist-main beside that
 * Stower (D2 i) — registering it here too would double-emit `mark:create`
 * and double-append. Gather-summary is likewise ABSENT: it calls the
 * Gatherer, which lives in librarian-main; it registers there beside its
 * actor. The annotation-context read stays here because it reads BYTES, and
 * the gateway is the byte path (GATEWAY.md D4).
 */
export function registerGatewayBusHandlers(
  eventBus: EventBus,
  kb: KnowledgeSystem['kb'],
  jobQueue: JobQueue,
  project: SemiontProject,
  logger: Logger,
): void {
  registerAnnotationContextHandler(
    eventBus,
    { views: kb.views, content: workingTreeContentReads(kb.views, kb.content) },
    logger,
  );
  registerBindUpdateBodyHandler(eventBus, logger);
  registerJobCommandHandlers(eventBus, jobQueue, project, logger);
}
