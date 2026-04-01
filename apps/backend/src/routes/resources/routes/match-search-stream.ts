/**
 * Match Search Stream Route
 *
 * SSE bridge: emits match:search-requested on the backend EventBus,
 * streams match:search-results / match:search-failed back to the client.
 *
 * The frontend SSE client auto-emits these events on the browser EventBus,
 * where the ReferenceWizardModal subscribes to match:search-results.
 */

import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { resourceId } from '@semiont/core';
import type { components } from '@semiont/core';
import { ResourceContext } from '@semiont/make-meaning';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import { writeTypedSSE } from '../../../lib/sse-helpers';
import { getLogger } from '../../../logger';

type MatchSearchStreamRequest = components['schemas']['MatchSearchStreamRequest'];

export function registerMatchSearchStream(router: ResourcesRouterType) {
  router.post('/resources/:id/match-search-stream',
    validateRequestBody('MatchSearchStreamRequest'),
    async (c) => {
      const { id } = c.req.param();
      const logger = getLogger().child({
        component: 'match-search-stream',
        resourceId: id,
      });

      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      const body = c.get('validatedBody') as MatchSearchStreamRequest;
      const { referenceId, context, limit, useSemanticScoring } = body;
      const correlationId = body.correlationId ?? crypto.randomUUID();

      const eventBus = c.get('eventBus');
      const { knowledgeSystem: { kb } } = c.get('makeMeaning');

      const resource = await ResourceContext.getResourceMetadata(resourceId(id), kb);
      if (!resource) {
        throw new HTTPException(404, { message: 'Resource not found' });
      }

      logger.info('Starting match search stream', { referenceId, correlationId });

      c.header('X-Accel-Buffering', 'no');
      c.header('Cache-Control', 'no-cache, no-transform');

      return streamSSE(c, async (stream) => {
        let isStreamClosed = false;
        const subscriptions: Array<{ unsubscribe: () => void }> = [];
        let closeStreamCallback: (() => void) | null = null;

        const streamPromise = new Promise<void>((resolve) => {
          closeStreamCallback = resolve;
        });

        const cleanup = () => {
          if (isStreamClosed) return;
          isStreamClosed = true;
          subscriptions.forEach(sub => sub.unsubscribe());
          if (closeStreamCallback) closeStreamCallback();
        };

        try {
          subscriptions.push(
            eventBus.get('match:search-results').subscribe(async (event) => {
              if (event.correlationId !== correlationId) return;
              if (isStreamClosed) return;
              logger.info('Match search completed', {
                referenceId,
                resultCount: event.response.length,
              });
              try {
                await writeTypedSSE(stream, {
                  data: {
                    correlationId: event.correlationId,
                    referenceId: event.referenceId,
                    response: event.response,
                  },
                  event: 'match:search-results',
                  id: String(Date.now()),
                });
              } catch {
                logger.warn('Client disconnected during results');
              }
              cleanup();
            }),
          );

          subscriptions.push(
            eventBus.get('match:search-failed').subscribe(async (event) => {
              if (event.correlationId !== correlationId) return;
              if (isStreamClosed) return;
              logger.error('Match search failed', { referenceId, error: event.error });
              try {
                await writeTypedSSE(stream, {
                  data: {
                    correlationId: event.correlationId,
                    referenceId: event.referenceId,
                    error: event.error,
                  },
                  event: 'match:search-failed',
                  id: String(Date.now()),
                });
              } catch {
                logger.warn('Client disconnected during error');
              }
              cleanup();
            }),
          );

          eventBus.get('match:search-requested').next({
            correlationId,
            referenceId,
            context,
            limit,
            useSemanticScoring,
          });

          c.req.raw.signal.addEventListener('abort', () => {
            logger.info('Client disconnected from match search stream');
            cleanup();
          });
        } catch (error) {
          try {
            await writeTypedSSE(stream, {
              data: {
                correlationId,
                referenceId,
                error: error instanceof Error ? error.message : 'Search failed',
              },
              event: 'match:search-failed',
              id: String(Date.now()),
            });
          } catch {
            logger.warn('Could not send error to client');
          }
          cleanup();
        }

        return streamPromise;
      });
    },
  );
}
