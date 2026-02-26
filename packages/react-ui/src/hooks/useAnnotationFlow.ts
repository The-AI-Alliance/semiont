/**
 * useAnnotationFlow - Annotation state management hook
 *
 * Manages all annotation workflows (manual and AI-driven):
 * - Pending annotation state (user selected text, waiting for confirmation)
 * - Selection events → pending annotation conversion
 * - Annotation request routing to appropriate panel
 * - Tracking currently assisting motivation (AI-assisted annotation)
 * - Annotation progress updates from SSE
 * - Assisted annotation lifecycle (start, progress, complete, failed)
 * - Auto-dismiss progress after completion (5 seconds)
 * - Manual dismiss via progress-dismiss event
 * - Annotation create/delete API calls
 * - AI-assisted annotation SSE streams (all 5 motivation types)
 *
 * Covers both forms: a human selecting text is manual annotation;
 * AI-driven SSE streams are assisted annotation. Same concept, same hook.
 *
 * Follows react-rxjs-guide.md Layer 2 pattern: Hook bridge that
 * subscribes to events and pushes values into React state.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import type { Motivation, ResourceUri, Selector, components, ResourceEvent } from '@semiont/core';
import { resourceAnnotationUri, accessToken, entityType } from '@semiont/core';
import { uriToAnnotationIdOrPassthrough } from '@semiont/core';
import { useEventBus } from '../contexts/EventBusContext';
import type { EventMap } from '@semiont/core';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
import type { AnnotationProgress } from '@semiont/core';
import { useToast } from '../components/Toast';

type SelectionData = EventMap['annotate:select-comment'];

/** Helper to convert string | null to AccessToken | undefined */
function toAccessToken(token: string | null) {
  return token ? accessToken(token) : undefined;
}

// Unified pending annotation type
interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

export interface AnnotationFlowState {
  // Manual annotation state
  pendingAnnotation: PendingAnnotation | null;
  // AI-assisted annotation state
  assistingMotivation: Motivation | null;
  progress: AnnotationProgress | null;
  assistStreamRef: React.MutableRefObject<AbortController | null>;
}

/**
 * Hook for annotation flow (manual and AI-driven)
 *
 * @param rUri - Resource URI being annotated
 * @emits attend:panel-open - Open the annotations panel when annotation is requested
 * @emits annotate:created - Annotation successfully created
 * @emits annotate:create-failed - Annotation creation failed
 * @emits annotate:deleted - Annotation successfully deleted
 * @emits annotate:delete-failed - Annotation deletion failed
 * @emits annotate:progress - Progress update from SSE stream
 * @emits annotate:assist-finished - SSE assist completed
 * @emits annotate:assist-failed - SSE assist failed
 * @emits annotate:assist-cancelled - SSE assist cancelled
 * @subscribes annotate:requested - User requested a new annotation
 * @subscribes annotate:create - Create annotation via API
 * @subscribes annotate:delete - Delete annotation via API
 * @subscribes annotate:select-comment - User selected text for a comment
 * @subscribes annotate:select-tag - User selected text for a tag
 * @subscribes annotate:select-assessment - User selected text for an assessment
 * @subscribes annotate:select-reference - User selected text for a reference
 * @subscribes annotate:cancel-pending - Cancel pending annotation creation
 * @subscribes annotate:assist-request - Trigger AI-assisted annotation SSE stream
 * @subscribes job:cancel-requested - Cancels in-flight assist stream (assist half only)
 * @subscribes annotate:progress - Progress update during assist
 * @subscribes annotate:assist-finished - Assist completed successfully
 * @subscribes annotate:assist-failed - Error during assist
 * @subscribes annotate:progress-dismiss - Manually dismiss progress display
 * @returns Annotation flow state
 */
