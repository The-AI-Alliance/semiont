/**
 * Annotation Gather
 *
 * Discovery around one annotation: the context an LLM is handed (graph
 * neighbourhood, semantic neighbours, a summary of the target) and the
 * annotation's own summary. The Librarian's; the view reads it builds on are
 * `AnnotationContext`.
 */

import type { InferenceClient } from '@semiont/inference';
import type { EmbeddingProvider, VectorSearchResult, VectorStore } from '@semiont/vectors';
import { generateResourceSummary } from './generation/resource-generation';
import { getBodySource, getTargetSource, getTargetSelector, getResourceEntityTypes, getStorageUri, deriveViews } from '@semiont/core';
import type { components, GatheredContext, Annotation, ResourceDescriptor, ResourceId, AnnotationId, Logger } from '@semiont/core';
import { getEntityTypes } from '@semiont/core';
import { AnnotationContext, type AnnotationTextContext } from './annotation-context';
import { ResourceContext } from './resource-context';
import { GraphContext, type KnowledgeGraphReads } from './graph-context';
import type { ViewStorage } from '@semiont/event-sourcing';
import type { GraphDatabase } from '@semiont/graph';
import type { ContentReads } from '@semiont/content';
import type { AnchoredTextAsk } from './anchored-text-ask.js';

type TextPositionSelector = components['schemas']['TextPositionSelector'];
type TextQuoteSelector = components['schemas']['TextQuoteSelector'];
type ContextualSummaryResponse = components['schemas']['ContextualSummaryResponse'];
type ViewGet = { views: Pick<ViewStorage, 'get'> };

/**
 * What the annotation-gather path reads — a narrow capability slice, with
 * content keyed by resource id so a network transport backs it: the graph
 * builder's slice plus this module's own reads. Pick-derived, never restated.
 * The Librarian passes `archivistContentReads`.
 */
export interface AnnotationGatherReads {
  views: Pick<ViewStorage, 'get'>;
  content: ContentReads;
  /** Derived text for `pdf-text-layer` media — the anchored-text bus read. */
  anchoredText: AnchoredTextAsk;
  graph: KnowledgeGraphReads['graph'] & Pick<GraphDatabase, 'getEntityTypeStats'>;
  vectors: Pick<VectorStore, 'searchAnnotations'>;
  weaveProgress: KnowledgeGraphReads['weaveProgress'];
}

export interface BuildContextOptions {
  includeSourceContext?: boolean;
  includeTargetContext?: boolean;
  contextWindow?: number;
}

