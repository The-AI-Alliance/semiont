/**
 * useYieldFlow - Document generation flow hook
 *
 * Manages document generation state:
 * - Generation progress tracking
 * - SSE stream management
 * - Generation completion/error handling
 *
 * The wizard modal (ReferenceWizardModal) handles modal state and user
 * interaction. This hook handles the downstream SSE generation after
 * the wizard emits yield:request.
 *
 * Follows react-rxjs-guide.md Layer 2 pattern: Hook bridge that
 * subscribes to events and pushes values into React state.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { EventMap, GatheredContext, YieldProgress } from '@semiont/core';
import { annotationId as makeAnnotationId, resourceId as makeResourceId, accessToken } from '@semiont/core';
import type { AnnotationId } from '@semiont/core';

import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useEventBus } from '../contexts/EventBusContext';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
import { useToast } from '../components/Toast';

/** Helper to convert string | null to AccessToken | undefined */
function toAccessToken(token: string | null) {
  return token ? accessToken(token) : undefined;
}

export interface YieldFlowState {
  isGenerating: boolean;
  generationProgress: YieldProgress | null;
  onGenerateDocument: (referenceId: string, options: {
    title: string;
    storageUri: string;
    prompt?: string;
    language?: string;
    temperature?: number;
    maxTokens?: number;
    context: GatheredContext;
  }) => void;
}

/**
 * Hook for document generation flow
 *
 * @param locale - Current locale for language defaults
 * @param resourceId - Resource ID for generation
 * @param clearNewAnnotationId - Clear animation callback
 * @emits yield:request - Start document generation
 * @subscribes yield:request - Triggers SSE call to yieldResourceFromAnnotation
 * @subscribes job:cancel-requested - Cancels in-flight generation stream
 * @subscribes yield:progress - SSE progress chunks
 * @subscribes yield:finished - Generation completed successfully
 * @subscribes yield:failed - Error during generation
 * @returns Generation flow state
 */
export function useYieldFlow(
  locale: string,
  resourceId: string,
  clearNewAnnotationId: (annotationId: AnnotationId) => void
): YieldFlowState {
  const eventBus = useEventBus();
  const client = useApiClient();
  const token = useAuthToken();
  const { showSuccess, showError } = useToast();

  // Keep latest client/token accessible inside useEffect without re-subscribing
  const clientRef = useRef(client);
  const tokenRef = useRef(token);
  useEffect(() => { clientRef.current = client; });
  useEffect(() => { tokenRef.current = token; });

  // SSE stream ref for generation cancellation
  const generationStreamRef = useRef<AbortController | null>(null);

  // Generation progress state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setYieldProgress] = useState<YieldProgress | null>(null);

  const handleProgressEvent = useCallback((chunk: YieldProgress) => {
    setYieldProgress(chunk);
    setIsGenerating(true);
  }, []);

  const clearProgress = useCallback(() => {
    setYieldProgress(null);
  }, []);

  // Called by ReferenceWizardModal when user submits generation config
  const handleGenerateDocument = useCallback((
    referenceId: string,
    options: {
      title: string;
      storageUri: string;
      prompt?: string;
      language?: string;
      temperature?: number;
      maxTokens?: number;
      context: GatheredContext;
    }
  ) => {
    // Clear CSS sparkle animation if reference was recently created
    clearNewAnnotationId(makeAnnotationId(referenceId));

    // Emit yield:request event — SSE handler below picks it up
    eventBus.get('yield:request').next({
      annotationId: makeAnnotationId(referenceId),
      resourceId: makeResourceId(resourceId),
      options: {
        ...options,
        language: options.language || locale,
        context: options.context,
        storageUri: options.storageUri,
      }
    });
  }, [resourceId, clearNewAnnotationId, locale]); // eventBus is stable singleton

  const handleGenerationComplete = useCallback((progress: YieldProgress) => {
    setYieldProgress(progress);
    setIsGenerating(false);

    if (progress.resourceName) {
      showSuccess(`Resource "${progress.resourceName}" created successfully!`);
    } else {
      showSuccess('Resource created successfully!');
    }

    // Clear progress widget after a delay to show completion state
    setTimeout(() => clearProgress(), 2000);
  }, [showSuccess, clearProgress]);

  const handleGenerationFailed = useCallback(({ error }: { error: Error }) => {
    setYieldProgress(null);
    setIsGenerating(false);
    showError(`Resource generation failed: ${error.message}`);
  }, [showError]);

  // ============================================================
  // GENERATION API OPERATIONS (useEffect-based, ref-closed)
  // ============================================================

  useEffect(() => {
    /**
     * Handle document generation start - SSE stream
     * Emitted by: handleGenerateDocument (when wizard submits generation config)
     */
    const handleGenerationStart = async (event: EventMap['yield:request']) => {
      try {
        generationStreamRef.current?.abort();
        generationStreamRef.current = new AbortController();

        const sseOptions = { auth: toAccessToken(tokenRef.current), eventBus };

        clientRef.current.sse.yieldResourceFromAnnotation(
          event.resourceId,
          event.annotationId,
          event.options,
          sseOptions
        );
        // Events auto-emit to EventBus: yield:progress, yield:finished, yield:failed
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.error('[useYieldFlow] Generation failed:', error);
          eventBus.get('yield:failed').next({ error: error as Error });
        }
      }
    };

    /**
     * Handle job cancellation (generation half)
     * Emitted by: AnnotateReferencesProgressWidget
     */
    const handleJobCancelRequested = (event: { jobType: 'annotation' | 'generation' }) => {
      if (event.jobType === 'generation') {
        generationStreamRef.current?.abort();
        generationStreamRef.current = null;
      }
    };

    const subscription1 = eventBus.get('yield:request').subscribe(handleGenerationStart);
    const subscription2 = eventBus.get('job:cancel-requested').subscribe(handleJobCancelRequested);

    return () => {
      subscription1.unsubscribe();
      subscription2.unsubscribe();
      generationStreamRef.current?.abort();
    };
  }, [eventBus]);

  // Subscribe to generation events
  useEventSubscriptions({
    'yield:progress': handleProgressEvent,
    'yield:finished': handleGenerationComplete,
    'yield:failed': handleGenerationFailed,
  });

  return {
    isGenerating,
    generationProgress,
    onGenerateDocument: handleGenerateDocument,
  };
}
