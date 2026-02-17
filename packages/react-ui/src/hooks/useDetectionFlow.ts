/**
 * useDetectionFlow - Detection state management hook
 *
 * Manages all annotation detection (manual and AI-driven):
 * - Pending annotation state (user selected text, waiting for confirmation)
 * - Selection events → pending annotation conversion
 * - Annotation interaction (hover, click)
 * - Annotation request routing to appropriate panel
 * - Tracking currently detecting motivation (AI-driven detection)
 * - Detection progress updates from SSE
 * - Detection lifecycle (start, progress, complete, failed)
 * - Auto-dismiss progress after completion (5 seconds)
 * - Manual dismiss via detection:dismiss-progress event
 *
 * "Detection" covers both forms: a human selecting text is manual detection;
 * AI-driven SSE streams are automated detection. Same concept, same hook.
 *
 * Follows react-rxjs-guide.md Layer 2 pattern: Hook bridge that
 * subscribes to events and pushes values into React state.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import type { Motivation, ResourceUri, Selector } from '@semiont/api-client';
import { useEventBus } from '../contexts/EventBusContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useApiClient } from '../contexts/ApiClientContext';
import { useEventOperations } from '../contexts/useEventOperations';
import type { DetectionProgress } from '../types/progress';

// Unified pending annotation type
interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

export interface DetectionFlowState {
  // Manual detection state
  pendingAnnotation: PendingAnnotation | null;
  hoveredAnnotationId: string | null;
  // AI detection state
  detectingMotivation: Motivation | null;
  detectionProgress: DetectionProgress | null;
  detectionStreamRef: React.MutableRefObject<any>;
}

/**
 * Hook for annotation detection flow (manual and AI-driven)
 *
 * @param rUri - Resource URI being detected
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
 * @subscribes detection:start - Detection started for a motivation
 * @subscribes detection:progress - Progress update during detection
 * @subscribes detection:complete - Detection completed successfully
 * @subscribes detection:failed - Error during detection
 * @subscribes detection:dismiss-progress - Manually dismiss progress display
 * @returns Detection state
 *
 * Note: All API operations (annotation:create, annotation:delete, detection:start → SSE, etc.)
 * are handled by useEventOperations, which is registered here as the single registration point.
 */
export function useDetectionFlow(rUri: ResourceUri): DetectionFlowState {
  const eventBus = useEventBus();
  const client = useApiClient();

  // Set up event operation handlers (annotation CRUD, detection SSE, generation SSE, etc.)
  useEventOperations(eventBus, { client, resourceUri: rUri });

  // ============================================================
  // MANUAL DETECTION STATE
  // ============================================================

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

  // ============================================================
  // AI DETECTION STATE
  // ============================================================

  const [detectingMotivation, setDetectingMotivation] = useState<Motivation | null>(null);
  const [detectionProgress, setDetectionProgress] = useState<DetectionProgress | null>(null);
  const detectionStreamRef = useRef<any>(null);

  // Auto-dismiss timeout ref
  const progressDismissTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleDetectionStart = useCallback(({ motivation }: { motivation: Motivation }) => {
    // Clear any pending auto-dismiss timeout
    if (progressDismissTimeoutRef.current) {
      clearTimeout(progressDismissTimeoutRef.current);
      progressDismissTimeoutRef.current = null;
    }
    setDetectingMotivation(motivation);
    setDetectionProgress(null); // Clear previous progress
  }, []);

  const handleDetectionProgress = useCallback((chunk: any) => {
    setDetectionProgress(chunk);
  }, []);

  const handleDetectionComplete = useCallback(({ motivation }: { motivation?: Motivation }) => {
    // Keep progress visible with final message - only clear detecting flag
    // Use callback form to get current state without closure
    setDetectingMotivation(current => {
      if (motivation === current) {
        return null;
      }
      return current;
    });

    // Auto-dismiss progress after 5 seconds to give user time to read final message
    if (progressDismissTimeoutRef.current) {
      clearTimeout(progressDismissTimeoutRef.current);
    }
    progressDismissTimeoutRef.current = setTimeout(() => {
      setDetectionProgress(null);
      progressDismissTimeoutRef.current = null;
    }, 5000);
  }, []);

  const handleDetectionFailed = useCallback(() => {
    // Clear timeout on failure
    if (progressDismissTimeoutRef.current) {
      clearTimeout(progressDismissTimeoutRef.current);
      progressDismissTimeoutRef.current = null;
    }
    setDetectingMotivation(null);
    setDetectionProgress(null);
  }, []);

  const handleDetectionDismissProgress = useCallback(() => {
    // Manual dismiss - clear timeout and progress immediately
    if (progressDismissTimeoutRef.current) {
      clearTimeout(progressDismissTimeoutRef.current);
      progressDismissTimeoutRef.current = null;
    }
    setDetectionProgress(null);
  }, []);

  // ============================================================
  // SUBSCRIPTIONS
  // ============================================================

  useEventSubscriptions({
    // Manual detection
    'annotation:requested': handleAnnotationRequested,
    'selection:comment-requested': handleCommentRequested,
    'selection:tag-requested': handleTagRequested,
    'selection:assessment-requested': handleAssessmentRequested,
    'selection:reference-requested': handleReferenceRequested,
    'annotation:cancel-pending': handleAnnotationCancelPending,
    'annotation:hover': handleAnnotationHover,
    'annotation:click': handleAnnotationClick,
    // AI detection
    'detection:start': handleDetectionStart,
    'detection:progress': handleDetectionProgress,
    'detection:complete': handleDetectionComplete,
    'detection:failed': handleDetectionFailed,
    'detection:dismiss-progress': handleDetectionDismissProgress,
  });

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (progressDismissTimeoutRef.current) {
        clearTimeout(progressDismissTimeoutRef.current);
      }
    };
  }, []);

  return {
    pendingAnnotation,
    hoveredAnnotationId,
    detectingMotivation,
    detectionProgress,
    detectionStreamRef,
  };
}
