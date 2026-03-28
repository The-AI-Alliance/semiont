/**
 * Gather Annotation LLM Context Stream Route
 * POST /resources/{resourceId}/annotations/{annotationId}/gather-annotation-stream
 *
 * Emits gather:requested on the EventBus and streams progress via SSE.
 */

import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { annotationId, resourceId } from '@semiont/core';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { writeTypedSSE } from '../../../lib/sse-helpers';
import { getLogger } from '../../../logger';

type GatherAnnotationStreamRequest = components['schemas']['GatherAnnotationStreamRequest'];

export function registerGatherAnnotationStream(router: ResourcesRouterType) {
  router.post(
    '/resources/:resourceId/annotations/:annotationId/gather-annotation-stream',
    validateRequestBody('GatherAnnotationStreamRequest'),
    async (c) => {
      const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
      const body = c.get('validatedBody') as GatherAnnotationStreamRequest;
      const contextWindow = body.contextWindow ?? 1000;
      const eventBus = c.get('eventBus');
      const logger = getLogger().child({
        component: 'gather-annotation-stream',
        resourceId: resourceIdParam,
        annotationId: annotationIdParam,
      });

      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      // Emit gather:requested — Gatherer subscribes and processes
      eventBus.get('gather:requested').next({
        annotationId: annotationId(annotationIdParam),
        resourceId: resourceId(resourceIdParam),
        options: { includeSourceContext: true, includeTargetContext: true, contextWindow },
      });

      logger.info('Emitted gather:requested', { annotationId: annotationIdParam, contextWindow });

      c.header('X-Accel-Buffering', 'no');
      c.header('Cache-Control', 'no-cache, no-transform');

      return streamSSE(c, async (stream) => {
        let isStreamClosed = false;
        const subscriptions: Array<{ unsubscribe: () => void }> = [];
        let keepAliveInterval: NodeJS.Timeout | null = null;

        const streamPromise = new Promise<void>((resolve) => {
          const cleanup = () => {
            if (isStreamClosed) return;
            isStreamClosed = true;
            if (keepAliveInterval) clearInterval(keepAliveInterval);
            subscriptions.forEach(sub => sub.unsubscribe());
            resolve();
          };

          subscriptions.push(
            eventBus.get('gather:annotation-progress').subscribe(async (event) => {
              if (isStreamClosed) return;
              try {
                await writeTypedSSE(stream, {
                  data: JSON.stringify({ message: event.message, percentage: event.percentage }),
                  event: 'gather:annotation-progress',
                  id: String(Date.now()),
                });
              } catch {
                cleanup();
              }
            })
          );

          subscriptions.push(
            eventBus.get('gather:annotation-finished').subscribe(async (event) => {
              if (event.annotationId !== annotationIdParam) return;
              if (isStreamClosed) return;
              try {
                await writeTypedSSE(stream, {
                  data: JSON.stringify({ annotationId: event.annotationId, response: event.response }),
                  event: 'gather:annotation-finished',
                  id: String(Date.now()),
                });
              } catch {
                // client disconnected
              }
              cleanup();
            })
          );

          subscriptions.push(
            eventBus.get('gather:failed').subscribe(async (event) => {
              if (event.annotationId !== annotationIdParam) return;
              if (isStreamClosed) return;
              try {
                await writeTypedSSE(stream, {
                  data: JSON.stringify({ annotationId: event.annotationId, error: event.error }),
                  event: 'gather:failed',
                  id: String(Date.now()),
                });
              } catch {
                // client disconnected
              }
              cleanup();
            })
          );

          keepAliveInterval = setInterval(async () => {
            if (isStreamClosed) { clearInterval(keepAliveInterval!); return; }
            try { await stream.writeSSE({ data: ':keep-alive' }); } catch { cleanup(); }
          }, 30000);

          c.req.raw.signal.addEventListener('abort', () => {
            logger.info('Client disconnected from gather stream');
            cleanup();
          });
        });

        return streamPromise;
      });
    }
  );
}
