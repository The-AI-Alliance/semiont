'use client';

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from '../hooks/useObservable';
import type { components, AnnotationId, ResourceId, Selector } from '@semiont/core';
import { useLiveRegion } from '../components/LiveRegion';

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
  markAnnotation: (
    rUri: ResourceId,
    motivation: 'highlighting' | 'linking' | 'assessing' | 'commenting' | 'tagging',
    selector: Selector | Selector[],
    body?: any[]
  ) => Promise<string | undefined>;

  // UI actions
  clearNewAnnotationId: (id: AnnotationId) => void;
  triggerSparkleAnimation: (annotationId: string) => void;
}

const ResourceAnnotationsContext = createContext<ResourceAnnotationsContextType | undefined>(undefined);

export function ResourceAnnotationsProvider({ children }: { children: React.ReactNode }) {
  // UI state only - no data management
  const [newAnnotationIds, setNewAnnotationIds] = useState<Set<string>>(new Set());

  // Live region announcements
  const { announce } = useLiveRegion();

  const semiont = useObservable(useSemiont().activeSession$)?.client;

  const markAnnotation = useCallback(async (
    rUri: ResourceId,
    motivation: 'highlighting' | 'linking' | 'assessing' | 'commenting' | 'tagging',
    selector: Selector | Selector[],
    body: any[] = []
  ): Promise<string | undefined> => {
    if (!semiont) throw new Error('Not authenticated');
    try {
      const createData: CreateAnnotationRequest = {
        motivation,
        target: {
          source: rUri,
          selector,
        },
        body,
      };

      const result = await semiont.markAnnotation(rUri, createData);

      // Track this as a new annotation for sparkle animation
      if (result.annotationId) {
        setNewAnnotationIds(prev => new Set(prev).add(result.annotationId));

        // Clear the ID after animation completes (6 seconds for 3 iterations)
        setTimeout(() => {
          setNewAnnotationIds(prev => {
            const next = new Set(prev);
            next.delete(result.annotationId);
            return next;
          });
        }, 6000);

        // Announce the creation
        announce('Annotation created', 'polite');
      }

      return result.annotationId;
    } catch (err) {
      console.error('Failed to create annotation:', err);
      announce('Failed to create annotation', 'assertive');
      throw err;
    }
  }, [semiont, announce]);

  const clearNewAnnotationId = useCallback((id: AnnotationId) => {
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
      markAnnotation,
      clearNewAnnotationId,
      triggerSparkleAnimation,
    }),
    [newAnnotationIds, markAnnotation, clearNewAnnotationId, triggerSparkleAnimation]
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
