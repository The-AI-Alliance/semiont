import type { components, ResourceUri, Selector } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

/**
 * Parameters for creating an annotation
 */
export interface CreateAnnotationParams {
  rUri: ResourceUri;
  motivation: 'highlighting' | 'linking' | 'assessing' | 'commenting' | 'tagging';
  selector: Selector | Selector[];
  body?: any[];
}

/**
 * Parameters for deleting an annotation
 */
export interface DeleteAnnotationParams {
  annotationId: string;
  rUri: ResourceUri;
}

/**
 * Annotation Manager Interface
 *
 * Framework-agnostic interface for annotation mutations.
 * Apps provide implementations via AnnotationProvider.
 *
 * Example implementation (React Query):
 * ```typescript
 * function useAnnotationManager(): AnnotationManager {
 *   const createMutation = useAnnotations().create.useMutation();
 *   const deleteMutation = useAnnotations().delete.useMutation();
 *
 *   return {
 *     createAnnotation: async (params) => {
 *       const result = await createMutation.mutateAsync({...});
 *       return result.annotation;
 *     },
 *     deleteAnnotation: async (params) => {
 *       await deleteMutation.mutateAsync({...});
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
  createAnnotation: (params: CreateAnnotationParams) => Promise<Annotation | undefined>;

  /**
   * Delete an annotation
   * @param params - Deletion parameters (annotationId, rUri)
   * @returns Promise resolving when deletion completes
   */
  deleteAnnotation: (params: DeleteAnnotationParams) => Promise<void>;
}
