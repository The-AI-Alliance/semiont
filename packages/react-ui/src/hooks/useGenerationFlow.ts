/**
 * useGenerationFlow - Document generation flow hook
 *
 * Manages document generation state:
 * - Generation progress tracking (from useGenerationProgress hook)
 * - Generation modal state
 * - Reference search modal state
 * - Generation completion/error handling
 *
 * Follows react-rxjs-guide.md Layer 2 pattern: Hook bridge that
 * subscribes to events and pushes values into React state.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { GenerationContext, AnnotationUri } from '@semiont/api-client';
import { annotationUri, accessToken } from '@semiont/api-client';
import { useGenerationProgress } from './useGenerationProgress';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useEventBus } from '../contexts/EventBusContext';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';

/** Helper to convert string | null to AccessToken | undefined */
function toAccessToken(token: string | null) {
  return token ? accessToken(token) : undefined;
}

export interface GenerationFlowState {
  generationProgress: any | null;
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
 * @param cacheManager - Cache manager for invalidation
 * @param clearNewAnnotationId - Clear animation callback
 * @emits generation:start - Start document generation (consumed internally by this hook)
 * @emits generation:progress - SSE progress chunk from generation stream
 * @emits generation:complete - Generation completed successfully
 * @emits generation:failed - Error during generation
 * @subscribes generation:start - Triggers SSE call to generateResourceFromAnnotation
 * @subscribes job:cancel-requested - Cancels in-flight generation stream
 * @subscribes reference:create-manual - Navigates to compose page for new document reference
 * @subscribes generation:modal-open - Open the generation config modal; triggers context:retrieval-requested
 * @subscribes generation:complete - Generation completed successfully
 * @subscribes generation:failed - Error during generation
 * @returns Generation flow state
 */
export function useGenerationFlow(
  locale: string,
  resourceId: string,
  showSuccess: (message: string) => void,
  showError: (message: string) => void,
  cacheManager: any,
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

  // Generation progress state (from hook)
  const {
    progress: generationProgress,
    clearProgress
  } = useGenerationProgress();

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

    // Emit generation:start event instead of calling SSE directly
    eventBus.emit('generation:start', {
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
    eventBus.emit('context:retrieval-requested', { annotationUri: annUri, resourceUri });
  }, []);

  const handleGenerationComplete = useCallback(({ progress }: { annotationUri: string; progress: any }) => {
    // Show success notification
    if (progress.resourceName) {
      showSuccess(`Resource "${progress.resourceName}" created successfully!`);
    } else {
      showSuccess('Resource created successfully!');
    }

    // Refetch annotations to show the reference is now resolved
    if (cacheManager) {
      cacheManager.invalidate('annotations');
    }

    // Clear progress widget after a delay to show completion state
    setTimeout(() => clearProgress(), 2000);
  }, [showSuccess, cacheManager, clearProgress]);

  const handleGenerationFailed = useCallback(({ error }: { error: Error }) => {
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
      console.log('[useGenerationFlow] handleGenerationStart called', { annotationUri: event.annotationUri, options: event.options });
      try {
        generationStreamRef.current?.abort();
        generationStreamRef.current = new AbortController();

        const stream = clientRef.current.sse.generateResourceFromAnnotation(
          event.resourceUri as any,
          event.annotationUri as any,
          event.options as any,
          { auth: toAccessToken(tokenRef.current) }
        );

        stream.onProgress((chunk) => {
          console.log('[useGenerationFlow] Generation progress chunk received', chunk);
          eventBus.emit('generation:progress', chunk);
        });

        stream.onComplete((finalChunk) => {
          console.log('[useGenerationFlow] Generation complete with final chunk', finalChunk);
          eventBus.emit('generation:progress', finalChunk);
          eventBus.emit('generation:complete', {
            annotationUri: event.annotationUri,
            progress: finalChunk
          });
        });

        stream.onError((error) => {
          console.error('[useGenerationFlow] Generation failed:', error);
          eventBus.emit('generation:failed', { error: error as Error });
        });
      } catch (error) {
        if ((error as any).name === 'AbortError') {
          console.log('[useGenerationFlow] Generation cancelled');
        } else {
          console.error('[useGenerationFlow] Generation failed:', error);
          eventBus.emit('generation:failed', { error: error as Error });
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

    eventBus.on('generation:start', handleGenerationStart);
    eventBus.on('job:cancel-requested', handleJobCancelRequested);
    eventBus.on('reference:create-manual', handleReferenceCreateManual);

    return () => {
      eventBus.off('generation:start', handleGenerationStart);
      eventBus.off('job:cancel-requested', handleJobCancelRequested);
      eventBus.off('reference:create-manual', handleReferenceCreateManual);
      generationStreamRef.current?.abort();
    };
  }, [eventBus, resourceId]); // eventBus is stable singleton; resourceId added for navigation handler

  // Subscribe to generation events
  useEventSubscriptions({
    'generation:modal-open': handleGenerationModalOpen,
    'generation:complete': handleGenerationComplete,
    'generation:failed': handleGenerationFailed,
  });

  return {
    generationProgress,
    generationModalOpen,
    generationReferenceId,
    generationDefaultTitle,
    onGenerateDocument: handleGenerateDocument,
    onCloseGenerationModal: handleCloseGenerationModal,
  };
}
