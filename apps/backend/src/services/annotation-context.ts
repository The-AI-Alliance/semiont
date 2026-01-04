/**
 * Annotation Context Service
 *
 * Builds rich LLM context for annotations, including:
 * - Source context (text before/selected/after the annotation)
 * - Target context (referenced resource content if applicable)
 * - Metadata for LLM processing
 *
 * Used by:
 * - HTTP endpoint: /api/resources/{resourceId}/annotations/{annotationId}/llm-context
 * - Generation worker: Pre-fetched context included in job payload
 */

import { generateResourceSummary } from '../inference/factory';
import { getBodySource, getTargetSource, getTargetSelector } from '@semiont/api-client';
import type { components, AnnotationUri, GenerationContext } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/api-client';
import { FilesystemRepresentationStore } from '../storage/representation/representation-store';
import { getPrimaryRepresentation, getEntityTypes as getResourceEntityTypes, decodeRepresentation } from '@semiont/api-client';
import { FilesystemViewStorage } from '../storage/view-storage';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { resourceId as createResourceId } from '@semiont/core';

type AnnotationLLMContextResponse = components['schemas']['AnnotationLLMContextResponse'];
type TextPositionSelector = components['schemas']['TextPositionSelector'];
type TextQuoteSelector = components['schemas']['TextQuoteSelector'];
type Annotation = components['schemas']['Annotation'];

export interface BuildContextOptions {
  includeSourceContext?: boolean;
  includeTargetContext?: boolean;
  contextWindow?: number;
}

export class AnnotationContextService {
  /**
   * Build LLM context for an annotation
   *
   * @param annotationUri - Full annotation URI (e.g., http://localhost:4000/annotations/abc123)
   * @param resourceId - Source resource ID
   * @param config - Application configuration
   * @param options - Context building options
   * @returns Rich context for LLM processing
   * @throws Error if annotation or resource not found
   */
  static async buildLLMContext(
    annotationUri: AnnotationUri,
    resourceId: ResourceId,
    config: EnvironmentConfig,
    options: BuildContextOptions = {}
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

    console.log(`[AnnotationContext] buildLLMContext called with annotationUri=${annotationUri}, resourceId=${resourceId}`);

    const basePath = config.services.filesystem!.path;
    console.log(`[AnnotationContext] basePath=${basePath}`);

    const projectRoot = config._metadata?.projectRoot;
    const viewStorage = new FilesystemViewStorage(basePath, projectRoot);
    const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

    // Get source resource view
    console.log(`[AnnotationContext] Getting view for resourceId=${resourceId}`);
    let sourceView;
    try {
      sourceView = await viewStorage.get(resourceId);
      console.log(`[AnnotationContext] Got view:`, !!sourceView);

      if (!sourceView) {
        throw new Error('Source resource not found');
      }
    } catch (error) {
      console.error(`[AnnotationContext] Error getting view:`, error);
      throw error;
    }

    console.log(`[AnnotationContext] Looking for annotation ${annotationUri} in resource ${resourceId}`);
    console.log(`[AnnotationContext] View has ${sourceView.annotations.annotations.length} annotations`);
    console.log(`[AnnotationContext] First 5 annotation IDs:`, sourceView.annotations.annotations.slice(0, 5).map((a: Annotation) => a.id));

    // Find the annotation in the view (annotations have full URIs as their id)
    const annotation = sourceView.annotations.annotations.find((a: Annotation) => a.id === annotationUri);
    console.log(`[AnnotationContext] Found annotation:`, !!annotation);

    if (!annotation) {
      throw new Error('Annotation not found in view');
    }

    const targetSource = getTargetSource(annotation.target);
    // Extract resource ID from the target source URI (format: http://host/resources/{id})
    const targetResourceId = targetSource.split('/').pop();
    console.log(`[AnnotationContext] Target source: ${targetSource}, Expected resource ID: ${resourceId}, Extracted ID: ${targetResourceId}`);

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
      const targetView = await viewStorage.get(targetResourceId);
      targetDoc = targetView?.resource || null;
    }

    // Build source context if requested
    let sourceContext;
    if (includeSourceContext) {
      const primaryRep = getPrimaryRepresentation(sourceDoc);
      if (!primaryRep?.checksum || !primaryRep?.mediaType) {
        throw new Error('Source content not found');
      }
      const sourceContent = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
      const contentStr = decodeRepresentation(sourceContent, primaryRep.mediaType);

      const targetSelectorRaw = getTargetSelector(annotation.target);

      // Handle array of selectors - take the first one
      const targetSelector = Array.isArray(targetSelectorRaw) ? targetSelectorRaw[0] : targetSelectorRaw;

      console.log(`[AnnotationContext] Target selector type:`, targetSelector?.type);

      if (!targetSelector) {
        console.warn(`[AnnotationContext] No target selector found`);
      } else if (targetSelector.type === 'TextPositionSelector') {
        // TypeScript now knows this is TextPositionSelector with required start/end
        const selector = targetSelector as TextPositionSelector;
        const start = selector.start;
        const end = selector.end;

        const before = contentStr.slice(Math.max(0, start - contextWindow), start);
        const selected = contentStr.slice(start, end);
        const after = contentStr.slice(end, Math.min(contentStr.length, end + contextWindow));

        sourceContext = { before, selected, after };
        console.log(`[AnnotationContext] Built source context using TextPositionSelector (${start}-${end})`);
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
          console.log(`[AnnotationContext] Built source context using TextQuoteSelector (found at ${index})`);
        } else {
          console.warn(`[AnnotationContext] TextQuoteSelector exact text not found in content: "${exact.substring(0, 50)}..."`);
        }
      } else {
        console.warn(`[AnnotationContext] Unknown selector type: ${(targetSelector as any).type}`);
      }
    }

    // Build target context if requested and available
    let targetContext;
    if (includeTargetContext && targetDoc) {
      const targetRep = getPrimaryRepresentation(targetDoc);
      if (targetRep?.checksum && targetRep?.mediaType) {
        const targetContent = await repStore.retrieve(targetRep.checksum, targetRep.mediaType);
        const contentStr = decodeRepresentation(targetContent, targetRep.mediaType);

        targetContext = {
          content: contentStr.slice(0, contextWindow * 2),
          summary: await generateResourceSummary(targetDoc.name, contentStr, getResourceEntityTypes(targetDoc), config),
        };
      }
    }

    // TODO: Generate suggested resolution using AI
    const suggestedResolution = undefined;

    // Build GenerationContext structure
    const generationContext: GenerationContext | undefined = sourceContext ? {
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
}
