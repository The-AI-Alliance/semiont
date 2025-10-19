/**
 * Get Document Annotations Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No request body validation needed (GET route with only path params)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import type { DocumentsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import type { components } from '@semiont/api-client';

type GetAnnotationsResponse = components['schemas']['GetAnnotationsResponse'];

export function registerGetDocumentAnnotations(router: DocumentsRouterType) {
  /**
   * GET /api/documents/:id/annotations
   *
   * Get all annotations (both highlights and references) in a document
   * Requires authentication
   * Uses Layer 3 projections with GraphDB fallback
   */
  router.get('/api/documents/:id/annotations', async (c) => {
    const { id } = c.req.param();

    try {
      // Try Layer 3 first (fast path - O(1) file read)
      const annotations = await AnnotationQueryService.getAllAnnotations(id);

      // Layer 3 projections have simplified format - return directly
      const response: GetAnnotationsResponse = {
        annotations
      };

      return c.json(response);
    } catch (error) {
      // Fallback to GraphDB if projection missing
      console.warn(`[Annotations] Layer 3 miss for ${id}, falling back to GraphDB`);

      const graphDb = await getGraphDatabase();
      const document = await graphDb.getDocument(id);
      if (!document) {
        throw new HTTPException(404, { message: 'Document not found' });
      }

      const highlights = await graphDb.getHighlights(id);
      const references = await graphDb.getReferences(id);

      const response: GetAnnotationsResponse = {
        annotations: [...highlights, ...references]
      };

      return c.json(response);
    }
  });
}
