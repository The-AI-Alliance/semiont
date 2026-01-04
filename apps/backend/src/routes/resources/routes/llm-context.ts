/**
 * Resource LLM Context Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Manual query parameter parsing and validation
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '@semiont/graph';
import { generateResourceSummary, generateReferenceSuggestions } from '@semiont/inference';
import type { ResourcesRouterType } from '../shared';
import type { components } from '@semiont/api-client';
import { FilesystemRepresentationStore } from '../../../storage/representation/representation-store';
import { getResourceId, getPrimaryRepresentation, getResourceEntityTypes, decodeRepresentation } from '@semiont/api-client';
import { resourceId as makeResourceId } from '@semiont/core';
import { resourceUri } from '@semiont/api-client';

type ResourceLLMContextResponse = components['schemas']['ResourceLLMContextResponse'];

export function registerGetResourceLLMContext(router: ResourcesRouterType) {
  /**
   * GET /resources/:id/llm-context
   *
   * Get resource with full context for LLM processing
   * Includes related resources, annotations, graph representation, and optional summary
   *
   * Query parameters:
   * - depth: 1-3 (default: 2)
   * - maxResources: 1-20 (default: 10)
   * - includeContent: true/false (default: true)
   * - includeSummary: true/false (default: false)
   */
  router.get('/resources/:id/llm-context', async (c) => {
    const { id } = c.req.param();
    const query = c.req.query();
    const config = c.get('config');
    const basePath = config.services.filesystem!.path;

    // Parse and validate query parameters
    const depth = query.depth ? Number(query.depth) : 2;
    const maxResources = query.maxResources ? Number(query.maxResources) : 10;
    const includeContent = query.includeContent === 'false' ? false : true;
    const includeSummary = query.includeSummary === 'true' ? true : false;

    // Validate depth range
    if (depth < 1 || depth > 3) {
      throw new HTTPException(400, { message: 'Query parameter "depth" must be between 1 and 3' });
    }

    // Validate maxResources range
    if (maxResources < 1 || maxResources > 20) {
      throw new HTTPException(400, { message: 'Query parameter "maxResources" must be between 1 and 20' });
    }

    const graphDb = await getGraphDatabase(config);
    const projectRoot = config._metadata?.projectRoot;
    const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

    const mainDoc = await graphDb.getResource(resourceUri(id));
    if (!mainDoc) {
      throw new HTTPException(404, { message: 'Resource not found' });
    }

    // Get content for main resource
    let mainContent: string | undefined;
    if (includeContent) {
      const primaryRep = getPrimaryRepresentation(mainDoc);
      if (primaryRep?.checksum && primaryRep?.mediaType) {
        const buffer = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
        mainContent = decodeRepresentation(buffer, primaryRep.mediaType);
      }
    }

    // Get related resources through graph connections
    const connections = await graphDb.getResourceConnections(makeResourceId(id));
    const relatedDocs = connections.map(conn => conn.targetResource);
    const limitedRelatedDocs = relatedDocs.slice(0, maxResources - 1);

    // Get content for related resources if requested
    const relatedResourcesContent: { [id: string]: string } = {};
    if (includeContent) {
      await Promise.all(limitedRelatedDocs.map(async (doc) => {
        try {
          const docId = getResourceId(doc);
          if (!docId) return;
          const primaryRep = getPrimaryRepresentation(doc);
          if (primaryRep?.checksum && primaryRep?.mediaType) {
            const buffer = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
            relatedResourcesContent[docId] = decodeRepresentation(buffer, primaryRep.mediaType);
          }
        } catch {
          // Skip resources where content can't be loaded
        }
      }));
    }

    // Get all annotations for the main resource
    const result = await graphDb.listAnnotations({ resourceId: makeResourceId(id) });
    const annotations = result.annotations;

    // Build graph representation
    const nodes = [
      {
        id: getResourceId(mainDoc),
        type: 'resource',
        label: mainDoc.name,
        metadata: { entityTypes: getResourceEntityTypes(mainDoc) },
      },
      ...limitedRelatedDocs.map(doc => ({
        id: getResourceId(doc),
        type: 'resource',
        label: doc.name,
        metadata: { entityTypes: getResourceEntityTypes(doc) },
      })),
    ].filter(node => node.id !== undefined) as Array<{ id: string; type: string; label: string; metadata: { entityTypes: string[] } }>;

    const edges = connections.map(conn => ({
      source: id,
      target: getResourceId(conn.targetResource),
      type: conn.relationshipType || 'link',
      metadata: {},
    })).filter(edge => edge.target !== undefined) as Array<{ source: string; target: string; type: string; metadata: Record<string, unknown> }>;

    // Generate summary if requested
    const summary = includeSummary && mainContent ?
      await generateResourceSummary(mainDoc.name, mainContent, getResourceEntityTypes(mainDoc), config) : undefined;

    // Generate reference suggestions if we have content
    const suggestedReferences = mainContent ?
      await generateReferenceSuggestions(mainContent, config) : undefined;

    const response: ResourceLLMContextResponse = {
      mainResource: mainDoc,
      relatedResources: limitedRelatedDocs,
      annotations,
      graph: { nodes, edges },
      ...(mainContent ? { mainResourceContent: mainContent } : {}),
      ...(Object.keys(relatedResourcesContent).length > 0 ? { relatedResourcesContent } : {}),
      ...(summary ? { summary } : {}),
      ...(suggestedReferences ? { suggestedReferences } : {}),
    };

    return c.json(response);
  });
}
