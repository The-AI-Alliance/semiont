/**
 * Bind Search Stream Route
 *
 * SSE bridge: emits bind:search-requested on the backend EventBus,
 * streams bind:search-results / bind:search-failed back to the client.
 *
 * The frontend SSE client auto-emits these events on the browser EventBus,
 * where the ReferenceWizardModal subscribes to bind:search-results.
 */

import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { resourceId } from '@semiont/core';
import type { GatheredContext } from '@semiont/core';
import { ResourceContext } from '@semiont/make-meaning';
import { writeTypedSSE } from '../../../lib/sse-helpers';
import { getLogger } from '../../../logger';

interface BindSearchRequest {
  referenceId: string;
  context: GatheredContext;
  limit?: number;
  useSemanticScoring?: boolean;
}

export function registerBindSearchStream(router: ResourcesRouterType) {
  router.post('/resources/:id/bind-search-stream', async (c) => {
    const { id } = c.req.param();
    const logger = getLogger().child({
      component: 'bind-search-stream',
      resourceId: id,
    });

    const user = c.get('user');
    if (!user) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    const body = await c.req.json<BindSearchRequest>();
    const { referenceId, context, limit, useSemanticScoring } = body;

    if (!referenceId || !context) {
      throw new HTTPException(400, { message: 'referenceId and context are required' });
    }

    const eventBus = c.get('eventBus');
    const { knowledgeSystem: { kb } } = c.get('makeMeaning');

    // Validate resource exists
    const resource = await ResourceContext.getResourceMetadata(resourceId(id), kb);
    if (!resource) {
      throw new HTTPException(404, { message: 'Resource not found' });
    }

    const correlationId = crypto.randomUUID();

    logger.info('Starting bind search stream', { referenceId, correlationId });

    // Disable proxy buffering for real-time SSE streaming
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
        // Subscribe to search results (filter by correlationId)
        subscriptions.push(
          eventBus.get('bind:search-results').subscribe(async (event) => {
            if (event.correlationId !== correlationId) return;
            if (isStreamClosed) return;
            logger.info('Bind search completed', {
              referenceId,
              resultCount: event.results.length,
            });
            try {
              await writeTypedSSE(stream, {
                data: JSON.stringify({
                  referenceId: event.referenceId,
                  results: event.results,
                }),
                event: 'bind:search-results',
                id: String(Date.now()),
              });
            } catch (error) {
              logger.warn('Client disconnected during results');
            }
            cleanup();
          }),
        );

        // Subscribe to search failure
        subscriptions.push(
          eventBus.get('bind:search-failed').subscribe(async (event) => {
            if (event.correlationId !== correlationId) return;
            if (isStreamClosed) return;
            logger.error('Bind search failed', { referenceId, error: event.error });
            try {
              await writeTypedSSE(stream, {
                data: JSON.stringify({
                  referenceId: event.referenceId,
                  error: event.error.message,
                }),
                event: 'bind:search-failed',
                id: String(Date.now()),
              });
            } catch (error) {
              logger.warn('Client disconnected during error');
            }
            cleanup();
          }),
        );

        // Emit the search request on the backend EventBus
        eventBus.get('bind:search-requested').next({
          correlationId,
          referenceId,
          context,
          limit,
          useSemanticScoring,
        });

        // Cleanup on disconnect
        c.req.raw.signal.addEventListener('abort', () => {
          logger.info('Client disconnected from bind search stream');
          cleanup();
        });
      } catch (error) {
        try {
          await writeTypedSSE(stream, {
            data: JSON.stringify({
              referenceId,
              error: error instanceof Error ? error.message : 'Search failed',
            }),
            event: 'bind:search-failed',
            id: String(Date.now()),
          });
        } catch (sseError) {
          logger.warn('Could not send error to client');
        }
        cleanup();
      }

      return streamPromise;
    });
  });
}
