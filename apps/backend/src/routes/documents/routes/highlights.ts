/**
 * Get Document Highlights Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No validation needed (path param extracted directly)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import type { DocumentsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import type { components } from '@semiont/api-client';

type GetHighlightsResponse = components['schemas']['GetHighlightsResponse'];

export function registerDocumentHighlights(router: DocumentsRouterType) {
  /**
   * GET /api/documents/:id/highlights
   *
   * Get only highlights (annotations without body of type SpecifiedResource with a source) in a document
   * Requires authentication
   */
  router.get('/api/documents/:id/highlights', async (c) => {
    const { id } = c.req.param();

    // Layer 3 only - projection storage is source of truth
    // Projections now store full Annotation objects - no transformation needed
    const highlights = await AnnotationQueryService.getHighlights(id);

    const response: GetHighlightsResponse = {
      highlights
    };

    return c.json(response);
  });
}
