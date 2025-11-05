'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import type { AnnotationUri, ResourceUri } from '@semiont/api-client';

export interface GenerationProgress {
  status: 'started' | 'fetching' | 'generating' | 'creating' | 'complete' | 'error';
  referenceId: AnnotationUri;
  documentName?: string;
  resourceId?: ResourceUri;
  sourceResourceId?: string;
  percentage: number;
  message?: string;
}

interface UseGenerationProgressOptions {
  onComplete?: (progress: GenerationProgress) => void;
  onError?: (error: string) => void;
  onProgress?: (progress: GenerationProgress) => void;
}

export function useGenerationProgress({
  onComplete,
  onError,
  onProgress
}: UseGenerationProgressOptions) {
  const { data: session } = useSession();
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const startGeneration = useCallback(async (
    referenceId: AnnotationUri,
    resourceId: ResourceUri,
    options?: { prompt?: string; title?: string; language?: string }
  ) => {
    console.log('[useGenerationProgress] startGeneration called with:', {
      referenceId,
      resourceId,
      options,
      language: options?.language
    });

    // Close any existing connection
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Get auth token from session
    if (!session?.backendToken) {
      onError?.('Authentication required');
      return;
    }

    setIsGenerating(true);
    setProgress(null);

    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Build SSE URL by appending operation to the annotation URI
    const url = `${referenceId}/generate-resource-stream`;

    // Extract resource ID from ResourceUri for the request body
    const resourceIdSegment = resourceId.split('/').pop();
    if (!resourceIdSegment) {
      onError?.('Invalid resource URI');
      setIsGenerating(false);
      return;
    }

    const requestBody = { resourceId: resourceIdSegment, ...options };
    console.log('[useGenerationProgress] Sending request to:', url);
    console.log('[useGenerationProgress] Request body:', requestBody);

    try {
      await fetchEventSource(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.backendToken}`
        },
        body: JSON.stringify(requestBody),
        signal: abortController.signal,

        onmessage(ev) {
          console.log('[useGenerationProgress] Received SSE event:', ev.event, 'data:', ev.data);
          const data = JSON.parse(ev.data) as GenerationProgress;
          setProgress(data);
          onProgress?.(data);

          // Handle specific event types
          if (ev.event === 'generation-complete') {
            console.log('[useGenerationProgress] Processing completion event');
            setIsGenerating(false);
            // Keep progress visible to show completion state and link
            onComplete?.(data);
            abortController.abort(); // Close connection
            abortControllerRef.current = null;
          } else if (ev.event === 'generation-error') {
            setIsGenerating(false);
            // Keep progress visible to show error state
            onError?.(data.message || 'Generation failed');
            abortController.abort();
            abortControllerRef.current = null;
          }
        },

        onerror(err) {
          // If the error is due to abort, don't show error
          if (abortController.signal.aborted) {
            return;
          }

          console.error('SSE Connection error:', err);
          setIsGenerating(false);
          setProgress(null); // Clear progress to hide widget
          onError?.('Connection lost. Please try again.');
          throw err; // Throw to stop reconnection
        },

        openWhenHidden: true // Keep connection open when tab is in background
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        console.error('Failed to start generation:', error);
        setIsGenerating(false);
        onError?.('Failed to start resource generation');
      }
    }
  }, [onComplete, onError, onProgress, session]);

  const cancelGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsGenerating(false);
    setProgress(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const clearProgress = useCallback(() => {
    setProgress(null);
  }, []);

  return {
    isGenerating,
    progress,
    startGeneration,
    cancelGeneration,
    clearProgress
  };
}