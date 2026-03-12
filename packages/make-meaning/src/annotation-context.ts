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
import { generateResourceSummary } from './generation/resource-generation';
import {
  getBodySource,
  getTargetSource,
  getTargetSelector,
  getResourceEntityTypes,
  getTextPositionSelector,
  getPrimaryRepresentation,
  decodeRepresentation,
} from '@semiont/api-client';
import type { components, AnnotationUri, YieldContext } from '@semiont/core';

import type {
  ResourceId,
  ResourceAnnotations,
  AnnotationId,
  AnnotationCategory,
  Logger,
} from '@semiont/core';
import { resourceId as createResourceId, uriToResourceId } from '@semiont/core';
import { getEntityTypes } from '@semiont/ontology';
import { ResourceContext } from './resource-context';
import type { KnowledgeBase } from './knowledge-base';
import type { RepresentationStore } from '@semiont/content';

type AnnotationLLMContextResponse = components['schemas']['AnnotationLLMContextResponse'];
type TextPositionSelector = components['schemas']['TextPositionSelector'];
type TextQuoteSelector = components['schemas']['TextQuoteSelector'];
type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
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
   * @param annotationUri - Full annotation URI (e.g., http://localhost:4000/annotations/abc123)
   * @param resourceId - Source resource ID
   * @param kb - Knowledge base stores
   * @param options - Context building options
   * @param inferenceClient - Optional inference client for target context summary
   * @returns Rich context for LLM processing
   * @throws Error if annotation or resource not found
   */
  static async buildLLMContext(
    annotationUri: AnnotationUri,
    resourceId: ResourceId,
    kb: KnowledgeBase,
    options: BuildContextOptions = {},
    inferenceClient?: InferenceClient,
    logger?: Logger
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

    logger?.debug('Building LLM context', { annotationUri, resourceId });

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
      annotationUri,
      resourceId,
      totalAnnotations: sourceView.annotations.annotations.length,
      firstFiveIds: sourceView.annotations.annotations.slice(0, 5).map((a: Annotation) => a.id)
    });

    // Find the annotation in the view (annotations have full URIs as their id)
    const annotation = sourceView.annotations.annotations.find((a: Annotation) => a.id === annotationUri);
    logger?.debug('Annotation search result', { found: !!annotation });

    if (!annotation) {
      throw new Error('Annotation not found in view');
    }

    const targetSource = getTargetSource(annotation.target);
    // Extract resource ID from the target source URI (format: http://host/resources/{id})
    const targetResourceId = targetSource.split('/').pop();
    logger?.debug('Validating target resource', { targetSource, expectedResourceId: resourceId, extractedId: targetResourceId });

    if (targetResourceId !== resourceId) {
      throw new Error(`Annotation target resource ID (${targetResourceId}) does not match expected resource ID (${resourceId})`);
    }

    const sourceDoc = sourceView.resource;

    // Get target resource if annotation is a reference (has resolved body source)
    const bodySource = getBodySource(annotation.body);

    // Extract target document from body source URI if present
    let targetDoc = null;
    if (bodySource) {
      // Inline extraction: "http://localhost:4000/resources/abc123" → "abc123"
      const parts = (bodySource as string).split('/');
      const lastPart = parts[parts.length - 1];
      if (!lastPart) {
        throw new Error(`Invalid body source URI: ${bodySource}`);
      }
      const targetResourceId = createResourceId(lastPart);
      const targetView = await kb.views.get(targetResourceId);
      targetDoc = targetView?.resource || null;
    }

    // Build source context if requested
    let sourceContext;
    if (includeSourceContext) {
      const primaryRep = getPrimaryRepresentation(sourceDoc);
      if (!primaryRep?.checksum || !primaryRep?.mediaType) {
        throw new Error('Source content not found');
      }
      const sourceContent = await kb.content.retrieve(primaryRep.checksum, primaryRep.mediaType);
      const contentStr = decodeRepresentation(sourceContent, primaryRep.mediaType);

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
      const targetRep = getPrimaryRepresentation(targetDoc);
      if (targetRep?.checksum && targetRep?.mediaType) {
        const targetContent = await kb.content.retrieve(targetRep.checksum, targetRep.mediaType);
        const contentStr = decodeRepresentation(targetContent, targetRep.mediaType);

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

    // Build YieldContext structure
    const generationContext: YieldContext | undefined = sourceContext ? {
      sourceContext: {
        before: sourceContext.before || '',
        selected: sourceContext.selected,
        after: sourceContext.after || '',
      },
      metadata: {
        resourceType: 'document',
        language: sourceDoc.language as string | undefined,
        entityTypes: getEntityTypes(annotation),
      },
    } : undefined;

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
    return await this.enrichResolvedReferences(annotations.annotations, kb);
  }

  /**
   * Enrich reference annotations with resolved document names
   * Adds _resolvedDocumentName property to annotations that link to documents
   * @private
   */
  private static async enrichResolvedReferences(annotations: Annotation[], kb: KnowledgeBase): Promise<Annotation[]> {
    // Extract unique resolved document URIs from reference annotations
    const resolvedUris = new Set<string>();
    for (const ann of annotations) {
      if (ann.motivation === 'linking' && ann.body) {
        const body = Array.isArray(ann.body) ? ann.body : [ann.body];
        for (const item of body) {
          if (item.type === 'SpecificResource' && item.purpose === 'linking' && item.source) {
            resolvedUris.add(item.source);
          }
        }
      }
    }

    if (resolvedUris.size === 0) {
      return annotations;
    }

    // Batch fetch all resolved documents in parallel
    const metadataPromises = Array.from(resolvedUris).map(async (uri) => {
      const docId = uri.split('/resources/')[1];
      if (!docId) return null;

      try {
        const view = await kb.views.get(docId as ResourceId);
        if (view?.resource?.name) {
          return {
            uri,
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
    const uriToMetadata = new Map<string, { name: string; mediaType?: string }>();
    for (const result of results) {
      if (result) {
        uriToMetadata.set(result.uri, result.metadata);
      }
    }

    // Add _resolvedDocumentName and _resolvedDocumentMediaType to annotations
    return annotations.map(ann => {
      if (ann.motivation === 'linking' && ann.body) {
        const body = Array.isArray(ann.body) ? ann.body : [ann.body];
        for (const item of body) {
          if (item.type === 'SpecificResource' && item.purpose === 'linking' && item.source) {
            const metadata = uriToMetadata.get(item.source);
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
    return await kb.views.exists(resourceId);
  }

  /**
   * Get a single annotation by ID
   * O(1) lookup using resource ID to access view storage
   */
  static async getAnnotation(annotationId: AnnotationId, resourceId: ResourceId, kb: KnowledgeBase): Promise<Annotation | null> {
    const annotations = await this.getResourceAnnotations(resourceId, kb);
    // Extract short ID from annotation's full URI for comparison
    return annotations.annotations.find((a: Annotation) => {
      const shortId = a.id.split('/').pop();
      return shortId === annotationId;
    }) || null;
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
    return await this.getAllAnnotations(filters.resourceId, kb);
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
      uriToResourceId(getTargetSource(annotation.target)),
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
      uriToResourceId(getTargetSource(annotation.target)),
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
    repStore: RepresentationStore
  ): Promise<string> {
    const primaryRep = getPrimaryRepresentation(resource);
    if (!primaryRep?.checksum || !primaryRep?.mediaType) {
      throw new Error('Resource content not found');
    }
    const content = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
    return decodeRepresentation(content, primaryRep.mediaType);
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

    return await inferenceClient.generateText(summaryPrompt, 500, 0.5);
  }
}
