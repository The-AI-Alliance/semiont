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
import { createEventStore } from '../../../services/event-store-service';
import { EventQuery } from '../../../events/query/event-query';
import type { DocumentsRouterType } from '../shared';
import type { components } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/api-client';
import { getFilesystemConfig } from '../../../config/environment-loader';

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
    const basePath = getFilesystemConfig().path;

    // Read from Layer 2/3: Event store builds/loads projection
    const eventStore = await createEventStore(basePath);
    const query = new EventQuery(eventStore.storage);
    const events = await query.getDocumentEvents(id);
    const stored = await eventStore.projector.projectDocument(events, id);

    if (!stored) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // NOTE: Content is NOT included in this response
    // Clients must call GET /documents/:id/content separately to get content

    const annotations = stored.annotations.annotations;
    const entityReferences = annotations.filter(a => {
      if (a.motivation !== 'linking') return false;
      const entityTypes = getEntityTypes({ body: a.body });
      return entityTypes.length > 0;
    });

    const response: GetDocumentResponse = {
      document: stored.document,
      annotations,
      entityReferences,
    };

    return c.json(response);
  });
}
