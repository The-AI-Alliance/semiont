import { resourceId, userId, didToAgent, assembleAnnotation } from '@semiont/core';
import type { EventBus, Logger, components } from '@semiont/core';

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];

/**
 * Handles `mark:create-request` — the bus command for creating an annotation.
 *
 * Flow:
 *   1. Assemble the W3C annotation from the request using the injected user DID.
 *   2. Emit `mark:create` with the correlationId threaded through.
 *   3. Stower picks up `mark:create`, appends to the event store (threading
 *      correlationId into event metadata), and publishes `mark:added` on the
 *      core EventBus.
 *   4. This handler subscribes to `mark:added` and `mark:create-failed`,
 *      matches by correlationId, and emits `mark:create-ok` / `mark:create-failed`
 *      to the caller only after persistence has actually completed.
 *
 * This is a deferred-ack pattern: the result event attests that Stower has
 * persisted the annotation, not merely that the command was well-formed.
 */
export function registerAnnotationAssemblyHandler(eventBus: EventBus, parentLogger: Logger): void {
  const logger = parentLogger.child({ component: 'annotation-assembly' });
  const inflight = new Map<string, { annotationId: string }>();

  eventBus.get('mark:create-request').subscribe((command) => {
    const { correlationId, resourceId: resId, request, _userId } = command as Record<string, unknown>;
    const cid = correlationId as string | undefined;

    try {
      if (!_userId || typeof _userId !== 'string') {
        throw new Error('_userId is required (injected by bus gateway)');
      }
      if (!cid) {
        throw new Error('correlationId is required on mark:create-request');
      }

      const agent = didToAgent(_userId);
      const { annotation } = assembleAnnotation(request as CreateAnnotationRequest, agent);

      inflight.set(cid, { annotationId: annotation.id });

      eventBus.get('mark:create').next({
        correlationId: cid,
        annotation,
        userId: userId(_userId),
        resourceId: resourceId(resId as string),
      } as never);

      logger.info('Annotation assembled, awaiting persistence', {
        annotationId: annotation.id,
        correlationId: cid,
      });
    } catch (error) {
      logger.warn('mark:create-request failed during assembly', {
        correlationId: cid,
        error: (error as Error).message,
      });
      (eventBus.get('mark:create-failed') as { next(v: unknown): void }).next({
        correlationId: cid,
        message: (error as Error).message,
      });
    }
  });

  eventBus.get('mark:added').subscribe((event) => {
    const cid = event.metadata?.correlationId;
    if (!cid) return;
    const pending = inflight.get(cid);
    if (!pending) return;
    inflight.delete(cid);
    (eventBus.get('mark:create-ok') as { next(v: unknown): void }).next({
      correlationId: cid,
      response: { annotationId: pending.annotationId },
    });
    logger.info('Annotation persisted', { annotationId: pending.annotationId, correlationId: cid });
  });

  eventBus.get('mark:create-failed').subscribe((event) => {
    const cid = (event as { correlationId?: string }).correlationId;
    if (!cid || !inflight.has(cid)) return;
    inflight.delete(cid);
  });
}
