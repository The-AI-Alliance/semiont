/**
 * `browse:annotation-context-requested` is a views+content read, so it
 * registers in the process that holds both.
 */

import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';
import type { EventBus, Logger } from '@semiont/core';
import type { ViewStorage } from '@semiont/event-sourcing';
import type { ContentReads } from '@semiont/content';

import { AnnotationContext } from '../annotation-context.js';
import type { AnchoredTextAsk } from '../anchored-text-ask.js';

export function registerAnnotationContextHandler(
  eventBus: EventBus,
  kb: { views: Pick<ViewStorage, 'get'>; content: ContentReads; anchoredText: AnchoredTextAsk },
  parentLogger: Logger,
): void {
  const logger = parentLogger.child({ component: 'annotation-context' });

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
