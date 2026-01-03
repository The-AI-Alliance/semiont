import { useMemo, useRef, useEffect, useCallback } from 'react';
import type { components } from '@semiont/api-client';
import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';

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
  hoveredId: string | null | undefined
) {
  const refs = useRef<Map<string, HTMLElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Sort annotations by their position in the resource
  const sortedAnnotations = useMemo(() => {
    return [...annotations].sort((a, b) => {
      const aSelector = getTextPositionSelector(getTargetSelector(a.target));
      const bSelector = getTextPositionSelector(getTargetSelector(b.target));
      if (!aSelector || !bSelector) return 0;
      return aSelector.start - bSelector.start;
    });
  }, [annotations]);

  // Handle hover: scroll to annotation and pulse highlight
  useEffect(() => {
    if (!hoveredId) return;

    const element = refs.current.get(hoveredId);
    if (element && containerRef.current) {
      element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      element.classList.add('bg-gray-200', 'dark:bg-gray-700');
      setTimeout(() => {
        element.classList.remove('bg-gray-200', 'dark:bg-gray-700');
      }, 1500);
    }
  }, [hoveredId]);

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
