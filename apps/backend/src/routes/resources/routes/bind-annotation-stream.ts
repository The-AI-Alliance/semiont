/**
 * Bind Annotation Stream Route
 *
 * POST /resources/:resourceId/annotations/:annotationId/bind-stream
 *
 * Applies annotation body operations (add/remove/replace SpecificResource links)
 * and streams completion via Server-Sent Events.
 *
 * IMPORTANT — the bind:finished payload carries the full updated annotation,
 * not just its id. This is load-bearing: the frontend updates its local
 * AnnotationStore in-place from this payload, with no refetch and no
 * dependency on the long-lived events-stream. Sending only {annotationId}
 * here is a fragile pattern that has broken the link-icon flip across
 * multiple refactors — do not "simplify" this back. See .plans/BINDING.md.
 *
 * Flow:
 *   1. Receive operations (same format as PUT /body)
 *   2. Open SSE stream
 *   3. Subscribe to scoped EventBus for mark:body-updated
 *   4. Emit mark:update-body on the core EventBus
 *   5. When the Stower persists the event, read the post-bind annotation
 *      from the materialized view and send it as bind:finished, then close
 *   6. On error, missing view entry, or timeout, send bind:failed and close
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
import { readAnnotationFromView } from './event-stream-enrichment';

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

            logger.info('Bind completed; reading updated annotation from materialized view', {
              annotationId: annotationIdParam,
            });

            try {
              // Read the just-materialized annotation. EventStore.appendEvent
              // awaits materializeResource before publishing on the scoped bus
              // we're subscribed to here, so the view is guaranteed up-to-date.
              const { knowledgeSystem: { kb } } = c.get('makeMeaning');
              const updated = await readAnnotationFromView(kb, rId, annotationIdParam);

              if (!updated) {
                logger.error('Bind succeeded but annotation not found in materialized view', {
                  annotationId: annotationIdParam,
                });
                try {
                  await stream.writeSSE({
                    data: JSON.stringify({
                      error: 'Annotation not found in view after bind — view materialization may have failed',
                    }),
                    event: 'bind:failed',
                    id: String(Date.now()),
                  });
                } catch {
                  // Client already disconnected
                }
                cleanup();
                return;
              }

              try {
                await stream.writeSSE({
                  data: JSON.stringify({ annotation: updated }),
                  event: 'bind:finished',
                  id: String(Date.now()),
                });
              } catch {
                logger.warn('Client disconnected before bind:finished');
              }
            } catch (error) {
              logger.error('Failed to read updated annotation from view', {
                annotationId: annotationIdParam,
                error: error instanceof Error ? error.message : String(error),
              });
              try {
                await stream.writeSSE({
                  data: JSON.stringify({
                    error: error instanceof Error ? error.message : 'Failed to read updated annotation',
                  }),
                  event: 'bind:failed',
                  id: String(Date.now()),
                });
              } catch {
                // Client already disconnected
              }
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
