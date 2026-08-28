/**
 * Annotation lookup handlers — split along the EXTRACT-LIBRARIAN P3 cutover:
 *
 * - `browse:annotation-context-requested` is a pure views+content read with
 *   no Gatherer. It registers wherever those capabilities live — the gateway
 *   and the standalone root.
 * - `gather:summary-requested` calls the Gatherer's inference path, so it
 *   follows the Gatherer (the Archivist's D2-i pattern): the standalone root
 *   and librarian-main register it beside their Gatherer; the gateway does
 *   NOT.
 */

import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';
import type { EventBus, Logger } from '@semiont/core';
import type { ViewStorage } from '@semiont/event-sourcing';

import { AnnotationContext } from '../annotation-context.js';
import type { ContentReads } from '../knowledge-base.js';
import type { Gatherer } from '../gatherer.js';

export function registerAnnotationContextHandler(
  eventBus: EventBus,
  kb: { views: Pick<ViewStorage, 'get'>; content: ContentReads },
  parentLogger: Logger,
): void {
  const logger = parentLogger.child({ component: 'annotation-lookups' });

  eventBus.get('browse:annotation-context-requested').subscribe(async (command) => {
    const { correlationId } = command;
    const annId = (command as Record<string, unknown>).annotationId as string;
    const resId = (command as Record<string, unknown>).resourceId as string;
    const contextBefore = ((command as Record<string, unknown>).contextBefore as number) ?? 100;
    const contextAfter = ((command as Record<string, unknown>).contextAfter as number) ?? 100;

    try {
      const response = await AnnotationContext.getAnnotationContext(
        makeAnnotationId(annId),
        makeResourceId(resId),
        contextBefore,
        contextAfter,
        kb,
      );

      eventBus.get('browse:annotation-context-result').next({
        correlationId,
        response,
      });
    } catch (error) {
      logger.warn('annotation-context failed', { correlationId, error: (error as Error).message });
      eventBus.get('browse:annotation-context-failed').next({
        correlationId,
        message: (error as Error).message,
      });
    }
  });
}

export function registerGatherSummaryHandler(
  eventBus: EventBus,
  gatherer: Pick<Gatherer, 'generateAnnotationSummary'>,
  parentLogger: Logger,
): void {
  const logger = parentLogger.child({ component: 'annotation-lookups' });

  eventBus.get('gather:summary-requested').subscribe(async (command) => {
    const { correlationId } = command;
    const annId = (command as Record<string, unknown>).annotationId as string;
    const resId = (command as Record<string, unknown>).resourceId as string;

    try {
      const response = await gatherer.generateAnnotationSummary(
        makeAnnotationId(annId),
        makeResourceId(resId),
      );

      eventBus.get('gather:summary-result').next({
        correlationId,
        response,
      });
    } catch (error) {
      logger.warn('gather:summary failed', { correlationId, error: (error as Error).message });
      eventBus.get('gather:summary-failed').next({
        correlationId,
        message: (error as Error).message,
      });
    }
  });
}
