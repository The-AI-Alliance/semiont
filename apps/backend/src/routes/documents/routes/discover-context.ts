/**
 * Discover Context Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request body with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { getGraphDatabase } from '../../../graph/factory';
import type { DocumentsRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';

type DiscoverContextResponse = components['schemas']['DiscoverContextResponse'];

export function registerDiscoverContext(router: DocumentsRouterType) {
  /**
   * POST /api/documents/:id/discover-context
   *
   * Discover related documents and concepts
   * Requires authentication
   * Validates request body against DiscoverContextRequest schema
   */
  router.post('/api/documents/:id/discover-context',
    validateRequestBody('DiscoverContextRequest'),
    async (c) => {
      const { id } = c.req.param();
      const graphDb = await getGraphDatabase();

      // Get document connections
      const connections = await graphDb.getDocumentConnections(id);
      const connectedDocs = connections.map(conn => conn.targetDocument);

      const response: DiscoverContextResponse = {
        documents: connectedDocs,
        connections: connections.map(conn => ({
          fromId: id,
          toId: conn.targetDocument.id,
          type: conn.relationshipType || 'link',
          metadata: {},
        })),
      };

      return c.json(response);
    }
  );
}
