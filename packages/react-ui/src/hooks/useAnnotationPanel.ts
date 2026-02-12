'use client';

import { useRef, useCallback } from 'react';
import type { components } from '@semiont/api-client';
import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';
import { useEventSubscriptions } from '../contexts/useEventSubscription';

type Annotation = components['schemas']['Annotation'];

/**
 * Shared logic for annotation panel components
 *
 * Handles:
 * - Sorting annotations by position in the resource
 * - Hover effects: scroll to annotation and pulse highlight
 * - Ref management for annotation elements
 *
 * Used by: HighlightPanel, AssessmentPanel, CommentsPanel, ReferencesPanel
 */
export function useAnnotationPanel<T extends Annotation>(
  annotations: T[]
) {
  const refs = useRef<Map<string, HTMLElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Sort annotations by their position in the resource
  const sortedAnnotations = [...annotations].sort((a, b) => {
    const aSelector = getTextPositionSelector(getTargetSelector(a.target));
    const bSelector = getTextPositionSelector(getTargetSelector(b.target));
    if (!aSelector || !bSelector) return 0;
    return aSelector.start - bSelector.start;
  });

  // Helper to scroll annotation into view with pulse effect
  const scrollToAnnotation = useCallback((annotationId: string) => {
    const element = refs.current.get(annotationId);
    if (!element || !containerRef.current) return;

    // Only scroll if element is not fully visible within its container
    const container = containerRef.current;
    const elementRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    const isVisible =
      elementRect.top >= containerRect.top &&
      elementRect.bottom <= containerRect.bottom;

    if (!isVisible) {
      // Use container.scrollTo instead of scrollIntoView to avoid scrolling ancestors
      const elementTop = element.offsetTop;
      const containerHeight = container.clientHeight;
      const elementHeight = element.offsetHeight;
      const scrollTo = elementTop - (containerHeight / 2) + (elementHeight / 2);

      container.scrollTo({ top: scrollTo, behavior: 'smooth' });
    }

    // Use proper CSS class for pulse effect
    element.classList.add('semiont-annotation-pulse');
    setTimeout(() => {
      element.classList.remove('semiont-annotation-pulse');
    }, 1500);
  }, []);

  // Subscribe to hover and ref update events
  useEventSubscriptions({
    'annotation:hover': ({ annotationId }: { annotationId: string | null }) => {
      if (annotationId) scrollToAnnotation(annotationId);
    },
    'annotation-entry:hover': ({ annotationId }: { annotationId: string | null }) => {
      if (annotationId) scrollToAnnotation(annotationId);
    },
    'annotation:ref-update': ({ annotationId, element }: { annotationId: string; element: HTMLElement | null }) => {
      if (element) {
        refs.current.set(annotationId, element);
      } else {
        refs.current.delete(annotationId);
      }
    },
  });

  // Ref callback for annotation elements (deprecated - use annotation:ref-update event)
  const handleAnnotationRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) {
      refs.current.set(id, el);
    } else {
      refs.current.delete(id);
    }
  }, []);

  return {
    sortedAnnotations,
    containerRef,
    handleAnnotationRef
  };
}
