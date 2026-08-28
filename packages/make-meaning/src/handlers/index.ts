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
import { registerAnnotationAssemblyHandler } from './annotation-assembly.js';
import { registerAnnotationLookupHandlers } from './annotation-lookups.js';
import { registerBindUpdateBodyHandler } from './bind-update-body.js';
import { registerJobCommandHandlers } from './job-commands.js';

export {
  registerAnnotationAssemblyHandler,
  registerAnnotationLookupHandlers,
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
  registerAnnotationAssemblyHandler(eventBus, knowledgeSystem.kb, logger);
  registerAnnotationLookupHandlers(eventBus, knowledgeSystem.kb, knowledgeSystem.gatherer, logger);
  registerBindUpdateBodyHandler(eventBus, logger);
  registerJobCommandHandlers(eventBus, jobQueue, project, logger);
}

/**
 * The gateway's handler subset (EXTRACT-ARCHIVIST P3). Annotation-assembly
 * is deliberately ABSENT: it consumes the `mark:added` facts Stower produces,
 * so it registers in archivist-main beside that Stower (D2 i). Registering
 * it here too would double-emit `mark:create` and double-append.
 */
export function registerGatewayBusHandlers(
  eventBus: EventBus,
  kb: KnowledgeSystem['kb'],
  gatherer: KnowledgeSystem['gatherer'],
  jobQueue: JobQueue,
  project: SemiontProject,
  logger: Logger,
): void {
  registerAnnotationLookupHandlers(eventBus, kb, gatherer, logger);
  registerBindUpdateBodyHandler(eventBus, logger);
  registerJobCommandHandlers(eventBus, jobQueue, project, logger);
}
