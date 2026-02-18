/**
 * useDetectionFlow - Detection state management hook
 *
 * Manages all annotation detection (manual and AI-driven):
 * - Pending annotation state (user selected text, waiting for confirmation)
 * - Selection events → pending annotation conversion
 * - Annotation request routing to appropriate panel
 * - Tracking currently detecting motivation (AI-driven detection)
 * - Detection progress updates from SSE
 * - Detection lifecycle (start, progress, complete, failed)
 * - Auto-dismiss progress after completion (5 seconds)
 * - Manual dismiss via detection:dismiss-progress event
 * - Annotation create/delete API calls
 * - AI detection SSE streams (all 5 motivation types)
 *
 * "Detection" covers both forms: a human selecting text is manual detection;
 * AI-driven SSE streams are automated detection. Same concept, same hook.
 *
 * Follows react-rxjs-guide.md Layer 2 pattern: Hook bridge that
 * subscribes to events and pushes values into React state.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import type { Motivation, ResourceUri, Selector, components } from '@semiont/api-client';
import { resourceAnnotationUri, accessToken, entityType } from '@semiont/api-client';
import { uriToAnnotationIdOrPassthrough } from '@semiont/core';
import { useEventBus } from '../contexts/EventBusContext';
import type { EventMap } from '../contexts/EventBusContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
import type { DetectionProgress } from '../types/progress';

type SelectionData = EventMap['selection:comment-requested'];

/** Helper to convert string | null to AccessToken | undefined */
function toAccessToken(token: string | null) {
  return token ? accessToken(token) : undefined;
}

// Unified pending annotation type
interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

export interface DetectionFlowState {
  // Manual detection state
  pendingAnnotation: PendingAnnotation | null;
  // AI detection state
  detectingMotivation: Motivation | null;
  detectionProgress: DetectionProgress | null;
  detectionStreamRef: React.MutableRefObject<AbortController | null>;
}

/**
 * Hook for annotation detection flow (manual and AI-driven)
 *
 * @param rUri - Resource URI being detected
 * @emits panel:open - Open the annotations panel when annotation is requested
 * @emits annotation:created - Annotation successfully created
 * @emits annotation:create-failed - Annotation creation failed
 * @emits annotation:deleted - Annotation successfully deleted
 * @emits annotation:delete-failed - Annotation deletion failed
 * @emits detection:progress - Progress update from SSE stream
 * @emits detection:complete - SSE detection completed
 * @emits detection:failed - SSE detection failed
 * @emits detection:cancelled - SSE detection cancelled
 * @subscribes annotation:requested - User requested a new annotation
 * @subscribes annotation:create - Create annotation via API
 * @subscribes annotation:delete - Delete annotation via API
 * @subscribes selection:comment-requested - User selected text for a comment
 * @subscribes selection:tag-requested - User selected text for a tag
 * @subscribes selection:assessment-requested - User selected text for an assessment
 * @subscribes selection:reference-requested - User selected text for a reference
 * @subscribes annotation:cancel-pending - Cancel pending annotation creation
 * @subscribes detection:start - Trigger AI detection SSE stream
 * @subscribes job:cancel-requested - Cancels in-flight detection stream (detection half only)
 * @subscribes detection:progress - Progress update during detection
 * @subscribes detection:complete - Detection completed successfully
 * @subscribes detection:failed - Error during detection
 * @subscribes detection:dismiss-progress - Manually dismiss progress display
 * @returns Detection state
 */
