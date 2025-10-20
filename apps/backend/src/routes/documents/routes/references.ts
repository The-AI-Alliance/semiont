/**
 * Get Document References Route - Spec-First Version
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

type GetReferencesResponse = components['schemas']['GetReferencesResponse'];

export function registerDocumentReferences(router: DocumentsRouterType) {
  /**
   * GET /api/documents/:id/references
   *
   * Get only references (annotations with body of type SpecifiedResource with a source) in a document
   * Requires authentication
   */
  router.get('/api/documents/:id/references', async (c) => {
    const { id } = c.req.param();

    // Layer 3 only - projection storage is source of truth
    // Projections now store full Annotation objects - no transformation needed
    const references = await AnnotationQueryService.getReferences(id);

    console.log(`[References] Returning ${references.length} references for ${id} from Layer 3`);

    const response: GetReferencesResponse = {
      references
    };

    return c.json(response);
  });
}
