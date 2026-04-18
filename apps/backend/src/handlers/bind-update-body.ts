import { resourceId, userId, annotationId } from '@semiont/core';
import type { EventBus, BodyOperation } from '@semiont/core';
import { getLogger } from '../logger';

const logger = () => getLogger().child({ component: 'bind-update-body' });

/**
 * Handles the `bind:update-body` command: the Bind flow's authoritative
 * "apply body operations to an annotation" command. Translates into the
 * Mark flow's `mark:update-body` command which Stower persists.
 *
 * Bind remains a first-class flow despite delegating persistence to Mark —
 * the semantic distinction (Bind = reference linking, Mark = annotation
 * CRUD) is meaningful at the UX and agent-reasoning layers even when the
 * downstream storage event is shared.
 */
export function registerBindUpdateBodyHandler(eventBus: EventBus): void {
  eventBus.get('bind:update-body').subscribe((command) => {
    const { correlationId, annotationId: annId, resourceId: resId, operations, _userId } =
      command as Record<string, unknown>;

    try {
      if (!_userId || typeof _userId !== 'string') {
        throw new Error('_userId is required (injected by bus gateway)');
      }

      eventBus.get('mark:update-body').next({
        annotationId: annotationId(annId as string),
        userId: userId(_userId),
        resourceId: resourceId(resId as string),
        operations: operations as BodyOperation[],
      });

      logger().info('Bind update-body delegated to mark:update-body', {
        annotationId: annId,
        correlationId,
      });
    } catch (error) {
      logger().warn('bind:update-body failed', { correlationId, error: (error as Error).message });
      (eventBus.get('bind:body-update-failed') as { next(v: unknown): void }).next({
        correlationId,
        message: (error as Error).message,
      });
    }
  });
}
