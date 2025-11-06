/**
 * Referenced By Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No request body validation needed (GET route with only path params)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { getGraphDatabase } from '../../../graph/factory';
import { getExactText } from '@semiont/api-client';
import { getTargetSource, getTargetSelector } from '../../../lib/annotation-utils';
import type { ResourcesRouterType } from '../shared';
import type { components } from '@semiont/api-client';
import { resourceId as makeResourceId } from '@semiont/core';
import { resourceUri } from '@semiont/api-client';

type GetReferencedByResponse = components['schemas']['GetReferencedByResponse'];

export function registerGetReferencedBy(router: ResourcesRouterType) {
  /**
   * GET /resources/:id/referenced-by
   *
   * Get resources that reference this resource
   * Requires authentication
   * Returns list of resources with references to this resource
   */
  router.get('/resources/:id/referenced-by', async (c) => {
    const { id } = c.req.param();
    const config = c.get('config');
    const graphDb = await getGraphDatabase(config);

    // Get all annotations that reference this resource
    const references = await graphDb.getResourceReferencedBy(makeResourceId(id));

    // Get unique resources from the selections
    const docIds = [...new Set(references.map(ref => getTargetSource(ref.target)))];
    const resources = await Promise.all(docIds.map(docId => graphDb.getResource(resourceUri(docId))));

    // Build resource map for lookup
    const docMap = new Map(resources.filter(doc => doc !== null).map(doc => [doc.id, doc]));

    // Transform into ReferencedBy structure
    const referencedBy = references.map(ref => {
      const targetSource = getTargetSource(ref.target);
      const targetSelector = getTargetSelector(ref.target);
      const doc = docMap.get(targetSource);
      return {
        id: ref.id,
        resourceName: doc?.name || 'Untitled Resource',
        target: {
          source: targetSource,
          selector: {
            exact: targetSelector ? getExactText(targetSelector) : '',
          },
        },
      };
    });

    const response: GetReferencedByResponse = {
      referencedBy,
    };

    return c.json(response);
  });
}
