import { useCallback, useMemo } from 'react';
import type { AnnotationManager, CreateAnnotationParams, DeleteAnnotationParams } from '@semiont/react-ui';
import type { components } from '@semiont/api-client';
import { useAnnotations } from '@semiont/react-ui';
import { resourceAnnotationUri } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

// Create annotation request type - matches ResourceAnnotationsContext
type CreateAnnotationRequest = Omit<Annotation, 'id' | 'created' | 'modified' | 'creator' | '@context' | 'type' | 'target'> & {
  target: {
    source: string;
    selector: any;
  };
} & Partial<Pick<Annotation, '@context' | 'type'>>;

/**
 * Frontend implementation of AnnotationManager using React Query
 *
 * Usage:
 * ```typescript
 * const annotationManager = useAnnotationManager();
 * <AnnotationProvider annotationManager={annotationManager}>
 *   <YourComponents />
 * </AnnotationProvider>
 * ```
 */
export function useAnnotationManager(): AnnotationManager {
  const annotations = useAnnotations();
  const createMutation = annotations.create.useMutation();
  const deleteMutation = annotations.delete.useMutation();

  const createAnnotation = useCallback(async (params: CreateAnnotationParams): Promise<Annotation | undefined> => {
    try {
      const createData: CreateAnnotationRequest = {
        motivation: params.motivation,
        target: {
          source: params.rUri,
          selector: params.selector,
        },
        body: params.body || [],
      };

      const result = await createMutation.mutateAsync({
        rUri: params.rUri,
        data: createData
      });

      return result.annotation;
    } catch (err) {
      console.error('Failed to create annotation:', err);
      throw err;
    }
  }, [createMutation]);

  const deleteAnnotation = useCallback(async (params: DeleteAnnotationParams): Promise<void> => {
    try {
      // annotationId might be a full URI or just a UUID - extract the UUID
      const annotationIdSegment = params.annotationId.split('/').pop() || params.annotationId;
      await deleteMutation.mutateAsync(
        resourceAnnotationUri(`${params.rUri}/annotations/${annotationIdSegment}`)
      );
    } catch (err) {
      console.error('Failed to delete annotation:', err);
      throw err;
    }
  }, [deleteMutation]);

  return useMemo(() => ({
    createAnnotation,
    deleteAnnotation
  }), [createAnnotation, deleteAnnotation]);
}
