import { resourceId, didToAgent, assembleAnnotation } from '@semiont/core';
import type { EventBus, Logger, components } from '@semiont/core';
import type { ViewStorage } from '@semiont/event-sourcing';
import { assertAnnotatableTarget } from '../annotation-operations.js';

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
 *
 * ## The annotatability gate (MEDIA-CAPABILITY-DISPATCH D6)
 *
 * Every GUI and SDK caller travels `mark:create-request` and is checked here.
 * The check is deliberately NOT on `mark:create`, which Stower consumes: that
 * channel is the fact-writing path, and gating it would need a leniency flag
 * for restore — the compatibility switch D6 was written to avoid.
 *
 * D6's original second emitter, the TypeScript import/replay path, was deleted
 * by EXPORT-VIA-LAUNCHER P3 (2026-08-27), so nothing travels the ungated
 * channel today. The separation is kept anyway, because restore returns in the
 * launcher and its fact-writing seam is still an open decision (that plan's
 * P5) — a restore that re-subjected historical facts to this gate would be the
 * 2026-07-09 "events are facts, commands are requests" ruling undone.
 */
export function registerAnnotationAssemblyHandler(eventBus: EventBus, kb: { views: Pick<ViewStorage, 'get'> }, parentLogger: Logger): void {
  const logger = parentLogger.child({ component: 'annotation-assembly' });
  const inflight = new Map<string, { annotationId: string }>();

  eventBus.get('mark:create-request').subscribe((command) => {
    // Async because the gate reads the target's view; the try/catch below
    // covers the whole body, so nothing escapes as an unhandled rejection.
    void (async () => {
    const { correlationId, resourceId: resId, request, _userId } = command as Record<string, unknown>;
    const cid = correlationId as string | undefined;

    try {
      if (!_userId || typeof _userId !== 'string') {
        throw new Error('_userId is required (injected by bus gateway)');
      }
      if (!cid) {
        throw new Error('correlationId is required on mark:create-request');
      }

      // Refuse BEFORE assembling — an annotation is a durable write against a
      // coordinate model the system does not have for this type.
      await assertAnnotatableTarget(kb, resId as string);

      const agent = didToAgent(_userId);
      const { annotation } = assembleAnnotation(request as CreateAnnotationRequest, agent);

      inflight.set(cid, { annotationId: annotation.id });

      eventBus.get('mark:create').next({
        correlationId: cid,
        annotation,
        _userId,
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
      eventBus.get('mark:create-failed').next({
        correlationId: cid,
        message: (error as Error).message,
      });
    }
    })();
  });

  eventBus.get('mark:added').subscribe((event) => {
    const cid = event.metadata?.correlationId;
    if (!cid) return;
    const pending = inflight.get(cid);
    if (!pending) return;
    inflight.delete(cid);
    eventBus.get('mark:create-ok').next({
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
