/**
 * Annotation Context
 *
 * Assembles annotation context from view storage and content store.
 * Provides methods for:
 * - Getting resource annotations
 * - Building LLM context for annotations
 * - Extracting annotation text context
 * - Generating AI summaries
 */

import type { InferenceClient } from '@semiont/inference';
import type { EmbeddingProvider, VectorSearchResult } from '@semiont/vectors';
import { generateResourceSummary } from './generation/resource-generation';
import { getBodySource, getResourceId, getTargetSource, getTargetSelector, getResourceEntityTypes, getTextPositionSelector, getPrimaryRepresentation, decodeRepresentation } from '@semiont/core';
import type { components, GatheredContext } from '@semiont/core';

import type {
  ResourceId,
  ResourceAnnotations,
  AnnotationId,
  AnnotationCategory,
  Logger,
} from '@semiont/core';
import { resourceId as createResourceId } from '@semiont/core';
import { getEntityTypes } from '@semiont/ontology';
import { ResourceContext } from './resource-context';
import type { WorkingTreeStore } from '@semiont/content';
import type { KnowledgeBase } from './knowledge-base';

type AnnotationLLMContextResponse = components['schemas']['AnnotationLLMContextResponse'];
type TextPositionSelector = components['schemas']['TextPositionSelector'];
type TextQuoteSelector = components['schemas']['TextQuoteSelector'];
import type { Annotation } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';
type AnnotationContextResponse = components['schemas']['AnnotationContextResponse'];
type ContextualSummaryResponse = components['schemas']['ContextualSummaryResponse'];

export interface BuildContextOptions {
  includeSourceContext?: boolean;
  includeTargetContext?: boolean;
  contextWindow?: number;
}

interface AnnotationTextContext {
  before: string;
  selected: string;
  after: string;
}

