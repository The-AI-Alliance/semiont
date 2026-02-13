'use client';

import { useRef, useCallback, useMemo } from 'react';
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
  annotations: T[],
  containerRef: React.RefObject<HTMLDivElement>
) {
  const refs = useRef<Map<string, HTMLElement>>(new Map());

  // Sort annotations by their position in the resource
  const sortedAnnotations = useMemo(() => {
    return [...annotations].sort((a, b) => {
      const aSelector = getTextPositionSelector(getTargetSelector(a.target));
      const bSelector = getTextPositionSelector(getTargetSelector(b.target));
      if (!aSelector || !bSelector) return 0;
      return aSelector.start - bSelector.start;
    });
  }, [annotations]);

  // Helper to scroll annotation into view with pulse effect
  const scrollToAnnotation = useCallback((annotationId: string) => {
    console.log('[useAnnotationPanel] scrollToAnnotation called with:', annotationId);
    console.log('[useAnnotationPanel] refs.current has keys:', Array.from(refs.current.keys()));

    const element = refs.current.get(annotationId);
    if (!element) {
      console.warn('[useAnnotationPanel] No element found for annotationId:', annotationId);
      return;
    }
    if (!containerRef.current) {
      console.warn('[useAnnotationPanel] No container ref');
      return;
    }

    console.log('[useAnnotationPanel] Found element, will scroll');

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

      console.log('[useAnnotationPanel] Scrolling to position:', scrollTo);
      container.scrollTo({ top: scrollTo, behavior: 'smooth' });
    } else {
      console.log('[useAnnotationPanel] Element already visible, skipping scroll');
    }

    // Use proper CSS class for pulse effect
    element.classList.add('semiont-annotation-pulse');
    setTimeout(() => {
      element.classList.remove('semiont-annotation-pulse');
    }, 1500);
  }, []);

  // Event handlers (extracted from inline to avoid creating new functions on each render)
  const handleAnnotationHover = useCallback(({ annotationId }: { annotationId: string | null }) => {
    console.log('[useAnnotationPanel] annotation:hover event received:', annotationId);
    if (annotationId) scrollToAnnotation(annotationId);
  }, [scrollToAnnotation]);

  const handleAnnotationEntryHover = useCallback(({ annotationId }: { annotationId: string | null }) => {
    console.log('[useAnnotationPanel] annotation-entry:hover event received:', annotationId);
    if (annotationId) scrollToAnnotation(annotationId);
  }, [scrollToAnnotation]);

  const handleAnnotationClick = useCallback(({ annotationId }: { annotationId: string }) => {
    console.log('[useAnnotationPanel] annotation:click event received:', annotationId);
    if (annotationId) scrollToAnnotation(annotationId);
  }, [scrollToAnnotation]);

  const handleAnnotationRefUpdate = useCallback(({ annotationId, element }: { annotationId: string; element: HTMLElement | null }) => {
    console.log('[useAnnotationPanel] annotation:ref-update event received:', annotationId, element ? 'element provided' : 'element cleared');
    if (element) {
      refs.current.set(annotationId, element);
    } else {
      refs.current.delete(annotationId);
    }
  }, []);

  // Subscribe to hover, click, and ref update events
  useEventSubscriptions({
    'annotation:hover': handleAnnotationHover,
    'annotation-entry:hover': handleAnnotationEntryHover,
    'annotation:click': handleAnnotationClick,
    'annotation:ref-update': handleAnnotationRefUpdate,
  });

  return {
    sortedAnnotations
  };
}
