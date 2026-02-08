/**
 * LLM Context
 *
 * Builds comprehensive context for LLM processing of resources
 * Orchestrates: ResourceContext, GraphContext, AnnotationContext, and generation functions
 */

import { ResourceContext } from './resource-context';
import { GraphContext } from './graph-context';
import { AnnotationContext } from './annotation-context';
import { generateResourceSummary, generateReferenceSuggestions } from './generation/resource-generation';
import type { InferenceClient } from '@semiont/inference';
import { getResourceEntityTypes, getResourceId } from '@semiont/api-client';
import { resourceId as makeResourceId, type EnvironmentConfig, type ResourceId } from '@semiont/core';
import type { components } from '@semiont/api-client';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type ResourceLLMContextResponse = components['schemas']['ResourceLLMContextResponse'];

export interface LLMContextOptions {
  depth: number;
  maxResources: number;
  includeContent: boolean;
  includeSummary: boolean;
}

export class LLMContext {
  /**
   * Get comprehensive LLM context for a resource
   * Includes: main resource, related resources, annotations, graph, content, summary, references
   */
  static async getResourceContext(
    resourceId: ResourceId,
    options: LLMContextOptions,
    config: EnvironmentConfig,
    inferenceClient: InferenceClient
  ): Promise<ResourceLLMContextResponse> {
    // Get main resource from view storage
    const mainDoc = await ResourceContext.getResourceMetadata(resourceId, config);
    if (!mainDoc) {
      throw new Error('Resource not found');
    }

    // Get content for main resource
    const mainContent = options.includeContent
      ? await ResourceContext.getResourceContent(mainDoc, config)
      : undefined;

    // Get graph representation (includes related resources and connections)
    const graph = await GraphContext.buildGraphRepresentation(
      resourceId,
      options.maxResources,
      config
    );

    // Extract related resources from graph nodes (excluding main resource)
    const relatedDocs: ResourceDescriptor[] = [];
    const resourceIdStr = resourceId.toString();
    for (const node of graph.nodes) {
      if (node.id !== resourceIdStr) {
        const relatedDoc = await ResourceContext.getResourceMetadata(makeResourceId(node.id), config);
        if (relatedDoc) {
          relatedDocs.push(relatedDoc);
        }
      }
    }

    // Get content for related resources
    const relatedResourcesContent: Record<string, string> = {};
    if (options.includeContent) {
      await Promise.all(
        relatedDocs.map(async (doc) => {
          const docId = getResourceId(doc);
          if (!docId) return;
          const content = await ResourceContext.getResourceContent(doc, config);
          if (content) {
            relatedResourcesContent[docId] = content;
          }
        })
      );
    }

    // Get annotations from view storage
    const annotations = await AnnotationContext.getAllAnnotations(resourceId, config);

    // Generate summary if requested
    const summary = options.includeSummary && mainContent
      ? await generateResourceSummary(
          mainDoc.name,
          mainContent,
          getResourceEntityTypes(mainDoc),
          inferenceClient
        )
      : undefined;

    // Generate reference suggestions if we have content
    const suggestedReferences = mainContent
      ? await generateReferenceSuggestions(mainContent, inferenceClient)
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
}
