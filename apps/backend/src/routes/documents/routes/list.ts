/**
 * List Documents Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Manual query parameter parsing (coercion, defaults, validation)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { createContentManager } from '../../../services/storage-service';
import { formatSearchResult } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import type { components } from '@semiont/api-client';
import { DocumentQueryService } from '../../../services/document-queries';
import { getFilesystemConfig } from '../../../config/environment-loader';

type ListDocumentsResponse = components['schemas']['ListDocumentsResponse'];

export function registerListDocuments(router: DocumentsRouterType) {
  /**
   * GET /api/documents
   *
   * List all documents with optional filters
   * Query params: offset, limit, entityType, archived, search
   * Requires authentication
   */
  router.get('/api/documents', async (c) => {
    // Parse query parameters with defaults and coercion
    const query = c.req.query();
    const basePath = getFilesystemConfig().path;
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

    const search = query.search;

    const contentManager = createContentManager(basePath);

    // Read from Layer 3 projection storage
    let filteredDocs = await DocumentQueryService.listDocuments({
      search,
      archived,
    });

    // Additional filter by entity type (Layer 3 already handles search and archived)
    if (entityType) {
      filteredDocs = filteredDocs.filter(doc => doc.entityTypes?.includes(entityType));
    }

    // Paginate
    const paginatedDocs = filteredDocs.slice(offset, offset + limit);

    // Optionally add content snippet for search results
    // For search results, include content preview for better UX
    let formattedDocs;
    if (search) {
      formattedDocs = await Promise.all(
        paginatedDocs.map(async (doc) => {
          try {
            const contentBuffer = await contentManager.get(doc.id);
            const contentPreview = contentBuffer.toString('utf-8').slice(0, 200);
            return formatSearchResult(doc, contentPreview);
          } catch {
            return formatSearchResult(doc, '');
          }
        })
      );
    } else {
      formattedDocs = paginatedDocs;
    }

    const response: ListDocumentsResponse = {
      documents: formattedDocs,
      total: filteredDocs.length,
      offset,
      limit,
    };

    return c.json(response);
  });
}
