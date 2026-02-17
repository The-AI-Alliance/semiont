'use client';

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { useAnnotations } from '../lib/api-hooks';
import type { components, AnnotationUri, ResourceUri, Selector } from '@semiont/api-client';
import { useDocumentAnnouncements } from '../components/LiveRegion';

type Annotation = components['schemas']['Annotation'];
// Create annotation request type - narrow target to only the object form (not string)
type CreateAnnotationRequest = Omit<Annotation, 'id' | 'created' | 'modified' | 'creator' | '@context' | 'type' | 'target'> & {
  target: {
    source: string;
    selector: Selector | Selector[];
  };
} & Partial<Pick<Annotation, '@context' | 'type'>>;

interface ResourceAnnotationsContextType {
  // UI state only - data comes from React Query hooks in components
  newAnnotationIds: Set<string>; // Track recently created annotations for sparkle animations

  // Generic annotation creation (supports both text and image annotations)
  createAnnotation: (
    rUri: ResourceUri,
    motivation: 'highlighting' | 'linking' | 'assessing' | 'commenting' | 'tagging',
    selector: Selector | Selector[],
    body?: any[]
  ) => Promise<Annotation | undefined>;

  // UI actions
  clearNewAnnotationId: (id: AnnotationUri) => void;
  triggerSparkleAnimation: (annotationId: string) => void;
}

const ResourceAnnotationsContext = createContext<ResourceAnnotationsContextType | undefined>(undefined);

export function ResourceAnnotationsProvider({ children }: { children: React.ReactNode }) {
  // UI state only - no data management
  const [newAnnotationIds, setNewAnnotationIds] = useState<Set<string>>(new Set());

  // Live region announcements
  const { announceAnnotationCreated, announceError } = useDocumentAnnouncements();

  // API hooks
  const annotations = useAnnotations();

  // Set up mutation hooks
  const createAnnotationMutation = annotations.create.useMutation();

  // Generic annotation creation function (supports both text and image annotations)
  const createAnnotation = useCallback(async (
    rUri: ResourceUri,
    motivation: 'highlighting' | 'linking' | 'assessing' | 'commenting' | 'tagging',
    selector: Selector | Selector[],
    body: any[] = []
  ): Promise<Annotation | undefined> => {
    try {
      const createData: CreateAnnotationRequest = {
        motivation,
        target: {
          source: rUri,
          selector,
        },
        body,
      };

      const result = await createAnnotationMutation.mutateAsync({
        rUri,
        data: createData
      });

      // Track this as a new annotation for sparkle animation
      if (result.annotation?.id) {
        setNewAnnotationIds(prev => new Set(prev).add(result.annotation!.id));

        // Clear the ID after animation completes (6 seconds for 3 iterations)
        setTimeout(() => {
          setNewAnnotationIds(prev => {
            const next = new Set(prev);
            next.delete(result.annotation!.id);
            return next;
          });
        }, 6000);

        // Announce the creation
        announceAnnotationCreated(result.annotation);
      }

      return result.annotation;
    } catch (err) {
      console.error('Failed to create annotation:', err);
      announceError('Failed to create annotation');
      throw err;
    }
  }, [createAnnotationMutation, announceAnnotationCreated, announceError]);

  const clearNewAnnotationId = useCallback((id: AnnotationUri) => {
    setNewAnnotationIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const triggerSparkleAnimation = useCallback((annotationId: string) => {
    setNewAnnotationIds(prev => new Set(prev).add(annotationId));

    // Clear after animation
    setTimeout(() => {
      setNewAnnotationIds(prev => {
        const next = new Set(prev);
        next.delete(annotationId);
        return next;
      });
    }, 6000);
  }, []);

  const contextValue = useMemo(
    () => ({
      newAnnotationIds,
      createAnnotation,
      clearNewAnnotationId,
      triggerSparkleAnimation,
    }),
    [newAnnotationIds, createAnnotation, clearNewAnnotationId, triggerSparkleAnimation]
  );

  return (
    <ResourceAnnotationsContext.Provider value={contextValue}>
      {children}
    </ResourceAnnotationsContext.Provider>
  );
}

export function useResourceAnnotations() {
  const context = useContext(ResourceAnnotationsContext);
  if (!context) {
    throw new Error('useResourceAnnotations must be used within ResourceAnnotationsProvider');
  }
  return context;
}
