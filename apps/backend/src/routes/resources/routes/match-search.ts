/**
 * Match Search Route
 *
 * POST /resources/:id/match-search
 *
 * Submits a match-search command. Returns {correlationId} immediately.
 * The Binder actor processes the search and publishes results on the
 * resource-scoped EventBus. Results reach the client via the long-lived
 * events-stream as match:search-results or match:search-failed events.
 *
 * Replaces the former match-search-stream SSE route.
 *
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { resourceId } from '@semiont/core';
import { ResourceContext } from '@semiont/make-meaning';
import { getLogger } from '../../../logger';

type MatchSearchRequest = components['schemas']['MatchSearchRequest'];

export function registerMatchSearch(router: ResourcesRouterType) {
  router.post('/resources/:id/match-search',
    validateRequestBody('MatchSearchRequest'),
    async (c) => {
      const { id } = c.req.param();
      const logger = getLogger().child({
        component: 'match-search',
        resourceId: id,
      });

      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      const body = c.get('validatedBody') as MatchSearchRequest;
      const { referenceId, context, limit, useSemanticScoring } = body;
      const correlationId = body.correlationId ?? crypto.randomUUID();

      const eventBus = c.get('eventBus');
      const { knowledgeSystem: { kb } } = c.get('makeMeaning');

      const resource = await ResourceContext.getResourceMetadata(resourceId(id), kb);
      if (!resource) {
        throw new HTTPException(404, { message: 'Resource not found' });
      }

      logger.info('Match search requested', { referenceId, correlationId });

      // Emit the search command. The Binder handles it asynchronously and
      // publishes results on eventBus.scope(resourceId), which the
      // events-stream delivers to all connected clients.
      eventBus.get('match:search-requested').next({
        correlationId,
        resourceId: id,
        referenceId,
        context,
        limit,
        useSemanticScoring,
      });

      return c.json({ correlationId }, 202);
    },
  );
}
