/**
 * Get Document Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No validation needed (path param extracted directly)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { getEventStore } from '../../../events/event-store';
import type { DocumentsRouterType } from '../shared';
import type { components } from '@semiont/api-client';

type GetDocumentResponse = components['schemas']['GetDocumentResponse'];

export function registerGetDocument(router: DocumentsRouterType) {
  /**
   * GET /api/documents/:id
   *
   * Get a document by ID
   * Returns document metadata and annotations (NOT content)
   * Requires authentication
   */
  router.get('/api/documents/:id', async (c) => {
    const { id } = c.req.param();

    // Read from Layer 2/3: Event store builds/loads projection
    const eventStore = await getEventStore();
    const stored = await eventStore.projectDocument(id);

    if (!stored) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // NOTE: Content is NOT included in this response
    // Clients must call GET /documents/:id/content separately to get content

    const annotations = [
      ...stored.annotations.highlights,
      ...stored.annotations.references
    ];
    const highlights = stored.annotations.highlights;
    const references = stored.annotations.references;
    const entityReferences = references.filter(ref => ref.body.entityTypes && ref.body.entityTypes.length > 0);

    const response: GetDocumentResponse = {
      document: stored.document,
      annotations,
      highlights,
      references,
      entityReferences,
    };

    return c.json(response);
  });
}
