/**
 * List Resources Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Manual query parameter parsing (coercion, defaults, validation)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import type { components } from '@semiont/core';
import { ResourceContext } from '@semiont/make-meaning';
import { getResourceEntityTypes } from '@semiont/api-client';

type ListResourcesResponse = components['schemas']['ListResourcesResponse'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export function registerListResources(router: ResourcesRouterType) {
  /**
   * GET /resources
   *
   * List all resources with optional filters
   * Query params: offset, limit, entityType, archived, q
   * Requires authentication
   */
  router.get('/resources', async (c) => {
    // Parse query parameters with defaults and coercion
    const query = c.req.query();
    const config = c.get('config');
    const offset = Number(query.offset) || 0;
    const limit = Number(query.limit) || 50;
    const entityType = query.entityType;

    // Validate archived parameter (strict validation like Zod)
    let archived: boolean | undefined;
    if (query.archived === 'true') {
      archived = true;
    } else if (query.archived === 'false') {
      archived = false;
    } else if (query.archived !== undefined) {
      throw new HTTPException(400, { message: 'Invalid value for archived parameter. Must be "true" or "false".' });
    }

    const q = query.q;

    // Read from view storage projection storage
    let filteredDocs = await ResourceContext.listResources({
      search: q,
      archived,
    }, config);

    // Additional filter by entity type (view storage already handles search and archived)
    if (entityType) {
      filteredDocs = filteredDocs.filter((doc: ResourceDescriptor) => getResourceEntityTypes(doc).includes(entityType));
    }

    // Paginate
    const paginatedDocs = filteredDocs.slice(offset, offset + limit);

    // Add content previews for search results (delegate to service)
    const formattedDocs = q
      ? await ResourceContext.addContentPreviews(paginatedDocs, config)
      : paginatedDocs;

    const response: ListResourcesResponse = {
      resources: formattedDocs,
      total: filteredDocs.length,
      offset,
      limit,
    };

    return c.json(response);
  });
}