export function useDetectionFlow(rUri: ResourceUri): DetectionFlowState {
  const eventBus = useEventBus();
  const client = useApiClient();
  const token = useAuthToken();

  // Keep latest client/rUri/token available inside useEffect handlers without re-subscribing
  const clientRef = useRef(client);
  const rUriRef = useRef(rUri);
  const tokenRef = useRef(token);
  useEffect(() => { clientRef.current = client; });
  useEffect(() => { rUriRef.current = rUri; });
  useEffect(() => { tokenRef.current = token; });

  // ============================================================
  // MANUAL DETECTION STATE
  // ============================================================

  const [pendingAnnotation, setPendingAnnotation] = useState<PendingAnnotation | null>(null);

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
  const selectionToSelector = useCallback((selection: SelectionData): Selector | Selector[] => {
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
      ...(selection.prefix && { prefix: selection.prefix }),
      ...(selection.suffix && { suffix: selection.suffix })
    };
  }, []);

  const handleCommentRequested = useCallback((selection: SelectionData) => {
    handleAnnotationRequested({ selector: selectionToSelector(selection), motivation: 'commenting' });
  }, [handleAnnotationRequested, selectionToSelector]);

  const handleTagRequested = useCallback((selection: SelectionData) => {
    handleAnnotationRequested({ selector: selectionToSelector(selection), motivation: 'tagging' });
  }, [handleAnnotationRequested, selectionToSelector]);

  const handleAssessmentRequested = useCallback((selection: SelectionData) => {
    handleAnnotationRequested({ selector: selectionToSelector(selection), motivation: 'assessing' });
  }, [handleAnnotationRequested, selectionToSelector]);

  const handleReferenceRequested = useCallback((selection: SelectionData) => {
    handleAnnotationRequested({ selector: selectionToSelector(selection), motivation: 'linking' });
  }, [handleAnnotationRequested, selectionToSelector]);

  const handleAnnotationCancelPending = useCallback(() => {
    setPendingAnnotation(null);
  }, []);

  // ============================================================
  // AI DETECTION STATE
  // ============================================================

  const [detectingMotivation, setDetectingMotivation] = useState<Motivation | null>(null);
  const [detectionProgress, setDetectionProgress] = useState<DetectionProgress | null>(null);
  const detectionStreamRef = useRef<AbortController | null>(null);

  // Auto-dismiss timeout ref
  const progressDismissTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleDetectionProgress = useCallback((chunk: DetectionProgress) => {
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
  // ANNOTATION + DETECTION API OPERATIONS (useEffect-based, ref-closed)
  // ============================================================

  useEffect(() => {
    /**
     * Handle annotation creation
     * Emitted by: HighlightPanel, AssessmentPanel, CommentsPanel, TaggingPanel, ReferencesPanel
     */
    const handleAnnotationCreate = async (event: {
      motivation: Motivation;
      selector: Selector | Selector[];
      body: components['schemas']['AnnotationBody'][];
    }) => {
      const currentClient = clientRef.current;
      const currentRUri = rUriRef.current;
      if (!currentClient || !currentRUri) return;

      try {
        const result = await currentClient.createAnnotation(currentRUri, {
          motivation: event.motivation,
          target: {
            source: currentRUri,
            selector: event.selector,
          },
          body: event.body,
        }, { auth: toAccessToken(tokenRef.current) });

        if (result.annotation) {
          eventBus.emit('annotation:created', { annotation: result.annotation });
        }
      } catch (error) {
        console.error('Failed to create annotation:', error);
        eventBus.emit('annotation:create-failed', { error: error as Error });
      }
    };

    /**
     * Handle annotation deletion
     * Emitted by: delete buttons in annotation entries
     */
    const handleAnnotationDelete = async (event: { annotationId: string }) => {
      const currentClient = clientRef.current;
      const currentRUri = rUriRef.current;
      try {
        const annotationIdSegment = uriToAnnotationIdOrPassthrough(event.annotationId);
        const annotationUri = resourceAnnotationUri(`${currentRUri}/annotations/${annotationIdSegment}`);

        await currentClient.deleteAnnotation(annotationUri, { auth: toAccessToken(tokenRef.current) });

        eventBus.emit('annotation:deleted', { annotationId: event.annotationId });
      } catch (error) {
        console.error('Failed to delete annotation:', error);
        eventBus.emit('annotation:delete-failed', { error: error as Error });
      }
    };

    /**
     * Handle detection start - AI-driven SSE stream
     * Emitted by: DetectSection, TaggingPanel, ReferencesPanel
     */
    const handleDetectionStart = async (event: {
      motivation: Motivation;
      options: {
        instructions?: string;
        tone?: 'scholarly' | 'explanatory' | 'conversational' | 'technical' | 'analytical' | 'critical' | 'balanced' | 'constructive';
        density?: number;
        entityTypes?: string[];
        includeDescriptiveReferences?: boolean;
        schemaId?: string;
        categories?: string[];
      };
    }) => {
      const currentClient = clientRef.current;
      const currentRUri = rUriRef.current;
      console.log('[useDetectionFlow] handleDetectionStart called', { motivation: event.motivation, options: event.options });
      try {
        // Cancel any existing detection
        if (detectionStreamRef.current) {
          detectionStreamRef.current.abort();
        }
        detectionStreamRef.current = new AbortController();

        // Update UI state
        if (progressDismissTimeoutRef.current) {
          clearTimeout(progressDismissTimeoutRef.current);
          progressDismissTimeoutRef.current = null;
        }
        setDetectingMotivation(event.motivation);
        setDetectionProgress(null);

        const auth = { auth: toAccessToken(tokenRef.current) };

        if (event.motivation === 'tagging') {
          const { schemaId, categories } = event.options;
          if (!schemaId || !categories || categories.length === 0) {
            throw new Error('Tag detection requires schemaId and categories');
          }
          const stream = currentClient.sse.detectTags(currentRUri, { schemaId, categories }, auth);
          stream.onProgress((chunk) => { eventBus.emit('detection:progress', chunk); });
          stream.onComplete((finalChunk) => {
            eventBus.emit('detection:progress', finalChunk);
            eventBus.emit('detection:complete', { motivation: event.motivation });
          });
          stream.onError((error) => {
            console.error('Detection failed:', error);
            setDetectingMotivation(null);
            setDetectionProgress(null);
          });
        } else if (event.motivation === 'linking') {
          const { entityTypes, includeDescriptiveReferences } = event.options;
          if (!entityTypes || entityTypes.length === 0) {
            throw new Error('Reference detection requires entityTypes');
          }
          const stream = currentClient.sse.detectReferences(currentRUri, {
            entityTypes: entityTypes.map(et => entityType(et)),
            includeDescriptiveReferences: includeDescriptiveReferences || false,
          }, auth);
          stream.onProgress((chunk) => { eventBus.emit('detection:progress', chunk); });
          stream.onComplete((finalChunk) => {
            eventBus.emit('detection:progress', finalChunk);
            eventBus.emit('detection:complete', { motivation: event.motivation });
          });
          stream.onError((error) => {
            console.error('[useDetectionFlow] Detection failed:', error);
            setDetectingMotivation(null);
            setDetectionProgress(null);
          });
        } else if (event.motivation === 'highlighting') {
          const stream = currentClient.sse.detectHighlights(currentRUri, {
            instructions: event.options.instructions,
            density: event.options.density,
          }, auth);
          stream.onProgress((chunk) => { eventBus.emit('detection:progress', chunk); });
          stream.onComplete((finalChunk) => {
            eventBus.emit('detection:progress', finalChunk);
            eventBus.emit('detection:complete', { motivation: event.motivation });
          });
          stream.onError((error) => {
            console.error('Detection failed:', error);
            setDetectingMotivation(null);
            setDetectionProgress(null);
          });
        } else if (event.motivation === 'assessing') {
          const stream = currentClient.sse.detectAssessments(currentRUri, {
            instructions: event.options.instructions,
            tone: event.options.tone as 'analytical' | 'critical' | 'balanced' | 'constructive' | undefined,
            density: event.options.density,
          }, auth);
          stream.onProgress((chunk) => { eventBus.emit('detection:progress', chunk); });
          stream.onComplete((finalChunk) => {
            eventBus.emit('detection:progress', finalChunk);
            eventBus.emit('detection:complete', { motivation: event.motivation });
          });
          stream.onError((error) => {
            console.error('[useDetectionFlow] Assessment detection error:', error);
            setDetectingMotivation(null);
            setDetectionProgress(null);
          });
        } else if (event.motivation === 'commenting') {
          const stream = currentClient.sse.detectComments(currentRUri, {
            instructions: event.options.instructions,
            tone: event.options.tone as 'scholarly' | 'explanatory' | 'conversational' | 'technical' | undefined,
            density: event.options.density,
          }, auth);
          stream.onProgress((chunk) => { eventBus.emit('detection:progress', chunk); });
          stream.onComplete((finalChunk) => {
            eventBus.emit('detection:progress', finalChunk);
            eventBus.emit('detection:complete', { motivation: event.motivation });
          });
          stream.onError((error) => {
            console.error('Detection failed:', error);
            setDetectingMotivation(null);
            setDetectionProgress(null);
          });
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          eventBus.emit('detection:cancelled', undefined);
        } else {
          console.error('Detection failed:', error);
          setDetectingMotivation(null);
          setDetectionProgress(null);
        }
      }
    };

    /**
     * Handle job cancellation (detection half)
     * Emitted by: DetectionProgressWidget
     */
    const handleJobCancelRequested = (event: { jobType: 'detection' | 'generation' }) => {
      if (event.jobType === 'detection') {
        detectionStreamRef.current?.abort();
        detectionStreamRef.current = null;
      }
    };

    eventBus.on('annotation:create', handleAnnotationCreate);
    eventBus.on('annotation:delete', handleAnnotationDelete);
    eventBus.on('detection:start', handleDetectionStart);
    eventBus.on('job:cancel-requested', handleJobCancelRequested);

    return () => {
      eventBus.off('annotation:create', handleAnnotationCreate);
      eventBus.off('annotation:delete', handleAnnotationDelete);
      eventBus.off('detection:start', handleDetectionStart);
      eventBus.off('job:cancel-requested', handleJobCancelRequested);
      detectionStreamRef.current?.abort();
    };
  }, [eventBus]); // eventBus is stable singleton; client/rUri/token accessed via refs

  // ============================================================
  // SUBSCRIPTIONS (state-updating handlers via useEventSubscriptions)
  // ============================================================

  useEventSubscriptions({
    // Manual detection
    'annotation:requested': handleAnnotationRequested,
    'selection:comment-requested': handleCommentRequested,
    'selection:tag-requested': handleTagRequested,
    'selection:assessment-requested': handleAssessmentRequested,
    'selection:reference-requested': handleReferenceRequested,
    'annotation:cancel-pending': handleAnnotationCancelPending,
    // AI detection state updates
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
    detectingMotivation,
    detectionProgress,
    detectionStreamRef,
  };
}
