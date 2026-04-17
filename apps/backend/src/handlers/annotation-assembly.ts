import { resourceId, userId, didToAgent, assembleAnnotation } from '@semiont/core';
import type { EventBus, components } from '@semiont/core';
import { getLogger } from '../logger';

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];

const logger = () => getLogger().child({ component: 'annotation-assembly' });

export function registerAnnotationAssemblyHandler(eventBus: EventBus): void {
  eventBus.get('mark:create-request').subscribe((command) => {
    const { correlationId, resourceId: resId, request, _userId } = command as Record<string, unknown>;

    try {
      if (!_userId || typeof _userId !== 'string') {
        throw new Error('_userId is required (injected by bus gateway)');
      }

      const agent = didToAgent(_userId);
      const { annotation } = assembleAnnotation(request as CreateAnnotationRequest, agent);

      eventBus.get('mark:create').next({
        annotation,
        userId: userId(_userId),
        resourceId: resourceId(resId as string),
      } as never);

      (eventBus.get('mark:create-ok') as { next(v: unknown): void }).next({
        correlationId,
        response: { annotationId: annotation.id },
      });

      logger().info('Annotation assembled via bus', { annotationId: annotation.id, correlationId });
    } catch (error) {
      logger().warn('mark:create-request failed', { correlationId, error: (error as Error).message });
      (eventBus.get('mark:create-failed') as { next(v: unknown): void }).next({
        correlationId,
        message: (error as Error).message,
      });
    }
  });
}
