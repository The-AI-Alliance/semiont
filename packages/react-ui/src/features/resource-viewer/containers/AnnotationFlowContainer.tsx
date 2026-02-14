/**
 * AnnotationFlowContainer - Manages annotation creation flow
 *
 * This container handles:
 * - Pending annotation state (user selected text, waiting for confirmation)
 * - Selection events → pending annotation conversion
 * - Annotation request routing to appropriate panel
 * - Annotation interaction (hover, click, delete, cancel)
 *
 * By extracting this container:
 * 1. Annotation creation logic is testable
 * 2. Clear event → state → panel routing flow
 * 3. Separates annotation business logic from UI
 */

import { useState, useCallback } from 'react';
import type { Selector, Motivation } from '@semiont/api-client';
import { useEventBus } from '../../../contexts/EventBusContext';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';

// Unified pending annotation type
interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

export interface AnnotationFlowState {
  pendingAnnotation: PendingAnnotation | null;
  hoveredAnnotationId: string | null;
}

export interface AnnotationFlowContainerProps {
  onDeleteAnnotation: (annotationId: string) => Promise<void>;
  children: (state: AnnotationFlowState) => React.ReactNode;
}

/**
 * Container for annotation creation and interaction flow
 *
 * Usage:
 * ```tsx
 * <AnnotationFlowContainer onDeleteAnnotation={deleteAnnotation}>
 *   {({ pendingAnnotation, hoveredAnnotationId }) => (
 *     <UnifiedAnnotationsPanel
 *       pendingAnnotation={pendingAnnotation}
 *       hoveredAnnotationId={hoveredAnnotationId}
 *     />
 *   )}
 * </AnnotationFlowContainer>
 * ```
 */
export function AnnotationFlowContainer({
  onDeleteAnnotation,
  children,
}: AnnotationFlowContainerProps) {
  const eventBus = useEventBus();

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
  }, [eventBus]);

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
    // Direct annotation request
    'annotation:requested': handleAnnotationRequested,

    // Selection events → annotation requests
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

    // Annotation interaction
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
      await onDeleteAnnotation(annotationId);
    },
  });

  return <>{children({ pendingAnnotation, hoveredAnnotationId })}</>;
}
