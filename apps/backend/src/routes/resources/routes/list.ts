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
import type { components } from '@semiont/api-client';
import { ResourceQueryService } from '../../../services/resource-queries';
import { FilesystemRepresentationStore } from '../../../storage/representation/representation-store';
import { getPrimaryRepresentation, getResourceEntityTypes, decodeRepresentation } from '@semiont/api-client';

type ListResourcesResponse = components['schemas']['ListResourcesResponse'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

// Helper to add content preview to search results
function formatSearchResult(doc: ResourceDescriptor, contentPreview: string): ResourceDescriptor & { content: string } {
  return {
    ...doc,
    content: contentPreview,
  };
}

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
    const basePath = config.services.filesystem!.path;
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

    const projectRoot = config._metadata?.projectRoot;
    const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

    // Read from view storage projection storage
    let filteredDocs = await ResourceQueryService.listResources({
      search: q,
      archived,
    }, config);

    // Additional filter by entity type (view storage already handles search and archived)
    if (entityType) {
      filteredDocs = filteredDocs.filter(doc => getResourceEntityTypes(doc).includes(entityType));
    }

    // Paginate
    const paginatedDocs = filteredDocs.slice(offset, offset + limit);

    // Optionally add content snippet for search results
    // For search results, include content preview for better UX
    let formattedDocs;
    if (q) {
      formattedDocs = await Promise.all(
        paginatedDocs.map(async (doc) => {
          try {
            const primaryRep = getPrimaryRepresentation(doc);
            if (primaryRep?.checksum && primaryRep?.mediaType) {
              const contentBuffer = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
              const contentPreview = decodeRepresentation(contentBuffer, primaryRep.mediaType).slice(0, 200);
              return formatSearchResult(doc, contentPreview);
            }
            return formatSearchResult(doc, '');
          } catch {
            return formatSearchResult(doc, '');
          }
        })
      );
    } else {
      formattedDocs = paginatedDocs;
    }

    const response: ListResourcesResponse = {
      resources: formattedDocs,
      total: filteredDocs.length,
      offset,
      limit,
    };

    return c.json(response);
  });
}
