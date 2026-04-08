/**
 * Bind Annotation Stream Route
 *
 * POST /resources/:resourceId/annotations/:annotationId/bind-stream
 *
 * Applies annotation body operations (add/remove/replace SpecificResource links)
 * and streams completion via Server-Sent Events.
 *
 * Flow:
 *   1. Receive operations (same format as PUT /body)
 *   2. Open SSE stream
 *   3. Subscribe to event store for annotation.body.updated
 *   4. Emit mark:update-body on the core EventBus
 *   5. When the Stower persists the event, send bind:finished and close
 *   6. On error or timeout, send bind:failed and close
 */

import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { BodyOperation } from '@semiont/core';
import { resourceId, annotationId, userId, userToDid } from '@semiont/core';
import { getLogger } from '../../../logger';
import type { components } from '@semiont/core';
import type { Subscription } from 'rxjs';

type BindAnnotationStreamRequest = components['schemas']['BindAnnotationStreamRequest'];

const BIND_TIMEOUT_MS = 10_000;

export function registerBindAnnotationStream(router: ResourcesRouterType) {
  router.post('/resources/:resourceId/annotations/:annotationId/bind-stream',
    validateRequestBody('BindAnnotationStreamRequest'),
    async (c) => {
      const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
      const request = c.get('validatedBody') as BindAnnotationStreamRequest;
      const user = c.get('user');

      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      const eventBus = c.get('eventBus');

      const logger = getLogger().child({
        component: 'bind-annotation-stream',
        resourceId: resourceIdParam,
        annotationId: annotationIdParam,
      });

      logger.info('Starting bind stream', { operationCount: request.operations.length });

      const rId = resourceId(resourceIdParam);
      const aid = annotationId(annotationIdParam);

      return streamSSE(c, async (stream) => {
        let isStreamClosed = false;
        let closeStreamCallback: (() => void) | null = null;
        let timeoutHandle: NodeJS.Timeout | null = null;
        let subscription: Subscription | null = null;

        const streamPromise = new Promise<void>((resolve) => {
          closeStreamCallback = resolve;
        });

        const cleanup = () => {
          if (isStreamClosed) return;
          isStreamClosed = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (subscription) subscription.unsubscribe();
          if (closeStreamCallback) closeStreamCallback();
        };

        try {
          // Subscribe to resource-scoped domain events via Core EventBus
          const scopedBus = eventBus.scope(String(rId));
          subscription = scopedBus.get('mark:body-updated').subscribe(async (storedEvent) => {
            if (isStreamClosed) return;
            if (storedEvent.payload.annotationId !== annotationIdParam) return;

            logger.info('Bind completed', { annotationId: annotationIdParam });
            try {
              await stream.writeSSE({
                data: JSON.stringify({ annotationId: String(aid) }),
                event: 'bind:finished',
                id: String(Date.now()),
              });
            } catch {
              logger.warn('Client disconnected before bind:finished');
            }
            cleanup();
          });

          // Timeout
          timeoutHandle = setTimeout(async () => {
            if (isStreamClosed) return;
            logger.warn('Bind timed out', { timeoutMs: BIND_TIMEOUT_MS });
            try {
              await stream.writeSSE({
                data: JSON.stringify({ error: 'Bind operation timed out' }),
                event: 'bind:failed',
                id: String(Date.now()),
              });
            } catch {
              // Client already disconnected
            }
            cleanup();
          }, BIND_TIMEOUT_MS);

          // Cleanup on disconnect
          c.req.raw.signal.addEventListener('abort', () => {
            logger.info('Client disconnected from bind stream');
            cleanup();
          });

          // Emit the update-body command on the core EventBus
          eventBus.get('mark:update-body').next({
            annotationId: aid,
            resourceId: rId,
            userId: userId(userToDid(user)),
            operations: request.operations as BodyOperation[],
          });

          logger.info('Emitted mark:update-body');

        } catch (error) {
          logger.error('Bind stream error', { error: error instanceof Error ? error.message : String(error) });
          try {
            await stream.writeSSE({
              data: JSON.stringify({ error: error instanceof Error ? error.message : 'Bind failed' }),
              event: 'bind:failed',
              id: String(Date.now()),
            });
          } catch {
            // Client already disconnected
          }
          cleanup();
        }

        return streamPromise;
      });
    }
  );
}
