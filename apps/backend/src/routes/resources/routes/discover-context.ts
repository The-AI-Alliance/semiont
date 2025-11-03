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
import type { ResourcesRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { resourceId as makeResourceId } from '@semiont/core';

type DiscoverContextResponse = components['schemas']['DiscoverContextResponse'];

export function registerDiscoverContext(router: ResourcesRouterType) {
  /**
   * POST /api/resources/:id/discover-context
   *
   * Discover related resources and concepts
   * Requires authentication
   * Validates request body against DiscoverContextRequest schema
   */
  router.post('/api/resources/:id/discover-context',
    validateRequestBody('DiscoverContextRequest'),
    async (c) => {
      const { id } = c.req.param();
      const graphDb = await getGraphDatabase();

      // Get resource connections
      const connections = await graphDb.getResourceConnections(makeResourceId(id));
      const connectedDocs = connections.map(conn => conn.targetResource);

      const response: DiscoverContextResponse = {
        resources: connectedDocs,
        connections: connections.map(conn => ({
          fromId: id,
          toId: conn.targetResource['@id'],
          type: conn.relationshipType || 'link',
          metadata: {},
        })),
      };

      return c.json(response);
    }
  );
}
