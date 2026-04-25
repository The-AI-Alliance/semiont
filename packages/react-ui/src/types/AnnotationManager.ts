import type { Annotation, ResourceId, Selector } from '@semiont/core';

/**
 * Parameters for creating an annotation
 */
export interface CreateAnnotationParams {
  rUri: ResourceId;
  motivation: 'highlighting' | 'linking' | 'assessing' | 'commenting' | 'tagging';
  selector: Selector | Selector[];
  body?: any[];
}

/**
 * Parameters for deleting an annotation
 */
export interface DeleteAnnotationParams {
  annotationId: string;
  rUri: ResourceId;
}

/**
 * Annotation Manager Interface
 *
 * Framework-agnostic interface for annotation mutations.
 * Apps provide implementations via AnnotationProvider.
 *
 * Example implementation:
 * ```typescript
 * function useAnnotationManager(client: SemiontClient): AnnotationManager {
 *   return {
 *     markAnnotation: async (params) => {
 *       const result = await client.markAnnotation(params.rUri, {...});
 *       return result.annotation;
 *     },
 *     deleteAnnotation: async (params) => {
 *       await client.deleteAnnotation(params.rUri, params.annotationId);
 *     }
 *   };
 * }
 * ```
 */
export interface AnnotationManager {
  /**
   * Create a new annotation
   * @param params - Creation parameters (rUri, motivation, selector, body)
   * @returns Promise resolving to the created annotation, or undefined if creation fails
   */
  markAnnotation: (params: CreateAnnotationParams) => Promise<Annotation | undefined>;

  /**
   * Delete an annotation
   * @param params - Deletion parameters (annotationId, rUri)
   * @returns Promise resolving when deletion completes
   */
  deleteAnnotation: (params: DeleteAnnotationParams) => Promise<void>;
}
