import { resourceId, annotationId } from '@semiont/core';
import type { EventBus, Logger, BodyOperation } from '@semiont/core';

/**
 * Handles `bind:update-body` — the Bind flow's authoritative "apply body
 * operations to an annotation" command. Bind remains a first-class flow
 * despite delegating persistence to Mark — the semantic distinction (Bind =
 * reference linking, Mark = annotation CRUD) is meaningful at the UX and
 * agent-reasoning layers even when the downstream storage event is shared.
 *
 * Flow:
 *   1. Receive bind:update-body with correlationId.
 *   2. Forward to mark:update-body with correlationId threaded through.
 *   3. Stower persists (via EventStore.appendEvent) and publishes mark:body-updated
 *      with correlationId in metadata.
 *   4. This handler subscribes to mark:body-updated and mark:body-update-failed,
 *      matches by correlationId, and emits bind:body-updated / bind:body-update-failed
 *      so the caller learns the real outcome — not an optimistic ack.
 */
export function registerBindUpdateBodyHandler(eventBus: EventBus, parentLogger: Logger): void {
  const logger = parentLogger.child({ component: 'bind-update-body' });
  const inflight = new Set<string>();

  eventBus.frames('bind:update-body').subscribe(({ payload: command, correlationId: cid }) => {
    const { annotationId: annId, resourceId: resId, operations, _userId } =
      command as Record<string, unknown>;

    try {
      if (!_userId || typeof _userId !== 'string') {
        throw new Error('_userId is required (injected by bus gateway)');
      }
      if (!cid) {
        throw new Error('correlationId is required on bind:update-body');
      }

      inflight.add(cid);

      eventBus.emit('mark:update-body', { annotationId: annotationId(annId as string),
        _userId,
        resourceId: resourceId(resId as string),
        operations: operations as BodyOperation[], }, { correlationId: cid });

      logger.info('Bind update-body forwarded to mark:update-body, awaiting persistence', {
        annotationId: annId,
        correlationId: cid,
      });
    } catch (error) {
      logger.warn('bind:update-body failed before forwarding', {
        correlationId: cid,
        error: (error as Error).message,
      });
      eventBus.emit('bind:body-update-failed', { message: (error as Error).message, }, { correlationId: cid });
    }
  });

  eventBus.frames('mark:body-updated').subscribe(({ payload: event, correlationId: cid }) => {
    if (!cid || !inflight.has(cid)) return;
    inflight.delete(cid);
    const annId = event.payload?.annotationId;
    eventBus.emit('bind:body-updated', {}, { correlationId: cid });
    logger.info('Bind body-updated confirmed', { annotationId: annId, correlationId: cid });
  });

  eventBus.frames('mark:body-update-failed').subscribe(({ payload: event, correlationId: cid }) => {
    if (!cid || !inflight.has(cid)) return;
    inflight.delete(cid);
    const message = event.message ?? 'Unknown error';
    eventBus.emit('bind:body-update-failed', { message, }, { correlationId: cid });
    logger.warn('Bind body-update failed after forwarding', { correlationId: cid, message });
  });
}
