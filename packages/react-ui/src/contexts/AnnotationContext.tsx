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
 * function useAnnotationManager(client: SemiontClient): AnnotationManager {
 *   return {
 *     markAnnotation: async (params) => {
 *       const result = await client.mark.annotation(params.rUri, {
 *         motivation: params.motivation,
 *         target: { source: params.rUri, selector: params.selector },
 *         body: params.body,
 *       });
 *       return result.annotation;
 *     },
 *     deleteAnnotation: async (params) => {
 *       await client.mark.delete(params.rUri, params.annotationId);
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
