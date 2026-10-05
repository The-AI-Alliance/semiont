/**
 * `gather:summary-requested` calls the Gatherer's inference path, so it
 * registers beside the Gatherer, in the Librarian.
 */

import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';
import type { EventBus, Logger } from '@semiont/core';

import type { Gatherer } from '../gatherer.js';

export function registerGatherSummaryHandler(
  eventBus: EventBus,
  gatherer: Pick<Gatherer, 'generateAnnotationSummary'>,
  parentLogger: Logger,
): void {
  const logger = parentLogger.child({ component: 'gather-summary' });

  eventBus.frames('gather:summary-requested').subscribe(async ({ payload: command, correlationId }) => {
    const annId = (command as Record<string, unknown>).annotationId as string;
    const resId = (command as Record<string, unknown>).resourceId as string;

    try {
      const response = await gatherer.generateAnnotationSummary(
        makeAnnotationId(annId),
        makeResourceId(resId),
      );

      eventBus.emit('gather:summary-result', { response, }, { correlationId });
    } catch (error) {
      logger.warn('gather:summary failed', { correlationId, error: (error as Error).message });
      eventBus.emit('gather:summary-failed', { message: (error as Error).message, }, { correlationId });
    }
  });
}
