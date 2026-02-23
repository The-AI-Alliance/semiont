/**
 * useGenerationFlow - Document generation flow hook
 *
 * Manages document generation state:
 * - Generation progress tracking
 * - Generation modal state
 * - Reference search modal state
 * - Generation completion/error handling
 *
 * Follows react-rxjs-guide.md Layer 2 pattern: Hook bridge that
 * subscribes to events and pushes values into React state.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { AnnotationUri, GenerationContext, GenerationProgress } from '@semiont/core';
import { annotationUri, accessToken } from '@semiont/core';

import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useEventBus } from '../contexts/EventBusContext';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';

/** Helper to convert string | null to AccessToken | undefined */
function toAccessToken(token: string | null) {
  return token ? accessToken(token) : undefined;
}

export interface GenerationFlowState {
  isGenerating: boolean;
  generationProgress: GenerationProgress | null;
  generationModalOpen: boolean;
  generationReferenceId: string | null;
  generationDefaultTitle: string;
  onGenerateDocument: (referenceId: string, options: {
    title: string;
    prompt?: string;
    language?: string;
    temperature?: number;
    maxTokens?: number;
    context?: GenerationContext;
  }) => void;
  onCloseGenerationModal: () => void;
}

/**
 * Hook for document generation flow
 *
 * @param locale - Current locale for language defaults
 * @param resourceId - Resource ID for generation
 * @param showSuccess - Success toast callback
 * @param showError - Error toast callback
 * @param clearNewAnnotationId - Clear animation callback
 * @emits generate:request - Start document generation (consumed internally by this hook)
 * @emits generate:progress - SSE progress chunk from generation stream
 * @emits generate:finished - Generation completed successfully
 * @emits generate:failed - Error during generation
 * @subscribes generate:request - Triggers SSE call to generateResourceFromAnnotation
 * @subscribes job:cancel-requested - Cancels in-flight generation stream
 * @subscribes reference:create-manual - Navigates to compose page for new document reference
 * @subscribes generation:modal-open - Open the generation config modal; triggers context:retrieval-requested
 * @subscribes generate:finished - Generation completed successfully
 * @subscribes generate:failed - Error during generation
 * @returns Generation flow state
 */
