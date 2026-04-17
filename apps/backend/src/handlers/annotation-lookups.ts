import { annotationId, resourceId as makeResourceId } from '@semiont/core';
import type { EventBus } from '@semiont/core';
import { AnnotationContext } from '@semiont/make-meaning';
import type { KnowledgeBase } from '@semiont/make-meaning';
import { getLogger } from '../logger';

const logger = () => getLogger().child({ component: 'annotation-lookups' });

interface Gatherer {
  generateAnnotationSummary(annotationId: ReturnType<typeof annotationId>, resourceId: ReturnType<typeof makeResourceId>): Promise<Record<string, unknown>>;
}

export function registerAnnotationLookupHandlers(
  eventBus: EventBus,
  kb: KnowledgeBase,
  gatherer: Gatherer,
): void {
  eventBus.get('browse:annotation-context-requested').subscribe(async (command) => {
    const { correlationId } = command as Record<string, unknown>;
    const annId = (command as Record<string, unknown>).annotationId as string;
    const resId = (command as Record<string, unknown>).resourceId as string;
    const contextBefore = ((command as Record<string, unknown>).contextBefore as number) ?? 100;
    const contextAfter = ((command as Record<string, unknown>).contextAfter as number) ?? 100;

    try {
      const response = await AnnotationContext.getAnnotationContext(
        annotationId(annId),
        makeResourceId(resId),
        contextBefore,
        contextAfter,
        kb,
      );

      (eventBus.get('browse:annotation-context-result') as { next(v: unknown): void }).next({
        correlationId,
        response,
      });
    } catch (error) {
      logger().warn('annotation-context failed', { correlationId, error: (error as Error).message });
      (eventBus.get('browse:annotation-context-failed') as { next(v: unknown): void }).next({
        correlationId,
        message: (error as Error).message,
      });
    }
  });

  eventBus.get('gather:summary-requested').subscribe(async (command) => {
    const { correlationId } = command as Record<string, unknown>;
    const annId = (command as Record<string, unknown>).annotationId as string;
    const resId = (command as Record<string, unknown>).resourceId as string;

    try {
      const response = await gatherer.generateAnnotationSummary(
        annotationId(annId),
        makeResourceId(resId),
      );

      (eventBus.get('gather:summary-result') as { next(v: unknown): void }).next({
        correlationId,
        response,
      });
    } catch (error) {
      logger().warn('gather:summary failed', { correlationId, error: (error as Error).message });
      (eventBus.get('gather:summary-failed') as { next(v: unknown): void }).next({
        correlationId,
        message: (error as Error).message,
      });
    }
  });
}
