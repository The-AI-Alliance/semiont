'use client';

import { useRef, useEffect, useCallback } from 'react';
import type { components } from '@semiont/api-client';
import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';
import { useMakeMeaningEvents } from '../contexts/MakeMeaningEventBusContext';

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
  const eventBus = useMakeMeaningEvents();
  const refs = useRef<Map<string, HTMLElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Sort annotations by their position in the resource
  const sortedAnnotations = [...annotations].sort((a, b) => {
    const aSelector = getTextPositionSelector(getTargetSelector(a.target));
    const bSelector = getTextPositionSelector(getTargetSelector(b.target));
    if (!aSelector || !bSelector) return 0;
    return aSelector.start - bSelector.start;
  });

  // Subscribe to annotation hover events - scroll panel entry into view
  useEffect(() => {
    const handleAnnotationHover = ({ annotationId }: { annotationId: string | null }) => {
      if (!annotationId) return;

      const element = refs.current.get(annotationId);
      if (element && containerRef.current) {
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
      }
    };

    eventBus.on('annotation:hover', handleAnnotationHover);
    return () => eventBus.off('annotation:hover', handleAnnotationHover);
  }, [eventBus]);

  // Subscribe to comment hover events - scroll panel entry into view
  useEffect(() => {
    const handleCommentHover = ({ commentId }: { commentId: string | null }) => {
      if (!commentId) return;

      const element = refs.current.get(commentId);
      if (element && containerRef.current) {
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
      }
    };

    eventBus.on('comment:hover', handleCommentHover);
    return () => eventBus.off('comment:hover', handleCommentHover);
  }, [eventBus]);

  // Ref callback for annotation elements
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
