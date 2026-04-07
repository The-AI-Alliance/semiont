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
 *   3. Emit mark:update-body on the EventBus
 *   4. Wait for annotation.body.updated domain event via resource-scoped EventBus
 *   5. Send bind:finished and close stream
 *   6. On error or timeout, send bind:failed and close stream
 */

import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { BodyOperation } from '@semiont/core';
import { resourceId, annotationId, userId, userToDid } from '@semiont/core';
import { writeTypedSSE } from '../../../lib/sse-helpers';
import { getLogger } from '../../../logger';
import type { components } from '@semiont/core';

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

      return streamSSE(c, async (stream) => {
        let isStreamClosed = false;
        const subscriptions: Array<{ unsubscribe: () => void }> = [];
        let closeStreamCallback: (() => void) | null = null;
        let timeoutHandle: NodeJS.Timeout | null = null;

        const streamPromise = new Promise<void>((resolve) => {
          closeStreamCallback = resolve;
        });

        const cleanup = () => {
          if (isStreamClosed) return;
          isStreamClosed = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          subscriptions.forEach(sub => sub.unsubscribe());
          if (closeStreamCallback) closeStreamCallback();
        };

        try {
          const resourceBus = eventBus.scope(resourceIdParam);

          // Listen for the domain event confirming the body was updated
          subscriptions.push(
            resourceBus.get('annotation:body:updated').subscribe(async (event: any) => {
              if (isStreamClosed) return;
              // Match on annotation ID
              if (event.payload?.annotationId !== annotationIdParam) return;

              logger.info('Bind completed', { annotationId: annotationIdParam });
              try {
                await writeTypedSSE(stream, {
                  data: {
                    status: 'complete',
                    annotationId: annotationIdParam,
                    resourceId: resourceIdParam,
                  },
                  event: 'bind:finished',
                  id: String(Date.now()),
                });
              } catch {
                logger.warn('Client disconnected before bind:finished');
              }
              cleanup();
            })
          );

          // Timeout
          timeoutHandle = setTimeout(async () => {
            if (isStreamClosed) return;
            logger.warn('Bind timed out', { timeoutMs: BIND_TIMEOUT_MS });
            try {
              await writeTypedSSE(stream, {
                data: {
                  status: 'error',
                  message: 'Bind operation timed out',
                  annotationId: annotationIdParam,
                },
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

          // Emit the update-body command
          eventBus.get('mark:update-body').next({
            annotationId: annotationId(annotationIdParam),
            resourceId: resourceId(resourceIdParam),
            userId: userId(userToDid(user)),
            operations: request.operations as BodyOperation[],
          });

          logger.info('Emitted mark:update-body');

        } catch (error) {
          logger.error('Bind stream error', { error: error instanceof Error ? error.message : String(error) });
          try {
            await writeTypedSSE(stream, {
              data: {
                status: 'error',
                message: error instanceof Error ? error.message : 'Bind failed',
                annotationId: annotationIdParam,
              },
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
