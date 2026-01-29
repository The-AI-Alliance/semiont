/**
 * LLM Context Service
 *
 * Builds comprehensive context for LLM processing of resources
 * Orchestrates: graph queries + content retrieval + annotation fetching + LLM operations
 */

import { getGraphDatabase } from '@semiont/graph';
import { generateResourceSummary, generateReferenceSuggestions } from '@semiont/make-meaning';
import { FilesystemRepresentationStore } from '@semiont/content';
import {
  getResourceId,
  getPrimaryRepresentation,
  getResourceEntityTypes,
  decodeRepresentation
} from '@semiont/api-client';
import { resourceId as makeResourceId, resourceIdToURI, type EnvironmentConfig } from '@semiont/core';
import type { components } from '@semiont/api-client';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];
type ResourceLLMContextResponse = components['schemas']['ResourceLLMContextResponse'];

export interface LLMContextOptions {
  depth: number;
  maxResources: number;
  includeContent: boolean;
  includeSummary: boolean;
}

interface GraphNode {
  id: string;
  type: string;
  label: string;
  metadata: { entityTypes: string[] };
}

interface GraphEdge {
  source: string;
  target: string;
  type: string;
  metadata: Record<string, unknown>;
}

export class LLMContextService {
  /**
   * Get comprehensive LLM context for a resource
   * Includes: main resource, related resources, annotations, graph, content, summary, references
   */
  static async getResourceLLMContext(
    resourceId: string,
    options: LLMContextOptions,
    config: EnvironmentConfig
  ): Promise<ResourceLLMContextResponse> {
    const basePath = config.services.filesystem!.path;
    const projectRoot = config._metadata?.projectRoot;

    const graphDb = await getGraphDatabase(config);
    const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

    // Get main resource from graph
    const mainDoc = await this.getMainResource(resourceId, graphDb, config);

    // Get content for main resource
    const mainContent = options.includeContent
      ? await this.getResourceContent(mainDoc, repStore)
      : undefined;

    // Get related resources through graph connections
    const { relatedDocs, connections } = await this.getRelatedResources(
      resourceId,
      options.maxResources,
      graphDb
    );

    // Get content for related resources
    const relatedResourcesContent = options.includeContent
      ? await this.getRelatedResourcesContent(relatedDocs, repStore)
      : {};

    // Get annotations
    const annotations = await this.getAnnotations(resourceId, graphDb);

    // Build graph representation
    const graph = this.buildGraphRepresentation(
      resourceId,
      mainDoc,
      relatedDocs,
      connections
    );

    // Generate summary if requested
    const summary = options.includeSummary && mainContent
      ? await generateResourceSummary(
          mainDoc.name,
          mainContent,
          getResourceEntityTypes(mainDoc),
          config
        )
      : undefined;

    // Generate reference suggestions if we have content
    const suggestedReferences = mainContent
      ? await generateReferenceSuggestions(mainContent, config)
      : undefined;

    // Build response
    return {
      mainResource: mainDoc,
      relatedResources: relatedDocs,
      annotations,
      graph,
      ...(mainContent ? { mainResourceContent: mainContent } : {}),
      ...(options.includeContent ? { relatedResourcesContent } : {}),
      ...(summary ? { summary } : {}),
      ...(suggestedReferences ? { suggestedReferences } : {}),
    };
  }

  /**
   * Get main resource from graph database
   */
  private static async getMainResource(
    resourceId: string,
    graphDb: Awaited<ReturnType<typeof getGraphDatabase>>,
    config: EnvironmentConfig
  ): Promise<ResourceDescriptor> {
    const publicURL = config.services.backend!.publicURL;
    const rId = makeResourceId(resourceId);
    const rUri = resourceIdToURI(rId, publicURL);
    const mainDoc = await graphDb.getResource(rUri);
    if (!mainDoc) {
      throw new Error('Resource not found');
    }
    return mainDoc;
  }

  /**
   * Get content for a single resource
   */
  private static async getResourceContent(
    doc: ResourceDescriptor,
    repStore: FilesystemRepresentationStore
  ): Promise<string | undefined> {
    const primaryRep = getPrimaryRepresentation(doc);
    if (primaryRep?.checksum && primaryRep?.mediaType) {
      const buffer = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
      return decodeRepresentation(buffer, primaryRep.mediaType);
    }
    return undefined;
  }

  /**
   * Get related resources through graph connections
   */
  private static async getRelatedResources(
    resourceId: string,
    maxResources: number,
    graphDb: Awaited<ReturnType<typeof getGraphDatabase>>
  ) {
    const connections = await graphDb.getResourceConnections(makeResourceId(resourceId));
    const relatedDocs = connections.map(conn => conn.targetResource);
    const limitedRelatedDocs = relatedDocs.slice(0, maxResources - 1);

    return { relatedDocs: limitedRelatedDocs, connections };
  }

  /**
   * Get content for multiple related resources
   */
  private static async getRelatedResourcesContent(
    relatedDocs: ResourceDescriptor[],
    repStore: FilesystemRepresentationStore
  ): Promise<{ [id: string]: string }> {
    const relatedResourcesContent: { [id: string]: string } = {};

    await Promise.all(
      relatedDocs.map(async (doc) => {
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
      })
    );

    return relatedResourcesContent;
  }

  /**
   * Get all annotations for a resource
   */
  private static async getAnnotations(
    resourceId: string,
    graphDb: Awaited<ReturnType<typeof getGraphDatabase>>
  ): Promise<Annotation[]> {
    const result = await graphDb.listAnnotations({ resourceId: makeResourceId(resourceId) });
    return result.annotations;
  }

  /**
   * Build graph representation with nodes and edges
   */
  private static buildGraphRepresentation(
    resourceId: string,
    mainDoc: ResourceDescriptor,
    relatedDocs: ResourceDescriptor[],
    connections: Array<{ targetResource: ResourceDescriptor; relationshipType?: string }>
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = [
      {
        id: getResourceId(mainDoc),
        type: 'resource',
        label: mainDoc.name,
        metadata: { entityTypes: getResourceEntityTypes(mainDoc) },
      },
      ...relatedDocs.map(doc => ({
        id: getResourceId(doc),
        type: 'resource',
        label: doc.name,
        metadata: { entityTypes: getResourceEntityTypes(doc) },
      })),
    ].filter(node => node.id !== undefined) as GraphNode[];

    const edges = connections
      .map(conn => ({
        source: resourceId,
        target: getResourceId(conn.targetResource),
        type: conn.relationshipType || 'link',
        metadata: {},
      }))
      .filter(edge => edge.target !== undefined) as GraphEdge[];

    return { nodes, edges };
  }
}
