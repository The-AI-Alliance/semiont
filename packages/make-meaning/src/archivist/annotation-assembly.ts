import { resourceId, assembleAnnotation, type AnnotationId } from '@semiont/core';
import type { EventBus, Logger, components } from '@semiont/core';
import type { ViewStorage } from '@semiont/event-sourcing';
import { assertAnnotatableTarget } from './annotation-operations.js';

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
 * ## The annotatability gate
 *
 * Every GUI and SDK caller travels `mark:create-request` and is checked here.
 * The check is deliberately NOT on `mark:create`, which Stower consumes: that
 * channel is the fact-writing path, and gating it would need a leniency flag
 * for any path that replays recorded facts — the compatibility switch this
 * placement exists to avoid.
 *
 * No such path travels `mark:create`: `semiont import` untars an
 * archive and replays nothing through the event model, and the channel's
 * other emitter, `AnnotationOperations.createAnnotation`, makes the same
 * check itself. The separation holds regardless — events are facts, commands
 * are requests, and a gate on requests never re-judges a recorded fact.
 */
export function registerAnnotationAssemblyHandler(eventBus: EventBus, kb: { views: Pick<ViewStorage, 'get'> }, parentLogger: Logger): void {
  const logger = parentLogger.child({ component: 'annotation-assembly' });
  const inflight = new Map<string, { annotationId: AnnotationId }>();

  eventBus.frames('mark:create-request').subscribe(({ payload: command, correlationId: cid }) => {
    // Async because the gate reads the target's view; the try/catch below
    // covers the whole body, so nothing escapes as an unhandled rejection.
    void (async () => {
    const { resourceId: resId, request, _userId } = command as Record<string, unknown>;

    try {
      if (!_userId || typeof _userId !== 'string') {
        throw new Error('_userId is required (injected by bus gateway)');
      }
      if (!cid) {
        throw new Error('correlationId is required on mark:create-request');
      }

      // Refuse BEFORE assembling — an annotation is a durable write against a
      // coordinate model the system does not have for this type.
      const target = resourceId(resId as string);
      await assertAnnotatableTarget(kb, target);

      // A person states nothing about provenance; the Stower derives who
      // asked from `_userId` when it stows.
      const { annotation } = assembleAnnotation(request as CreateAnnotationRequest);

      inflight.set(cid, { annotationId: annotation.id });

      eventBus.emit('mark:create', { annotation,
        _userId,
        resourceId: target, } as never, { correlationId: cid });

      logger.info('Annotation assembled, awaiting persistence', {
        annotationId: annotation.id,
        correlationId: cid,
      });
    } catch (error) {
      logger.warn('mark:create-request failed during assembly', {
        correlationId: cid,
        error: (error as Error).message,
      });
      eventBus.emit('mark:create-failed', { message: (error as Error).message, }, { correlationId: cid });
    }
    })();
  });

  eventBus.frames('mark:added').subscribe(({ correlationId: cid }) => {
    if (!cid) return;
    const pending = inflight.get(cid);
    if (!pending) return;
    inflight.delete(cid);
    eventBus.emit('mark:create-ok', {
      response: { annotationId: pending.annotationId },
    }, { correlationId: cid });
    logger.info('Annotation persisted', { annotationId: pending.annotationId, correlationId: cid });
  });

  eventBus.frames('mark:create-failed').subscribe(({ correlationId: cid }) => {
    if (!cid || !inflight.has(cid)) return;
    inflight.delete(cid);
  });
}
