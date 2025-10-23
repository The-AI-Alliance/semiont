/**
 * Get Document Content Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No validation needed (path param extracted directly)
 * - Returns raw content with MIME type from document metadata
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { createContentManager } from '../../../services/storage-service';
import { DocumentQueryService } from '../../../services/document-queries';
import type { DocumentsRouterType } from '../shared';

export function registerGetDocumentContent(router: DocumentsRouterType) {
  /**
   * GET /api/documents/:id/content
   *
   * Get raw content of a document
   * Returns content with MIME type from document.format
   * Requires authentication
   */
  router.get('/api/documents/:id/content', async (c) => {
    const { id } = c.req.param();
    const contentManager = createContentManager();

    // Get document metadata from Layer 3 to retrieve the format (MIME type)
    const doc = await DocumentQueryService.getDocumentMetadata(id);
    if (!doc) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Read content from Layer 1 (filesystem)
    const content = await contentManager.get(id);
    if (!content) {
      throw new HTTPException(404, { message: 'Document content not found' });
    }

    // Set Content-Type header from document.format (W3C alignment)
    c.header('Content-Type', doc.format);
    return c.text(content.toString('utf-8'));
  });
}
