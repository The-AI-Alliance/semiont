'use client';

import React, { createContext, useContext } from 'react';
import type { AnnotationManager } from '../types/AnnotationManager';

const AnnotationContext = createContext<AnnotationManager | undefined>(undefined);

export interface AnnotationProviderProps {
  annotationManager: AnnotationManager;
  children: React.ReactNode;
}

/**
 * Annotation Provider
 *
 * Provides annotation mutation capabilities (create, delete) via the Provider Pattern.
 * Apps inject their own AnnotationManager implementation.
 *
 * Example usage:
 * ```typescript
 * // In app (apps/frontend/src/hooks/useAnnotationManager.ts)
 * function useAnnotationManager(): AnnotationManager {
 *   const annotations = useAnnotations();
 *   const createMutation = annotations.create.useMutation();
 *   const deleteMutation = annotations.delete.useMutation();
 *
 *   return {
 *     createAnnotation: async (params) => {
 *       const result = await createMutation.mutateAsync({
 *         rUri: params.rUri,
 *         data: { motivation: params.motivation, target: { source: params.rUri, selector: params.selector }, body: params.body }
 *       });
 *       return result.annotation;
 *     },
 *     deleteAnnotation: async (params) => {
 *       const annotationIdSegment = params.annotationId.split('/').pop() || params.annotationId;
 *       await deleteMutation.mutateAsync(resourceAnnotationUri(`${params.rUri}/annotations/${annotationIdSegment}`));
 *     }
 *   };
 * }
 *
 * // In app layout
 * const annotationManager = useAnnotationManager();
 * <AnnotationProvider annotationManager={annotationManager}>
 *   <YourComponents />
 * </AnnotationProvider>
 * ```
 */
export function AnnotationProvider({ annotationManager, children }: AnnotationProviderProps) {
  return (
    <AnnotationContext.Provider value={annotationManager}>
      {children}
    </AnnotationContext.Provider>
  );
}

/**
 * Hook to access the AnnotationManager
 *
 * @throws Error if used outside AnnotationProvider
 * @returns AnnotationManager instance
 */
export function useAnnotationManager(): AnnotationManager {
  const context = useContext(AnnotationContext);
  if (!context) {
    throw new Error('useAnnotationManager must be used within an AnnotationProvider');
  }
  return context;
}
