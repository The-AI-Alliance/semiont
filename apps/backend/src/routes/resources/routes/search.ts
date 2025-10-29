/**
 * Search Resources Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Manual query parameter parsing
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { ResourceQueryService } from '../../../services/resource-queries';
import type { components } from '@semiont/api-client';

type ListResourcesResponse = components['schemas']['ListResourcesResponse'];

export function registerSearchResources(router: ResourcesRouterType) {
  /**
   * GET /api/resources/search
   *
   * Search resources by name
   * Query params: q (required), limit (optional, default 10)
   * Requires authentication
   */
  router.get('/api/resources/search', async (c) => {
    const query = c.req.query();
    const q = query.q;
    const limit = Number(query.limit) || 10;

    // Validate required param
    if (!q || q.trim().length === 0) {
      throw new HTTPException(400, { message: 'Query parameter "q" is required and must not be empty' });
    }

    // Search using Layer 3 projection storage
    const matchingDocs = await ResourceQueryService.listResources({
      search: q,
    });

    // Limit results
    const limitedDocs = matchingDocs.slice(0, limit);

    const response: ListResourcesResponse = {
      resources: limitedDocs,
      total: limitedDocs.length,
      offset: 0,
      limit,
    };

    return c.json(response);
  });
}
