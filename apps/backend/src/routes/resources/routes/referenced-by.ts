/**
 * Referenced By Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No request body validation needed (GET route with only path params)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { getGraphDatabase } from '@semiont/graph';
import {
  getExactText,
  getTargetSource,
  getTargetSelector,
  type components,
  resourceUri as makeResourceUri,
} from '@semiont/api-client';
import type { ResourcesRouterType } from '../shared';
import { resourceId as makeResourceId } from '@semiont/core';
import { resourceIdToURI } from '@semiont/core';

type GetReferencedByResponse = components['schemas']['GetReferencedByResponse'];

export function registerGetReferencedBy(router: ResourcesRouterType) {
  /**
   * GET /resources/:id/referenced-by
   *
   * Get resources that reference this resource
   * Requires authentication
   * Returns list of resources with references to this resource
   *
   * Optional query parameter:
   * - motivation: Filter by W3C motivation type (e.g., 'linking', 'commenting', 'highlighting')
   */
  router.get('/resources/:id/referenced-by', async (c) => {
    const { id } = c.req.param();
    const motivation = c.req.query('motivation');
    const config = c.get('config');
    const graphDb = await getGraphDatabase(config);

    // Get all annotations that reference this resource
    // Convert to full URI for graph database lookup
    const resourceUri = resourceIdToURI(makeResourceId(id), config.services.backend!.publicURL);
    const filterDesc = motivation ? ` (filtered by motivation: ${motivation})` : '';
    console.log(`[Referenced-By] Looking for annotations${filterDesc} referencing resourceUri: ${resourceUri}`);
    const references = await graphDb.getResourceReferencedBy(resourceUri, motivation);
    console.log(`[Referenced-By] Found ${references.length} annotations`);

    // Get unique resources from the selections
    const docIds = [...new Set(references.map(ref => getTargetSource(ref.target)))];
    console.log(`[Referenced-By] Unique source resource IDs:`, docIds);
    const resources = await Promise.all(docIds.map(docId => graphDb.getResource(makeResourceUri(docId))));
    console.log(`[Referenced-By] Fetched ${resources.length} resources, ${resources.filter(r => r === null).length} not found`);

    // Build resource map for lookup (ResourceDescriptor uses @id, not id)
    const docMap = new Map(resources.filter(doc => doc !== null).map(doc => [doc['@id'], doc]));
    console.log(`[Referenced-By] Map keys:`, Array.from(docMap.keys()));

    // Transform into ReferencedBy structure
    const referencedBy = references.map(ref => {
      const targetSource = getTargetSource(ref.target);
      const targetSelector = getTargetSelector(ref.target);
      const doc = docMap.get(targetSource);
      console.log(`[Referenced-By] Lookup: targetSource="${targetSource}", found=${!!doc}, name="${doc?.name}"`);
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
