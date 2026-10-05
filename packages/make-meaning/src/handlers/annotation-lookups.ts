/**
 * Annotation lookup handlers — split by where each one's capabilities live:
 *
 * - `browse:annotation-context-requested` is a pure views+content read with
 *   no Gatherer. It registers wherever those capabilities live — the
 *   Archivist and the standalone root.
 * - `gather:summary-requested` calls the Gatherer's inference path, so it
 *   follows the Gatherer (as annotation assembly follows the Stower in the
 *   Archivist): the standalone root and librarian-main register it beside
 *   their Gatherer.
 */

import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';
import type { EventBus, Logger } from '@semiont/core';
import type { ViewStorage } from '@semiont/event-sourcing';

import { AnnotationContext } from '../annotation-context.js';
import type { ContentReads } from '@semiont/content';
import type { AnchoredTextAsk } from '../anchored-text-ask.js';
import type { Gatherer } from '../gatherer.js';

export function registerAnnotationContextHandler(
  eventBus: EventBus,
  kb: { views: Pick<ViewStorage, 'get'>; content: ContentReads; anchoredText: AnchoredTextAsk },
  parentLogger: Logger,
): void {
  const logger = parentLogger.child({ component: 'annotation-lookups' });

  eventBus.frames('browse:annotation-context-requested').subscribe(async ({ payload: command, correlationId }) => {
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

      eventBus.emit('browse:annotation-context-result', { response, }, { correlationId });
    } catch (error) {
      logger.warn('annotation-context failed', { correlationId, error: (error as Error).message });
      eventBus.emit('browse:annotation-context-failed', { message: (error as Error).message, }, { correlationId });
    }
  });
}

export function registerGatherSummaryHandler(
  eventBus: EventBus,
  gatherer: Pick<Gatherer, 'generateAnnotationSummary'>,
  parentLogger: Logger,
): void {
  const logger = parentLogger.child({ component: 'annotation-lookups' });

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