export class AnnotationContext {
  /**
   * Build LLM context for an annotation
   *
   * @param annotationId - Bare annotation ID
   * @param resourceId - Source resource ID
   * @param kb - Knowledge base stores
   * @param options - Context building options
   * @param inferenceClient - Optional inference client for target context summary
   * @returns Rich context for LLM processing
   * @throws Error if annotation or resource not found
   */
  static async buildLLMContext(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    kb: KnowledgeBase,
    options: BuildContextOptions = {},
    inferenceClient?: InferenceClient,
    logger?: Logger,
    embeddingProvider?: EmbeddingProvider,
  ): Promise<AnnotationLLMContextResponse> {
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

    // Find the annotation in the view (annotations now have bare IDs)
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

    // Body source is now a bare resource ID
    let targetDoc = null;
    if (bodySource) {
      const targetResourceId = createResourceId(bodySource);
      const targetView = await kb.views.get(targetResourceId);
      targetDoc = targetView?.resource || null;
    }

    // Build source context if requested
    let sourceContext;
    if (includeSourceContext) {
      if (!sourceDoc.storageUri) {
        throw new Error('Source content not found: no storageUri');
      }
      const primaryRep = getPrimaryRepresentation(sourceDoc);
      const sourceContent = await kb.content.retrieve(sourceDoc.storageUri);
      const contentStr = decodeRepresentation(sourceContent, primaryRep?.mediaType ?? 'text/plain');

      const targetSelectorRaw = getTargetSelector(annotation.target);

      // Handle array of selectors - take the first one
      const targetSelector = Array.isArray(targetSelectorRaw) ? targetSelectorRaw[0] : targetSelectorRaw;

      logger?.debug('Target selector', { type: targetSelector?.type });

      if (!targetSelector) {
        logger?.warn('No target selector found');
      } else if (targetSelector.type === 'TextPositionSelector') {
        // TypeScript now knows this is TextPositionSelector with required start/end
        const selector = targetSelector as TextPositionSelector;
        const start = selector.start;
        const end = selector.end;

        const before = contentStr.slice(Math.max(0, start - contextWindow), start);
        const selected = contentStr.slice(start, end);
        const after = contentStr.slice(end, Math.min(contentStr.length, end + contextWindow));

        sourceContext = { before, selected, after };
        logger?.debug('Built source context using TextPositionSelector', { start, end });
      } else if (targetSelector.type === 'TextQuoteSelector') {
        // TypeScript now knows this is TextQuoteSelector with required exact
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

    // Build target context if requested and available
    let targetContext;
    if (includeTargetContext && targetDoc) {
      if (targetDoc.storageUri) {
        const targetRep = getPrimaryRepresentation(targetDoc);
        const targetContent = await kb.content.retrieve(targetDoc.storageUri);
        const contentStr = decodeRepresentation(targetContent, targetRep?.mediaType ?? 'text/plain');

        targetContext = {
          content: contentStr.slice(0, contextWindow * 2),
          summary: inferenceClient
            ? await generateResourceSummary(targetDoc.name, contentStr, getResourceEntityTypes(targetDoc), inferenceClient)
            : undefined,
        };
      }
    }

    // TODO: Generate suggested resolution using AI
    const suggestedResolution = undefined;

    // Build graph context via graph traversal
    logger?.debug('Building graph context', { resourceId });

    const [connections, referencedByAnnotations, entityTypeStats] = await Promise.all([
      kb.graph.getResourceConnections(resourceId),
      kb.graph.getResourceReferencedBy(resourceId),
      kb.graph.getEntityTypeStats(),
    ]);

    // Extract cited-by resources from referenced-by annotations
    const citedByMap = new Map<string, string>();
    for (const ann of referencedByAnnotations) {
      const source = getTargetSource(ann.target);
      if (source && source !== String(resourceId)) {
        const sourceResId = createResourceId(source);
        const sourceView = await kb.views.get(sourceResId);
        if (sourceView?.resource) {
          citedByMap.set(source, sourceView.resource.name);
        }
      }
    }

    // Collect sibling entity types from other annotations on this resource
    const annotationEntityTypes = getEntityTypes(annotation);
    const siblingEntityTypes = new Set<string>();
    for (const ann of sourceView.annotations.annotations) {
      if (ann.id !== annotationId) {
        for (const et of getEntityTypes(ann)) {
          siblingEntityTypes.add(et);
        }
      }
    }

    // Build entity type frequency map
    const entityTypeFrequencies: Record<string, number> = {};
    for (const stat of entityTypeStats) {
      entityTypeFrequencies[stat.type] = stat.count;
    }

    // Optional inference enrichment: LLM summarizes relationships from passage + graph neighborhood
    let inferredRelationshipSummary: string | undefined;
    if (inferenceClient && sourceContext) {
      try {
        const connNames = connections.map(c => c.targetResource.name).slice(0, 10);
        const citedByNames = Array.from(citedByMap.values()).slice(0, 5);
        const siblingTypes = Array.from(siblingEntityTypes).slice(0, 10);

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

    const graphContext: GatheredContext['graphContext'] = {
      connections: connections.map(conn => ({
        resourceId: getResourceId(conn.targetResource) ?? '',
        resourceName: conn.targetResource.name,
        entityTypes: getResourceEntityTypes(conn.targetResource),
        bidirectional: conn.bidirectional,
      })),
      citedByCount: citedByMap.size,
      citedBy: Array.from(citedByMap.entries()).map(([id, name]) => ({
        resourceId: id,
        resourceName: name,
      })),
      siblingEntityTypes: Array.from(siblingEntityTypes),
      entityTypeFrequencies,
      ...(inferredRelationshipSummary ? { inferredRelationshipSummary } : {}),
    };

    logger?.debug('Built graph context', {
      connections: connections.length,
      citedByCount: citedByMap.size,
      siblingEntityTypes: siblingEntityTypes.size,
    });

    // Build semantic context via vector search (if vectors and embedding are configured)
    let semanticContext: GatheredContext['semanticContext'];
    if (kb.vectors && embeddingProvider && sourceContext?.selected) {
      try {
        const focalEmbedding = await embeddingProvider.embed(sourceContext.selected);
        const results = await kb.vectors.searchAnnotations(focalEmbedding, {
          limit: 10,
          scoreThreshold: 0.5,
          filter: { excludeResourceId: resourceId },
        });

        if (results.length > 0) {
          semanticContext = {
            similar: results.map((r: VectorSearchResult) => ({
              text: r.text,
              resourceId: r.resourceId,
              annotationId: r.annotationId,
              score: r.score,
              entityTypes: r.entityTypes,
            })),
          };
          logger?.debug('Semantic context found', { matches: results.length });
        }
      } catch (error) {
        logger?.warn('Semantic context search failed', { error });
      }
    }

    // Build GatheredContext structure (sourceContext is optional for image/PDF annotations)
    const generationContext: GatheredContext = {
      annotation,
      sourceResource: sourceDoc,
      metadata: {
        resourceType: 'document',
        language: sourceDoc.language as string | undefined,
        entityTypes: annotationEntityTypes,
      },
      graphContext,
      ...(semanticContext ? { semanticContext } : {}),
    };
    if (sourceContext) {
      generationContext.sourceContext = {
        before: sourceContext.before || '',
        selected: sourceContext.selected,
        after: sourceContext.after || '',
      };
    }

    const response: AnnotationLLMContextResponse = {
      annotation,
      sourceResource: sourceDoc,
      targetResource: targetDoc,
      ...(generationContext ? { context: generationContext } : {}),
      ...(sourceContext ? { sourceContext } : {}),  // Keep for backward compatibility
      ...(targetContext ? { targetContext } : {}),
      ...(suggestedResolution ? { suggestedResolution } : {}),
    };

    return response;
  }

  /**
   * Get resource annotations from view storage (fast path)
   * Throws if view missing
   */
  static async getResourceAnnotations(resourceId: ResourceId, kb: KnowledgeBase): Promise<ResourceAnnotations> {
    const view = await kb.views.get(resourceId);

    if (!view) {
      throw new Error(`Resource ${resourceId} not found in view storage`);
    }

    return view.annotations;
  }

  /**
   * Get all annotations
   * @returns Array of all annotation objects
   */
  static async getAllAnnotations(resourceId: ResourceId, kb: KnowledgeBase): Promise<Annotation[]> {
    const annotations = await this.getResourceAnnotations(resourceId, kb);

    // Enrich resolved references with document names
    return this.enrichResolvedReferences(annotations.annotations, kb);
  }

  /**
   * Enrich reference annotations with resolved document names
   * Adds _resolvedDocumentName property to annotations that link to documents
   * @private
   */
  private static async enrichResolvedReferences(annotations: Annotation[], kb: KnowledgeBase): Promise<Annotation[]> {
    // Extract unique resolved resource IDs from reference annotations
    const resolvedIds = new Set<string>();
    for (const ann of annotations) {
      if (ann.motivation === 'linking' && ann.body) {
        const body = Array.isArray(ann.body) ? ann.body : [ann.body];
        for (const item of body) {
          if (item.type === 'SpecificResource' && item.purpose === 'linking' && item.source) {
            resolvedIds.add(item.source);
          }
        }
      }
    }

    if (resolvedIds.size === 0) {
      return annotations;
    }

    // Batch fetch all resolved documents in parallel
    const metadataPromises = Array.from(resolvedIds).map(async (id) => {
      try {
        const view = await kb.views.get(id as ResourceId);
        if (view?.resource?.name) {
          return {
            id,
            metadata: {
              name: view.resource.name,
              mediaType: view.resource.mediaType as string | undefined
            }
          };
        }
      } catch (e) {
        // Document might not exist, skip
      }
      return null;
    });

    const results = await Promise.all(metadataPromises);
    const idToMetadata = new Map<string, { name: string; mediaType?: string }>();
    for (const result of results) {
      if (result) {
        idToMetadata.set(result.id, result.metadata);
      }
    }

    // Add _resolvedDocumentName and _resolvedDocumentMediaType to annotations
    return annotations.map(ann => {
      if (ann.motivation === 'linking' && ann.body) {
        const body = Array.isArray(ann.body) ? ann.body : [ann.body];
        for (const item of body) {
          if (item.type === 'SpecificResource' && item.purpose === 'linking' && item.source) {
            const metadata = idToMetadata.get(item.source);
            if (metadata) {
              return {
                ...ann,
                _resolvedDocumentName: metadata.name,
                _resolvedDocumentMediaType: metadata.mediaType
              } as Annotation;
            }
          }
        }
      }
      return ann;
    });
  }

  /**
   * Get resource stats (version info)
   * @returns Version and timestamp info for the annotations
   */
  static async getResourceStats(resourceId: ResourceId, kb: KnowledgeBase): Promise<{
    resourceId: ResourceId;
    version: number;
    updatedAt: string;
  }> {
    const annotations = await this.getResourceAnnotations(resourceId, kb);
    return {
      resourceId: annotations.resourceId,
      version: annotations.version,
      updatedAt: annotations.updatedAt,
    };
  }

  /**
   * Check if resource exists in view storage
   */
  static async resourceExists(resourceId: ResourceId, kb: KnowledgeBase): Promise<boolean> {
    return kb.views.exists(resourceId);
  }

  /**
   * Get a single annotation by ID
   * O(1) lookup using resource ID to access view storage
   */
  static async getAnnotation(annotationId: AnnotationId, resourceId: ResourceId, kb: KnowledgeBase): Promise<Annotation | null> {
    const annotations = await this.getResourceAnnotations(resourceId, kb);
    return annotations.annotations.find((a: Annotation) => a.id === annotationId) || null;
  }

  /**
   * List annotations with optional filtering
   * @param filters - Optional filters like resourceId and type
   * @throws Error if resourceId not provided (cross-resource queries not supported in view storage)
   */
  static async listAnnotations(filters: { resourceId?: ResourceId; type?: AnnotationCategory } | undefined, kb: KnowledgeBase): Promise<Annotation[]> {
    if (!filters?.resourceId) {
      throw new Error('resourceId is required for annotation listing - cross-resource queries not supported in view storage');
    }

    // Use view storage directly
    return this.getAllAnnotations(filters.resourceId, kb);
  }

  /**
   * Get annotation context (selected text with surrounding context)
   */
  static async getAnnotationContext(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    contextBefore: number,
    contextAfter: number,
    kb: KnowledgeBase
  ): Promise<AnnotationContextResponse> {
    // Get annotation from view storage
    const annotation = await this.getAnnotation(annotationId, resourceId, kb);
    if (!annotation) {
      throw new Error('Annotation not found');
    }

    // Get resource metadata from view storage
    const resource = await ResourceContext.getResourceMetadata(
      createResourceId(getTargetSource(annotation.target)),
      kb
    );
    if (!resource) {
      throw new Error('Resource not found');
    }

    // Get content from representation store
    const contentStr = await this.getResourceContent(resource, kb.content);

    // Extract context based on annotation position
    const context = this.extractAnnotationContext(annotation, contentStr, contextBefore, contextAfter);

    return {
      annotation: annotation,
      context,
      resource: {
        '@context': resource['@context'],
        '@id': resource['@id'],
        name: resource.name,
        entityTypes: resource.entityTypes,
        representations: resource.representations,
        archived: resource.archived,
        creationMethod: resource.creationMethod,
        wasAttributedTo: resource.wasAttributedTo,
        dateCreated: resource.dateCreated,
      },
    };
  }

  /**
   * Generate AI summary of annotation in context
   */
  static async generateAnnotationSummary(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    kb: KnowledgeBase,
    inferenceClient: InferenceClient,
  ): Promise<ContextualSummaryResponse> {
    // Get annotation from view storage
    const annotation = await this.getAnnotation(annotationId, resourceId, kb);
    if (!annotation) {
      throw new Error('Annotation not found');
    }

    // Get resource from view storage
    const resource = await ResourceContext.getResourceMetadata(
      createResourceId(getTargetSource(annotation.target)),
      kb
    );
    if (!resource) {
      throw new Error('Resource not found');
    }

    // Get content from representation store
    const contentStr = await this.getResourceContent(resource, kb.content);

    // Extract annotation text with context (fixed 500 chars for summary)
    const contextSize = 500;
    const context = this.extractAnnotationContext(annotation, contentStr, contextSize, contextSize);

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
   * Get resource content as string
   */
  private static async getResourceContent(
    resource: ResourceDescriptor,
    content: WorkingTreeStore
  ): Promise<string> {
    if (!resource.storageUri) {
      throw new Error('Resource content not found: no storageUri');
    }
    const primaryRep = getPrimaryRepresentation(resource);
    const buf = await content.retrieve(resource.storageUri);
    return decodeRepresentation(buf, primaryRep?.mediaType ?? 'text/plain');
  }

  /**
   * Extract annotation context from resource content
   */
  private static extractAnnotationContext(
    annotation: Annotation,
    contentStr: string,
    contextBefore: number,
    contextAfter: number
  ): AnnotationTextContext {
    const targetSelector = getTargetSelector(annotation.target);
    const posSelector = targetSelector ? getTextPositionSelector(targetSelector) : null;
    if (!posSelector) {
      throw new Error('TextPositionSelector required for context');
    }

    const selStart = posSelector.start;
    const selEnd = posSelector.end;
    const start = Math.max(0, selStart - contextBefore);
    const end = Math.min(contentStr.length, selEnd + contextAfter);

    return {
      before: contentStr.substring(start, selStart),
      selected: contentStr.substring(selStart, selEnd),
      after: contentStr.substring(selEnd, end),
    };
  }

  /**
   * Generate LLM summary of annotation in context
   * Creates inference client per-request (HTTP handler context)
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