export class AnnotationGather {
  /**
   * Build LLM context for an annotation
   *
   * @param annotationId - Bare annotation ID
   * @param resourceId - Source resource ID
   * @param kb - Knowledge base stores
   * @param embeddingProvider - Embeds the focal text for the semantic search
   * @param options - Context building options
   * @param inferenceClient - Optional inference client for target context summary
   * @param logger - Optional logger
   * @returns Rich context for LLM processing
   * @throws Error if annotation or resource not found
   */
  static async buildLLMContext(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    kb: AnnotationGatherReads,
    embeddingProvider: EmbeddingProvider,
    options: BuildContextOptions = {},
    inferenceClient?: InferenceClient,
    logger?: Logger,
  ): Promise<GatheredContext> {
    const {
      includeSourceContext = true,
      includeTargetContext = true,
      contextWindow = 1000
    } = options;

    // Validate contextWindow range
    if (contextWindow < 100 || contextWindow > 5000) {
      throw new Error('contextWindow must be between 100 and 5000');
    }

    logger?.debug('Building LLM context', { annotationId, resourceId });

    // Get source resource view
    logger?.debug('Getting view for resource', { resourceId });
    let sourceView;
    try {
      sourceView = await kb.views.get(resourceId);
      logger?.debug('Retrieved view', { hasView: !!sourceView });

      if (!sourceView) {
        throw new Error('Source resource not found');
      }
    } catch (error) {
      logger?.error('Error getting view', { resourceId, error });
      throw error;
    }

    logger?.debug('Looking for annotation in resource', {
      annotationId,
      resourceId,
      totalAnnotations: sourceView.annotations.annotations.length,
      firstFiveIds: sourceView.annotations.annotations.slice(0, 5).map((a: Annotation) => a.id)
    });

    // Find the annotation in the view (annotations have bare IDs)
    const annotation = sourceView.annotations.annotations.find((a: Annotation) => a.id === annotationId);
    logger?.debug('Annotation search result', { found: !!annotation });

    if (!annotation) {
      throw new Error('Annotation not found in view');
    }

    const targetSource = getTargetSource(annotation.target);
    logger?.debug('Validating target resource', { targetSource, expectedResourceId: resourceId });

    if (targetSource !== String(resourceId)) {
      throw new Error(`Annotation target resource ID (${targetSource}) does not match expected resource ID (${resourceId})`);
    }

    const sourceDoc = sourceView.resource;

    // Get target resource if annotation is a reference (has resolved body source)
    const bodySource = getBodySource(annotation.body);

    // Body source is a bare resource ID
    let targetDoc = null;
    if (bodySource) {
      const targetResourceId = bodySource;
      const targetView = await kb.views.get(targetResourceId);
      targetDoc = targetView?.resource || null;
    }

    // Build source context if requested. Text arrives through the
    // read-side dispatcher: decode media decode, pdf-text-layer media answer
    // from the anchored text — whose offsets are what TextPositionSelectors
    // index — and an absent derived text skips the slice rather than killing
    // the build.
    let sourceContext;
    if (includeSourceContext) {
      if (!getStorageUri(sourceDoc)) {
        throw new Error('Source content not found: no storageUri');
      }
      const contentStr = await ResourceContext.getResourceContent(sourceDoc, kb);
      if (contentStr === undefined) {
        logger?.warn('Source context skipped — no text for this media yet', { resourceId });
      } else {

      const targetSelectorRaw = getTargetSelector(annotation.target);

      // Handle array of selectors - take the first one
      const targetSelector = Array.isArray(targetSelectorRaw) ? targetSelectorRaw[0] : targetSelectorRaw;

      logger?.debug('Target selector', { type: targetSelector?.type });

      if (!targetSelector) {
        logger?.warn('No target selector found');
      } else if (targetSelector.type === 'TextPositionSelector') {
        // A TextPositionSelector, by the type check above: start/end are required
        const selector = targetSelector as TextPositionSelector;
        const start = selector.start;
        const end = selector.end;

        const before = contentStr.slice(Math.max(0, start - contextWindow), start);
        const selected = contentStr.slice(start, end);
        const after = contentStr.slice(end, Math.min(contentStr.length, end + contextWindow));

        sourceContext = { before, selected, after };
        logger?.debug('Built source context using TextPositionSelector', { start, end });
      } else if (targetSelector.type === 'TextQuoteSelector') {
        // A TextQuoteSelector, by the type check above: exact is required
        const selector = targetSelector as TextQuoteSelector;
        const exact = selector.exact;
        const index = contentStr.indexOf(exact);

        if (index !== -1) {
          const start = index;
          const end = index + exact.length;

          const before = contentStr.slice(Math.max(0, start - contextWindow), start);
          const selected = exact;
          const after = contentStr.slice(end, Math.min(contentStr.length, end + contextWindow));

          sourceContext = { before, selected, after };
          logger?.debug('Built source context using TextQuoteSelector', { foundAt: index });
        } else {
          logger?.warn('TextQuoteSelector exact text not found in content', { exactPreview: exact.substring(0, 50) });
        }
      } else {
        logger?.warn('Unknown selector type', { type: (targetSelector as any).type });
      }
      }
    }

    // Build target context if requested and available — through the same
    // dispatcher; a target with no text yet simply contributes none.
    let targetContext;
    if (includeTargetContext && targetDoc) {
      const contentStr = getStorageUri(targetDoc) && bodySource
        ? await ResourceContext.getResourceContent(targetDoc, kb)
        : undefined;
      if (contentStr !== undefined) {

        targetContext = {
          content: contentStr.slice(0, contextWindow * 2),
          summary: inferenceClient
            ? await generateResourceSummary(targetDoc.name, contentStr, getResourceEntityTypes(targetDoc), inferenceClient)
            : undefined,
        };
      }
    }

    // Build the knowledge graph for the neighborhood (full — the cap is a view concern).
    logger?.debug('Building knowledge graph', { resourceId });
    const graph = await GraphContext.buildKnowledgeGraph(resourceId, kb, logger);

    // Derive the flattened views (connections / citedBy / siblings) from the graph.
    const views = deriveViews(graph, String(resourceId), annotationId);

    // Global IDF statistic — not graph-derivable, stays in metadata.
    // Eventually consistent BY DESIGN: a statistical graph read has no key to
    // await, and a corpus-wide frequency is semantically stale-tolerant.
    const entityTypeStats = await kb.graph.getEntityTypeStats();
    const entityTypeFrequencies: Record<string, number> = {};
    for (const stat of entityTypeStats) {
      entityTypeFrequencies[stat.type] = stat.count;
    }

    const annotationEntityTypes = getEntityTypes(annotation);

    // Optional inference enrichment: LLM summarizes relationships from passage + graph neighborhood
    let inferredRelationshipSummary: string | undefined;
    if (inferenceClient && sourceContext) {
      try {
        const connNames = views.connections.map((c) => c.resourceName).slice(0, 10);
        const citedByNames = views.citedBy.map((c) => c.resourceName).slice(0, 5);
        const siblingTypes = views.siblingEntityTypes.slice(0, 10);

        const parts: string[] = [];
        parts.push(`Passage: "${sourceContext.selected}"`);
        if (connNames.length > 0) parts.push(`Connected resources: ${connNames.join(', ')}`);
        if (citedByNames.length > 0) parts.push(`Cited by: ${citedByNames.join(', ')}`);
        if (siblingTypes.length > 0) parts.push(`Sibling entity types: ${siblingTypes.join(', ')}`);
        if (annotationEntityTypes.length > 0) parts.push(`Annotation entity types: ${annotationEntityTypes.join(', ')}`);

        const relationshipPrompt = `Given this annotation passage and its knowledge graph neighborhood, write a 1-2 sentence summary of how this passage relates to its surrounding resources and what kind of resource would best resolve this reference.

${parts.join('\n')}

Summary:`;

        inferredRelationshipSummary = await inferenceClient.generateText(relationshipPrompt, 150, 0.3);
        logger?.debug('Generated inferred relationship summary', { length: inferredRelationshipSummary.length });
      } catch (error) {
        logger?.warn('Failed to generate inferred relationship summary', { error });
        // Non-fatal — proceed without it
      }
    }

    // Build semantic context via vector search — vectors and the provider
    // are mandatory; only a missing selection skips.
    let semanticContext: GatheredContext['semanticContext'];
    if (sourceContext?.selected) {
      try {
        const focalEmbedding = await embeddingProvider.embed(sourceContext.selected);
        const results = await kb.vectors.searchAnnotations(focalEmbedding, {
          limit: 10,
          scoreThreshold: 0.5,
          filter: { excludeResourceId: resourceId },
        });

        // Each match is named via its source's view (`resourceName` is
        // required). A source the views cannot resolve is dropped, never
        // id-labeled: a passage from a vanished resource is not actionable
        // fork evidence.
        const similar: NonNullable<GatheredContext['semanticContext']>['similar'] = [];
        for (const r of results as VectorSearchResult[]) {
          const matchView = await kb.views.get(r.resourceId);
          const resourceName = matchView?.resource?.name;
          if (!resourceName) {
            logger?.debug('Semantic match dropped — no view for source resource', { resourceId: String(r.resourceId) });
            continue;
          }
          similar.push({
            text: r.text,
            resourceId: r.resourceId,
            resourceName,
            annotationId: r.annotationId,
            score: r.score,
            entityTypes: r.entityTypes,
            ...(r.machineRead ? { machineRead: true } : {}),
          });
        }
        if (similar.length > 0) {
          semanticContext = { similar };
          logger?.debug('Semantic context found', { matches: similar.length });
        }
      } catch (error) {
        logger?.warn('Semantic context search failed', { error });
      }
    }

    // Assemble the unified GatheredContext (focus.kind:'annotation').
    const context: GatheredContext = {
      focus: {
        kind: 'annotation',
        annotation,
        sourceResource: sourceDoc,
        ...(sourceContext
          ? { selected: { before: sourceContext.before || '', text: sourceContext.selected, after: sourceContext.after || '' } }
          : {}),
        ...(targetDoc ? { targetResource: targetDoc } : {}),
        ...(targetContext ? { targetContext } : {}),
      },
      graph,
      metadata: {
        resourceType: 'document',
        language: sourceDoc.language as string | undefined,
        entityTypes: annotationEntityTypes,
        entityTypeFrequencies,
      },
      ...(inferredRelationshipSummary ? { inferredRelationshipSummary } : {}),
      ...(semanticContext ? { semanticContext } : {}),
    };

    return context;
  }

