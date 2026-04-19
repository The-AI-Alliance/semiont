import { resourceId, userId, annotationId } from '@semiont/core';
import type { EventBus, BodyOperation } from '@semiont/core';
import { getLogger } from '../logger';

const logger = () => getLogger().child({ component: 'bind-update-body' });

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
export function registerBindUpdateBodyHandler(eventBus: EventBus): void {
  const inflight = new Set<string>();

  eventBus.get('bind:update-body').subscribe((command) => {
    const { correlationId, annotationId: annId, resourceId: resId, operations, _userId } =
      command as Record<string, unknown>;
    const cid = correlationId as string | undefined;

    try {
      if (!_userId || typeof _userId !== 'string') {
        throw new Error('_userId is required (injected by bus gateway)');
      }
      if (!cid) {
        throw new Error('correlationId is required on bind:update-body');
      }

      inflight.add(cid);

      eventBus.get('mark:update-body').next({
        correlationId: cid,
        annotationId: annotationId(annId as string),
        userId: userId(_userId),
        resourceId: resourceId(resId as string),
        operations: operations as BodyOperation[],
      });

      logger().info('Bind update-body forwarded to mark:update-body, awaiting persistence', {
        annotationId: annId,
        correlationId: cid,
      });
    } catch (error) {
      logger().warn('bind:update-body failed before forwarding', {
        correlationId: cid,
        error: (error as Error).message,
      });
      (eventBus.get('bind:body-update-failed') as { next(v: unknown): void }).next({
        correlationId: cid,
        message: (error as Error).message,
      });
    }
  });

  // Deferred success: mark:body-updated is the persisted domain event.
  // Match by correlationId in metadata; emit bind:body-updated to the caller.
  eventBus.get('mark:body-updated').subscribe((event) => {
    const cid = event.metadata?.correlationId;
    if (!cid || !inflight.has(cid)) return;
    inflight.delete(cid);
    const annId = event.payload?.annotationId;
    (eventBus.get('bind:body-updated') as { next(v: unknown): void }).next({
      correlationId: cid,
      annotationId: annId,
    });
    logger().info('Bind body-updated confirmed', { annotationId: annId, correlationId: cid });
  });

  // Deferred failure: Stower emits mark:body-update-failed with correlationId.
  eventBus.get('mark:body-update-failed').subscribe((event) => {
    const cid = (event as { correlationId?: string }).correlationId;
    if (!cid || !inflight.has(cid)) return;
    inflight.delete(cid);
    const message = (event as { message?: string }).message ?? 'Unknown error';
    (eventBus.get('bind:body-update-failed') as { next(v: unknown): void }).next({
      correlationId: cid,
      message,
    });
    logger().warn('Bind body-update failed after forwarding', { correlationId: cid, message });
  });
}