export function useAnnotationFlow(rUri: ResourceUri): AnnotationFlowState {
  const eventBus = useEventBus();
  const client = useApiClient();
  const token = useAuthToken();
  const { showSuccess, showError, showInfo } = useToast();

  // Keep latest client/rUri/token available inside useEffect handlers without re-subscribing
  const clientRef = useRef(client);
  const rUriRef = useRef(rUri);
  const tokenRef = useRef(token);
  useEffect(() => { clientRef.current = client; });
  useEffect(() => { rUriRef.current = rUri; });
  useEffect(() => { tokenRef.current = token; });

  // ============================================================
  // MANUAL ANNOTATION STATE
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
    eventBus.get('attend:panel-open').next({ panel: MOTIVATION_TO_TAB[pending.motivation] || 'annotations' });
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
  // AI-ASSISTED ANNOTATION STATE
  // ============================================================

  const [assistingMotivation, setAssistingMotivation] = useState<Motivation | null>(null);
  const [progress, setProgress] = useState<AnnotationProgress | null>(null);
  const assistStreamRef = useRef<AbortController | null>(null);

  // Auto-dismiss timeout ref
  const progressDismissTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleAnnotationProgress = useCallback((chunk: AnnotationProgress) => {
    setProgress(chunk);
  }, []);

  const handleAnnotationComplete = useCallback((event: EventMap['annotate:assist-finished']) => {
    // Only clear if the completion event's motivation matches the current one
    setAssistingMotivation(prev => {
      if (!event.motivation || event.motivation !== prev) return prev;
      return null;
    });

    // Show success notification
    showSuccess('Annotation complete');

    // Auto-dismiss progress after 5 seconds to give user time to read final message
    if (progressDismissTimeoutRef.current) {
      clearTimeout(progressDismissTimeoutRef.current);
    }
    progressDismissTimeoutRef.current = setTimeout(() => {
      setProgress(null);
      progressDismissTimeoutRef.current = null;
    }, 5000);
  }, [showSuccess]);

  const handleAnnotationFailed = useCallback((event: Extract<ResourceEvent, { type: 'job.failed' }>) => {
    // Clear timeout on failure
    if (progressDismissTimeoutRef.current) {
      clearTimeout(progressDismissTimeoutRef.current);
      progressDismissTimeoutRef.current = null;
    }
    setAssistingMotivation(null);
    setProgress(null);

    // Show error notification
    const errorMessage = event.payload.error || 'Annotation failed';
    showError(errorMessage);
  }, [showError]);

  const handleProgressDismiss = useCallback(() => {
    // Manual dismiss - clear timeout and progress immediately
    if (progressDismissTimeoutRef.current) {
      clearTimeout(progressDismissTimeoutRef.current);
      progressDismissTimeoutRef.current = null;
    }
    setProgress(null);
  }, []);

  // ============================================================
  // ANNOTATION + ASSIST API OPERATIONS (useEffect-based, ref-closed)
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
          setPendingAnnotation(null);
          eventBus.get('annotate:created').next({ annotation: result.annotation });
        }
      } catch (error) {
        console.error('Failed to create annotation:', error);
        eventBus.get('annotate:create-failed').next({ error: error as Error });
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

        eventBus.get('annotate:deleted').next({ annotationId: event.annotationId });
      } catch (error) {
        console.error('Failed to delete annotation:', error);
        eventBus.get('annotate:delete-failed').next({ error: error as Error });
      }
    };

    /**
     * Handle assist start - AI-driven SSE stream
     * Emitted by: AssistSection, TaggingPanel, ReferencesPanel
     */
    const handleAssistStart = async (event: {
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
      try {
        // Cancel any existing assist
        if (assistStreamRef.current) {
          assistStreamRef.current.abort();
        }
        assistStreamRef.current = new AbortController();

        // Update UI state
        if (progressDismissTimeoutRef.current) {
          clearTimeout(progressDismissTimeoutRef.current);
          progressDismissTimeoutRef.current = null;
        }
        setAssistingMotivation(event.motivation);
        setProgress(null);

        const sseOptions = { auth: toAccessToken(tokenRef.current), eventBus };

        if (event.motivation === 'tagging') {
          const { schemaId, categories } = event.options;
          if (!schemaId || !categories || categories.length === 0) {
            throw new Error('Tag assist requires schemaId and categories');
          }
          currentClient.sse.annotateTags(currentRUri, { schemaId, categories }, sseOptions);
          // Events auto-emit to EventBus: annotate:progress, annotate:assist-finished, annotate:assist-failed
        } else if (event.motivation === 'linking') {
          const { entityTypes, includeDescriptiveReferences } = event.options;
          if (!entityTypes || entityTypes.length === 0) {
            throw new Error('Reference assist requires entityTypes');
          }
          currentClient.sse.annotateReferences(currentRUri, {
            entityTypes: entityTypes.map(et => entityType(et)),
            includeDescriptiveReferences: includeDescriptiveReferences || false,
          }, sseOptions);
          // Events auto-emit to EventBus: annotate:progress, annotate:assist-finished, annotate:assist-failed
        } else if (event.motivation === 'highlighting') {
          currentClient.sse.annotateHighlights(currentRUri, {
            instructions: event.options.instructions,
            density: event.options.density,
          }, sseOptions);
          // Events auto-emit to EventBus: annotate:progress, annotate:assist-finished, annotate:assist-failed
        } else if (event.motivation === 'assessing') {
          currentClient.sse.annotateAssessments(currentRUri, {
            instructions: event.options.instructions,
            tone: event.options.tone as 'analytical' | 'critical' | 'balanced' | 'constructive' | undefined,
            density: event.options.density,
          }, sseOptions);
          // Events auto-emit to EventBus: annotate:progress, annotate:assist-finished, annotate:assist-failed
        } else if (event.motivation === 'commenting') {
          currentClient.sse.annotateComments(currentRUri, {
            instructions: event.options.instructions,
            tone: event.options.tone as 'scholarly' | 'explanatory' | 'conversational' | 'technical' | undefined,
            density: event.options.density,
          }, sseOptions);
          // Events auto-emit to EventBus: annotate:progress, annotate:assist-finished, annotate:assist-failed
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          eventBus.get('annotate:assist-cancelled').next(undefined);
        } else {
          console.error('Annotation assist failed:', error);
          setAssistingMotivation(null);
          setProgress(null);
        }
      }
    };

    /**
     * Handle job cancellation (annotation half)
     * Emitted by: AnnotateReferencesProgressWidget
     */
    const handleJobCancelRequested = (event: { jobType: 'annotation' | 'generation' }) => {
      if (event.jobType === 'annotation') {
        assistStreamRef.current?.abort();
        assistStreamRef.current = null;
      }
    };

    const subscription1 = eventBus.get('annotate:create').subscribe(handleAnnotationCreate);
    const subscription2 = eventBus.get('annotate:delete').subscribe(handleAnnotationDelete);
    const subscription3 = eventBus.get('annotate:assist-request').subscribe(handleAssistStart);
    const subscription4 = eventBus.get('job:cancel-requested').subscribe(handleJobCancelRequested);

    return () => {
      subscription1.unsubscribe();
      subscription2.unsubscribe();
      subscription3.unsubscribe();
      subscription4.unsubscribe();
      assistStreamRef.current?.abort();
    };
  }, [eventBus]); // eventBus is stable singleton; client/rUri/token accessed via refs

  // ============================================================
  // SUBSCRIPTIONS (state-updating handlers via useEventSubscriptions)
  // ============================================================

  useEventSubscriptions({
    // Manual annotation
    'annotate:requested': handleAnnotationRequested,
    'annotate:select-comment': handleCommentRequested,
    'annotate:select-tag': handleTagRequested,
    'annotate:select-assessment': handleAssessmentRequested,
    'annotate:select-reference': handleReferenceRequested,
    'annotate:cancel-pending': handleAnnotationCancelPending,
    // AI-assisted annotation state updates
    'annotate:progress': handleAnnotationProgress,
    'annotate:assist-finished': handleAnnotationComplete,
    'annotate:assist-failed': handleAnnotationFailed,
    'annotate:progress-dismiss': handleProgressDismiss,
    'annotate:assist-cancelled': () => showInfo('Annotation cancelled'),
    // CRUD error notifications
    'annotate:create-failed': ({ error }) => showError(`Failed to create annotation: ${error.message}`),
    'annotate:delete-failed': ({ error }) => showError(`Failed to delete annotation: ${error.message}`),
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
    assistingMotivation,
    progress,
    assistStreamRef,
  };
}
