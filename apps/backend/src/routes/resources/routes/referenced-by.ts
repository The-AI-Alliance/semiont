/**
 * Referenced By Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No request body validation needed (GET route with only path params)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import type { components } from '@semiont/core';
import { resourceUri as makeResourceUri, resourceId as makeResourceId, resourceIdToURI } from '@semiont/core';
import { getExactText, getTargetSource, getTargetSelector } from '@semiont/api-client';
import type { ResourcesRouterType } from '../shared';
import { getLogger } from '../../../logger';

const logger = getLogger().child({ component: 'referenced-by' });

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
    const { graphDb } = c.get('makeMeaning');

    // Get all annotations that reference this resource
    // Convert to full URI for graph database lookup
    const resourceUri = resourceIdToURI(makeResourceId(id), config.services.backend!.publicURL);
    logger.debug('Looking for annotations referencing resource', {
      resourceId: id,
      resourceUri,
      motivation: motivation || 'all'
    });
    const references = await graphDb.getResourceReferencedBy(resourceUri, motivation);
    logger.debug('Found annotations', { count: references.length });

    // Get unique resources from the selections
    const docIds = [...new Set(references.map(ref => getTargetSource(ref.target)))];
    logger.debug('Unique source resource IDs', { docIds });
    const resources = await Promise.all(docIds.map(docId => graphDb.getResource(makeResourceUri(docId))));
    logger.debug('Fetched resources', {
      total: resources.length,
      notFound: resources.filter(r => r === null).length
    });

    // Build resource map for lookup (ResourceDescriptor uses @id, not id)
    const docMap = new Map(resources.filter(doc => doc !== null).map(doc => [doc['@id'], doc]));
    logger.debug('Resource map created', { keys: Array.from(docMap.keys()) });

    // Transform into ReferencedBy structure
    const referencedBy = references.map(ref => {
      const targetSource = getTargetSource(ref.target);
      const targetSelector = getTargetSelector(ref.target);
      const doc = docMap.get(targetSource);
      logger.debug('Reference lookup', {
        targetSource,
        found: !!doc,
        name: doc?.name || 'unknown'
      });
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
