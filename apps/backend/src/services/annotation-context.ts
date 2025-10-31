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
import { getBodySource, getTargetSource, getTargetSelector } from '../lib/annotation-utils';
import type { components } from '@semiont/api-client';
import { getFilesystemConfig } from '../config/environment-loader';
import { FilesystemRepresentationStore } from '../storage/representation/representation-store';
import { getPrimaryRepresentation, getEntityTypes as getResourceEntityTypes } from '../utils/resource-helpers';
import { createProjectionManager } from './storage-service';

type AnnotationLLMContextResponse = components['schemas']['AnnotationLLMContextResponse'];
type TextPositionSelector = components['schemas']['TextPositionSelector'];
type TextQuoteSelector = components['schemas']['TextQuoteSelector'];

export interface BuildContextOptions {
  includeSourceContext?: boolean;
  includeTargetContext?: boolean;
  contextWindow?: number;
}

export class AnnotationContextService {
  /**
   * Build LLM context for an annotation
   *
   * @param annotationId - Annotation ID (with or without URI prefix)
   * @param resourceId - Source resource ID
   * @param options - Context building options
   * @returns Rich context for LLM processing
   * @throws Error if annotation or resource not found
   */
  static async buildLLMContext(
    annotationId: string,
    resourceId: string,
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

    console.log(`[AnnotationContext] buildLLMContext called with annotationId=${annotationId}, resourceId=${resourceId}`);

    // Extract short resource ID from URI for filesystem lookups
    // (e.g., "http://localhost:4000/resources/abc123" -> "abc123")
    const shortResourceId = resourceId.split('/').pop() || resourceId;
    console.log(`[AnnotationContext] Short resource ID: ${shortResourceId}`);

    const basePath = getFilesystemConfig().path;
    console.log(`[AnnotationContext] basePath=${basePath}`);

    const projectionManager = createProjectionManager(basePath);
    const repStore = new FilesystemRepresentationStore({ basePath });

    // Get source resource projection (Layer 3) using short ID for filesystem lookup
    console.log(`[AnnotationContext] Getting projection for shortResourceId=${shortResourceId}`);
    let sourceProjection;
    try {
      sourceProjection = await projectionManager.get(shortResourceId);
      console.log(`[AnnotationContext] Got projection:`, !!sourceProjection);

      if (!sourceProjection) {
        throw new Error('Source resource not found');
      }
    } catch (error) {
      console.error(`[AnnotationContext] Error getting projection:`, error);
      throw error;
    }

    console.log(`[AnnotationContext] Looking for annotation ${annotationId} in resource ${resourceId}`);
    console.log(`[AnnotationContext] Projection has ${sourceProjection.annotations.annotations.length} annotations`);
    console.log(`[AnnotationContext] First 5 annotation IDs:`, sourceProjection.annotations.annotations.slice(0, 5).map(a => a.id));

    // Find the annotation in the projection
    const annotation = sourceProjection.annotations.annotations.find(a => a.id === annotationId);
    console.log(`[AnnotationContext] Found annotation:`, !!annotation);

    if (!annotation) {
      throw new Error('Annotation not found in projection');
    }

    const targetSource = getTargetSource(annotation.target);
    console.log(`[AnnotationContext] Target source: ${targetSource}, Expected: ${resourceId}`);

    if (targetSource !== resourceId) {
      throw new Error(`Annotation target source (${targetSource}) does not match expected resource ID (${resourceId})`);
    }

    const sourceDoc = sourceProjection.resource;

    // Get target resource if annotation is a reference (has resolved body source)
    const bodySource = getBodySource(annotation.body);
    let targetDoc = null;
    if (bodySource) {
      // Extract short ID from body source URI for filesystem lookup
      const shortBodySourceId = bodySource.split('/').pop() || bodySource;
      const targetProjection = await projectionManager.get(shortBodySourceId);
      targetDoc = targetProjection?.resource || null;
    }

    // Build source context if requested
    let sourceContext;
    if (includeSourceContext) {
      const primaryRep = getPrimaryRepresentation(sourceDoc);
      if (!primaryRep?.checksum || !primaryRep?.mediaType) {
        throw new Error('Source content not found');
      }
      const sourceContent = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
      const contentStr = sourceContent.toString('utf-8');

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
        const contentStr = targetContent.toString('utf-8');

        targetContext = {
          content: contentStr.slice(0, contextWindow * 2),
          summary: await generateResourceSummary(targetDoc.name, contentStr, getResourceEntityTypes(targetDoc)),
        };
      }
    }

    // TODO: Generate suggested resolution using AI
    const suggestedResolution = undefined;

    const response: AnnotationLLMContextResponse = {
      annotation,
      sourceResource: sourceDoc,
      targetResource: targetDoc,
      ...(sourceContext ? { sourceContext } : {}),
      ...(targetContext ? { targetContext } : {}),
      ...(suggestedResolution ? { suggestedResolution } : {}),
    };

    return response;
  }
}
