/**
 * LLM Context
 *
 * Builds comprehensive context for LLM processing of resources
 * Orchestrates: ResourceContext, GraphContext, AnnotationContext, and generation functions
 */

import { ResourceContext } from './resource-context';
import { GraphContext } from './graph-context';
import { generateResourceSummary, generateReferenceSuggestions } from './generation/resource-generation';
import type { InferenceClient } from '@semiont/inference';
import { getResourceEntityTypes, getResourceId } from '@semiont/core';
import { resourceId as makeResourceId, type ResourceId } from '@semiont/core';
import type { GatheredContext } from '@semiont/core';
import type { KnowledgeBase } from './knowledge-base';

import type { ResourceDescriptor } from '@semiont/core';

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
    kb: KnowledgeBase,
    inferenceClient: InferenceClient
  ): Promise<GatheredContext> {
    // Get main resource from view storage
    const mainDoc = await ResourceContext.getResourceMetadata(resourceId, kb);
    if (!mainDoc) {
      throw new Error('Resource not found');
    }

    // Get content for main resource
    const mainContent = options.includeContent
      ? await ResourceContext.getResourceContent(mainDoc, kb)
      : undefined;

    // Knowledge graph (full neighborhood — resources AND annotations as nodes).
    const graph = await GraphContext.buildKnowledgeGraph(resourceId, kb);

    // Related resources for content. The cap is a view concern (Q2=C): take the first
    // (maxResources - 1) peer resource nodes, matching the previous display count.
    const resourceIdStr = resourceId.toString();
    const relatedDocs: ResourceDescriptor[] = [];
    const relatedNodes = graph.nodes
      .filter((node) => node.type === 'resource' && node.id !== resourceIdStr)
      .slice(0, Math.max(0, options.maxResources - 1));
    for (const node of relatedNodes) {
      const relatedDoc = await ResourceContext.getResourceMetadata(makeResourceId(node.id), kb);
      if (relatedDoc) {
        relatedDocs.push(relatedDoc);
      }
    }

    // Content for related resources, keyed by id.
    const relatedContent: Record<string, string> = {};
    if (options.includeContent) {
      await Promise.all(
        relatedDocs.map(async (doc) => {
          const docId = getResourceId(doc);
          if (!docId) return;
          const content = await ResourceContext.getResourceContent(doc, kb);
          if (content) {
            relatedContent[docId] = content;
          }
        })
      );
    }

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

    const content: { main?: string; related?: Record<string, string> } = {};
    if (mainContent) content.main = mainContent;
    if (options.includeContent) content.related = relatedContent;

    // Assemble the unified GatheredContext (focus.kind:'resource'). Related resources and
    // annotations are graph nodes, not separate fields. semanticContext is left absent —
    // EXCLUDE-VECTORS Phase 2b populates it (question-filtered).
    return {
      focus: {
        kind: 'resource',
        resource: mainDoc,
        ...(summary ? { summary } : {}),
        ...(suggestedReferences ? { suggestedReferences } : {}),
        ...(Object.keys(content).length > 0 ? { content } : {}),
      },
      graph,
      metadata: {
        resourceType: 'document',
        language: mainDoc.language as string | undefined,
      },
    };
  }
}
