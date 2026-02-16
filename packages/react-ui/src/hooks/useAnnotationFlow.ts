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

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Selector, Motivation, ResourceUri } from '@semiont/api-client';
import { useEventBus } from '../contexts/EventBusContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';

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
 * @param onDeleteAnnotation - Callback for deleting annotations
 * @returns Annotation flow state
 */
export function useAnnotationFlow(
  rUri: ResourceUri,
  onDeleteAnnotation: (annotationId: string, rUri: ResourceUri) => Promise<void>
): AnnotationFlowState {
  const eventBus = useEventBus();

  // Store callback prop in ref to avoid including in dependency arrays
  const onDeleteAnnotationRef = useRef(onDeleteAnnotation);
  useEffect(() => {
    onDeleteAnnotationRef.current = onDeleteAnnotation;
  });

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

  // Subscribe to annotation events
  useEventSubscriptions({
    'annotation:requested': handleAnnotationRequested,
    'selection:comment-requested': (selection: any) => {
      handleAnnotationRequested({
        selector: selectionToSelector(selection),
        motivation: 'commenting'
      });
    },
    'selection:tag-requested': (selection: any) => {
      handleAnnotationRequested({
        selector: selectionToSelector(selection),
        motivation: 'tagging'
      });
    },
    'selection:assessment-requested': (selection: any) => {
      handleAnnotationRequested({
        selector: selectionToSelector(selection),
        motivation: 'assessing'
      });
    },
    'selection:reference-requested': (selection: any) => {
      handleAnnotationRequested({
        selector: selectionToSelector(selection),
        motivation: 'linking'
      });
    },
    'annotation:cancel-pending': () => {
      setPendingAnnotation(null);
    },
    'annotation:hover': ({ annotationId }: { annotationId: string | null }) => {
      setHoveredAnnotationId(annotationId);
      if (annotationId) {
        eventBus.emit('annotation:sparkle', { annotationId });
      }
    },
    'annotation:click': ({ annotationId }: { annotationId: string }) => {
      eventBus.emit('annotation:focus', { annotationId });
      // Click scroll handled by ResourceViewer internally
    },
    'annotation:delete': async ({ annotationId }: { annotationId: string }) => {
      await onDeleteAnnotationRef.current(annotationId, rUri);
    },
  });

  return { pendingAnnotation, hoveredAnnotationId };
}
