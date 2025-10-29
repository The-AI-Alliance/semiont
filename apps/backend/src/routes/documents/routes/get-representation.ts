/**
 * Get Document Representation Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No validation needed (path param extracted directly)
 * - Returns raw representation with MIME type from resource metadata
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { DocumentQueryService } from '../../../services/document-queries';
import type { DocumentsRouterType } from '../shared';
import { getFilesystemConfig } from '../../../config/environment-loader';
import { FilesystemRepresentationStore } from '../../../storage/representation/representation-store';
import { getPrimaryRepresentation, getPrimaryMediaType } from '../../../utils/resource-helpers';

export function registerGetDocumentRepresentation(router: DocumentsRouterType) {
  /**
   * GET /api/documents/:id/representation
   *
   * Get primary representation of a resource
   * Returns representation with MIME type from resource metadata
   * Requires authentication
   */
  router.get('/api/documents/:id/representation', async (c) => {
    const { id } = c.req.param();
    const basePath = getFilesystemConfig().path;
    const repStore = new FilesystemRepresentationStore({ basePath });

    // Get document metadata from Layer 3
    const resource = await DocumentQueryService.getDocumentMetadata(id);
    if (!resource) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Get primary representation
    const primaryRep = getPrimaryRepresentation(resource);
    if (!primaryRep || !primaryRep.checksum || !primaryRep.mediaType) {
      throw new HTTPException(404, { message: 'Document representation not found' });
    }

    // Read representation from RepresentationStore using content-addressed lookup
    const content = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
    if (!content) {
      throw new HTTPException(404, { message: 'Document representation not found' });
    }

    // Set Content-Type header from representation mediaType
    const mediaType = getPrimaryMediaType(resource);
    if (mediaType) {
      c.header('Content-Type', mediaType);
    }
    return c.text(content.toString('utf-8'));
  });
}