  /**
   * Generate AI summary of annotation in context
   */
  static async generateAnnotationSummary(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    kb: ViewGet & { content: ContentReads; anchoredText: AnchoredTextAsk },
    inferenceClient: InferenceClient,
  ): Promise<ContextualSummaryResponse> {
    // Get annotation from view storage
    const annotation = await AnnotationContext.getAnnotation(annotationId, resourceId, kb);
    if (!annotation) {
      throw new Error('Annotation not found');
    }

    // Get resource from view storage
    const resource = await ResourceContext.getResourceMetadata(
      getTargetSource(annotation.target),
      kb
    );
    if (!resource) {
      throw new Error('Resource not found');
    }

    const contentStr = await ResourceContext.getResourceContent(resource, kb);
    if (contentStr === undefined) {
      throw new Error('Resource content not found: no text for this media (not decoded, and no derived text yet)');
    }

    // Extract annotation text with context (fixed 500 chars for summary)
    const contextSize = 500;
    const context = AnnotationContext.extractAnnotationContext(annotation, contentStr, contextSize, contextSize);

    // Extract entity types from annotation body
    const annotationEntityTypes = getEntityTypes(annotation);

    // Generate summary using LLM
    const summary = await this.generateSummary(resource, context, annotationEntityTypes, inferenceClient);

    return {
      summary,
      relevantFields: {
        resourceId: resource.id,
        resourceName: resource.name,
        entityTypes: annotationEntityTypes,
      },
      context: {
        before: context.before.substring(Math.max(0, context.before.length - 200)), // Last 200 chars
        selected: context.selected,
        after: context.after.substring(0, 200), // First 200 chars
      },
    };
  }

  /**
   * Generate LLM summary of annotation in context
   */
  private static async generateSummary(
    resource: ResourceDescriptor,
    context: AnnotationTextContext,
    entityTypes: string[],
    inferenceClient: InferenceClient,
  ): Promise<string> {
    const summaryPrompt = `Summarize this text in context:

Context before: "${context.before.substring(Math.max(0, context.before.length - 200))}"
Selected exact: "${context.selected}"
Context after: "${context.after.substring(0, 200)}"

Resource: ${resource.name}
Entity types: ${entityTypes.join(', ')}`;

    return inferenceClient.generateText(summaryPrompt, 500, 0.5);
  }
}
