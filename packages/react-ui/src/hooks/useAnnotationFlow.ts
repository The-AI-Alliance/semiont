/**
 * useAnnotationFlow - Annotation creation flow hook
 *
 * Manages annotation creation and interaction:
 * - Pending annotation state (user selected text, waiting for confirmation)
 * - Selection events → pending annotation conversion
 * - Annotation interaction (hover, click, delete)
 * - Annotation request routing to appropriate panel
 *
 * Follows react-rxjs-guide.md Layer 2 pattern: Hook bridge that
 * subscribes to events and pushes values into React state.
 */

import { useState, useCallback } from 'react';
import type { Selector, Motivation, ResourceUri } from '@semiont/api-client';
import { useEventBus } from '../contexts/EventBusContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useEventOperations } from '../contexts/useEventOperations';
import { useApiClient } from '../contexts/ApiClientContext';

// Unified pending annotation type
interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

export interface AnnotationFlowState {
  pendingAnnotation: PendingAnnotation | null;
  hoveredAnnotationId: string | null;
}

/**
 * Hook for annotation creation and interaction flow
 *
 * @param rUri - Resource URI
 * @emits panel:open - Open the annotations panel when annotation is requested
 * @emits annotation:sparkle - Trigger sparkle animation on hovered annotation
 * @emits annotation:focus - Focus/scroll to clicked annotation
 * @subscribes annotation:requested - User requested a new annotation
 * @subscribes selection:comment-requested - User selected text for a comment
 * @subscribes selection:tag-requested - User selected text for a tag
 * @subscribes selection:assessment-requested - User selected text for an assessment
 * @subscribes selection:reference-requested - User selected text for a reference
 * @subscribes annotation:cancel-pending - Cancel pending annotation creation
 * @subscribes annotation:hover - Annotation hover state change
 * @subscribes annotation:click - Annotation clicked
 * @returns Annotation flow state
 */
export function useAnnotationFlow(rUri: ResourceUri): AnnotationFlowState {
  const eventBus = useEventBus();
  const client = useApiClient();

  // Set up event operations (handles annotation:delete → API call)
  useEventOperations(eventBus, { client, resourceUri: rUri });

  // Annotation state
  const [pendingAnnotation, setPendingAnnotation] = useState<PendingAnnotation | null>(null);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);

  // Handle annotation request - route to appropriate panel
  const handleAnnotationRequested = useCallback((pending: PendingAnnotation) => {
    // Route to appropriate panel tab based on motivation
    const MOTIVATION_TO_TAB: Record<Motivation, string> = {
      highlighting: 'annotations',
      commenting: 'annotations',
      assessing: 'annotations',
      tagging: 'annotations',
      linking: 'annotations',
      bookmarking: 'annotations',
      classifying: 'annotations',
      describing: 'annotations',
      editing: 'annotations',
      identifying: 'annotations',
      moderating: 'annotations',
      questioning: 'annotations',
      replying: 'annotations',
    };

    // Emit event to open the appropriate panel
    eventBus.emit('panel:open', { panel: MOTIVATION_TO_TAB[pending.motivation] || 'annotations' });
    setPendingAnnotation(pending);
  }, []); // eventBus is stable singleton - never in deps

  // Convert selection to selector helper
  const selectionToSelector = useCallback((selection: any): Selector | Selector[] => {
    // SVG selector (for images/PDFs)
    if (selection.svgSelector) {
      return {
        type: 'SvgSelector',
        value: selection.svgSelector
      };
    }

    // Fragment selector (for media)
    if (selection.fragmentSelector) {
      const selectors: Selector[] = [
        {
          type: 'FragmentSelector',
          value: selection.fragmentSelector,
          ...(selection.conformsTo && { conformsTo: selection.conformsTo })
        }
      ];

      // Include text quote if present
      if (selection.exact) {
        selectors.push({
          type: 'TextQuoteSelector',
          exact: selection.exact,
          ...(selection.prefix && { prefix: selection.prefix }),
          ...(selection.suffix && { suffix: selection.suffix })
        });
      }

      return selectors;
    }

    // Text quote selector (default)
    return {
      type: 'TextQuoteSelector',
      exact: selection.exact,
      start: selection.start,
      end: selection.end,
      ...(selection.prefix && { prefix: selection.prefix }),
      ...(selection.suffix && { suffix: selection.suffix })
    };
  }, []);

  const handleCommentRequested = useCallback((selection: any) => {
    handleAnnotationRequested({ selector: selectionToSelector(selection), motivation: 'commenting' });
  }, [handleAnnotationRequested, selectionToSelector]);

  const handleTagRequested = useCallback((selection: any) => {
    handleAnnotationRequested({ selector: selectionToSelector(selection), motivation: 'tagging' });
  }, [handleAnnotationRequested, selectionToSelector]);

  const handleAssessmentRequested = useCallback((selection: any) => {
    handleAnnotationRequested({ selector: selectionToSelector(selection), motivation: 'assessing' });
  }, [handleAnnotationRequested, selectionToSelector]);

  const handleReferenceRequested = useCallback((selection: any) => {
    handleAnnotationRequested({ selector: selectionToSelector(selection), motivation: 'linking' });
  }, [handleAnnotationRequested, selectionToSelector]);

  const handleAnnotationCancelPending = useCallback(() => {
    setPendingAnnotation(null);
  }, []);

  const handleAnnotationHover = useCallback(({ annotationId }: { annotationId: string | null }) => {
    setHoveredAnnotationId(annotationId);
    if (annotationId) {
      eventBus.emit('annotation:sparkle', { annotationId });
    }
  }, []); // eventBus is stable singleton - never in deps

  const handleAnnotationClick = useCallback(({ annotationId }: { annotationId: string }) => {
    eventBus.emit('annotation:focus', { annotationId });
    // Click scroll handled by ResourceViewer internally
  }, []); // eventBus is stable singleton - never in deps

  // Subscribe to annotation events
  useEventSubscriptions({
    'annotation:requested': handleAnnotationRequested,
    'selection:comment-requested': handleCommentRequested,
    'selection:tag-requested': handleTagRequested,
    'selection:assessment-requested': handleAssessmentRequested,
    'selection:reference-requested': handleReferenceRequested,
    'annotation:cancel-pending': handleAnnotationCancelPending,
    'annotation:hover': handleAnnotationHover,
    'annotation:click': handleAnnotationClick,
    // Note: 'annotation:delete' is handled by useEventOperations (not here)
  });

  return { pendingAnnotation, hoveredAnnotationId };
}