export function useGenerationFlow(
  locale: string,
  resourceId: string,
  showSuccess: (message: string) => void,
  showError: (message: string) => void,
  clearNewAnnotationId: (annotationId: AnnotationUri) => void
): GenerationFlowState {
  const eventBus = useEventBus();
  const client = useApiClient();
  const token = useAuthToken();

  // Keep latest client/token accessible inside useEffect without re-subscribing
  const clientRef = useRef(client);
  const tokenRef = useRef(token);
  useEffect(() => { clientRef.current = client; });
  useEffect(() => { tokenRef.current = token; });

  // SSE stream ref for generation cancellation
  const generationStreamRef = useRef<AbortController | null>(null);

  // Generation progress state (inlined from former useGenerationProgress)
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress | null>(null);

  const handleProgressEvent = useCallback((chunk: GenerationProgress) => {
    setGenerationProgress(chunk);
    setIsGenerating(true);
  }, []);

  const clearProgress = useCallback(() => {
    setGenerationProgress(null);
  }, []);

  // Modal state
  const [generationModalOpen, setGenerationModalOpen] = useState(false);
  const [generationReferenceId, setGenerationReferenceId] = useState<string | null>(null);
  const [generationDefaultTitle, setGenerationDefaultTitle] = useState('');

  // Handle document generation
  const handleGenerateDocument = useCallback((
    referenceId: string,
    options: {
      title: string;
      prompt?: string;
      language?: string;
      temperature?: number;
      maxTokens?: number;
      context?: GenerationContext;
    }
  ) => {
    // Only open modal if this is the initial click (no context provided)
    if (!options.context) {
      setGenerationReferenceId(referenceId);
      setGenerationDefaultTitle(options.title);
      setGenerationModalOpen(true);
      return;
    }

    // Modal submitted with full options - emit event for handleGenerationStart
    // Clear CSS sparkle animation if reference was recently created
    clearNewAnnotationId(annotationUri(referenceId));

    // Use full resource URI (W3C Web Annotation spec requires URIs)
    const resourceUriStr = `resource://${resourceId}`;

    // Emit generate:request event instead of calling SSE directly
    eventBus.get('generate:request').next({
      annotationUri: referenceId,
      resourceUri: resourceUriStr,
      options: {
        ...options,
        // Use language from modal if provided, otherwise fall back to current locale
        language: options.language || locale,
        context: options.context // Now guaranteed to exist
      }
    });
  }, [resourceId, clearNewAnnotationId, locale]); // eventBus is stable singleton - never in deps

  const handleCloseGenerationModal = useCallback(() => {
    setGenerationModalOpen(false);
  }, []);

  const handleGenerationModalOpen = useCallback(({ annotationUri: annUri, resourceUri, defaultTitle }: {
    annotationUri: string;
    resourceUri: string;
    defaultTitle: string;
  }) => {
    setGenerationReferenceId(annUri);
    setGenerationDefaultTitle(defaultTitle);
    setGenerationModalOpen(true);
    // Trigger context retrieval in parallel with modal open
    eventBus.get('context:retrieval-requested').next({ annotationUri: annUri, resourceUri });
  }, []);

  const handleGenerationComplete = useCallback((progress: GenerationProgress) => {
    // Update progress state to final value and mark done
    setGenerationProgress(progress);
    setIsGenerating(false);

    // Show success notification
    if (progress.resourceName) {
      showSuccess(`Resource "${progress.resourceName}" created successfully!`);
    } else {
      showSuccess('Resource created successfully!');
    }

    // No cache invalidation needed - useResourceEvents receives annotation.body.updated
    // event via SSE and optimistically updates the specific annotation in React Query cache

    // Clear progress widget after a delay to show completion state
    setTimeout(() => clearProgress(), 2000);
  }, [showSuccess, clearProgress]);

  const handleGenerationFailed = useCallback(({ error }: { error: Error }) => {
    // Update progress state and mark done
    setGenerationProgress(null);
    setIsGenerating(false);

    showError(`Resource generation failed: ${error.message}`);
  }, [showError]);

  // ============================================================
  // GENERATION API OPERATIONS (useEffect-based, ref-closed)
  // ============================================================

  useEffect(() => {
    /**
     * Handle document generation start - SSE stream
     * Emitted by: handleGenerateDocument (when user submits generation modal with full options)
     */
    const handleGenerationStart = async (event: {
      annotationUri: string;
      resourceUri: string;
      options: {
        title: string;
        prompt?: string;
        language?: string;
        temperature?: number;
        maxTokens?: number;
        context: any;
      };
    }) => {
      try {
        generationStreamRef.current?.abort();
        generationStreamRef.current = new AbortController();

        const sseOptions = { auth: toAccessToken(tokenRef.current), eventBus };

        clientRef.current.sse.generateResourceFromAnnotation(
          event.resourceUri as any,
          event.annotationUri as any,
          event.options as any,
          sseOptions
        );
        // Events auto-emit to EventBus: generate:progress, generate:finished, generate:failed
      } catch (error) {
        if ((error as any).name !== 'AbortError') {
          console.error('[useGenerationFlow] Generation failed:', error);
          eventBus.get('generate:failed').next({ error: error as Error });
        }
      }
    };

    /**
     * Handle job cancellation (generation half)
     * Emitted by: DetectionProgressWidget
     */
    const handleJobCancelRequested = (event: { jobType: 'detection' | 'generation' }) => {
      if (event.jobType === 'generation') {
        generationStreamRef.current?.abort();
        generationStreamRef.current = null;
      }
    };

    /**
     * Handle manual document creation for reference
     * Emitted by: ReferenceEntry (when user clicks "Create Document")
     * Navigates to the compose page with pre-filled params
     */
    const handleReferenceCreateManual = (event: {
      annotationUri: string;
      title: string;
      entityTypes: string[];
    }) => {
      const baseUrl = window.location.origin;
      const params = new URLSearchParams({
        annotationUri: event.annotationUri,
        sourceDocumentId: resourceId,
        name: event.title,
        entityTypes: event.entityTypes.join(','),
      });
      window.location.href = `${baseUrl}/know/compose?${params.toString()}`;
    };

    const subscription1 = eventBus.get('generate:request').subscribe(handleGenerationStart);
    const subscription2 = eventBus.get('job:cancel-requested').subscribe(handleJobCancelRequested);
    const subscription3 = eventBus.get('reference:create-manual').subscribe(handleReferenceCreateManual);

    return () => {
      subscription1.unsubscribe();
      subscription2.unsubscribe();
      subscription3.unsubscribe();
      generationStreamRef.current?.abort();
    };
  }, [eventBus, resourceId]); // eventBus is stable singleton; resourceId added for navigation handler

  // Subscribe to generation events
  useEventSubscriptions({
    'generate:progress': handleProgressEvent,
    'generate:finished': handleGenerationComplete,
    'generate:failed': handleGenerationFailed,
    'generation:modal-open': handleGenerationModalOpen,
  });

  return {
    isGenerating,
    generationProgress,
    generationModalOpen,
    generationReferenceId,
    generationDefaultTitle,
    onGenerateDocument: handleGenerateDocument,
    onCloseGenerationModal: handleCloseGenerationModal,
  };
}
