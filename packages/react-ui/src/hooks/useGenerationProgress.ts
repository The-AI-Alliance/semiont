'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import type { AnnotationUri, ResourceUri, GenerationProgress as ApiGenerationProgress, SSEStream, GenerationContext } from '@semiont/api-client';
import { useApiClient } from '../contexts/ApiClientContext';
import { useEventBus } from '../contexts/EventBusContext';

// Use API type directly (no extensions needed)
export type GenerationProgress = ApiGenerationProgress;

/**
 * Hook for managing generation progress tracking with SSE streams
 *
 * @emits generation:error-event - Error during generation. Payload: { error: string }
 * @emits generation:progress-update - Progress update during generation. Payload: { progress: GenerationProgress }
 * @emits generation:complete-event - Generation completed successfully. Payload: { progress: GenerationProgress }
 */
export function useGenerationProgress() {
  const client = useApiClient();
  const eventBus = useEventBus();
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const streamRef = useRef<SSEStream<ApiGenerationProgress, ApiGenerationProgress> | null>(null);

  const startGeneration = useCallback(async (
    referenceId: AnnotationUri,
    resourceId: ResourceUri,
    options: {
      title?: string;
      prompt?: string;
      language?: string;
      context: GenerationContext;
      temperature?: number;
      maxTokens?: number;
    }
  ) => {
    // Close any existing stream
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }

    // Check if client is available
    if (!client) {
      eventBus.emit('generation:error-event', {
        error: 'Authentication required'
      });
      return;
    }

    setIsGenerating(true);
    setProgress(null);

    try {
      // Start SSE stream using api-client
      const stream = client.sse.generateResourceFromAnnotation(resourceId, referenceId, options);
      streamRef.current = stream;

      // Handle progress events
      stream.onProgress((apiProgress) => {
        setProgress(apiProgress);
        eventBus.emit('generation:progress-update', {
          progress: apiProgress
        });
      });

      // Handle completion
      stream.onComplete((apiProgress) => {
        setIsGenerating(false);
        // Keep progress visible to show completion state and link
        eventBus.emit('generation:complete-event', {
          progress: apiProgress
        });
        streamRef.current = null;
      });

      // Handle errors
      stream.onError((error) => {
        console.error('[useGenerationProgress] Stream error:', error);
        setIsGenerating(false);
        setProgress(null); // Clear progress to hide widget
        eventBus.emit('generation:error-event', {
          error: error.message || 'Generation failed'
        });
        streamRef.current = null;
      });
    } catch (error) {
      console.error('[useGenerationProgress] Failed to start generation:', error);
      setIsGenerating(false);
      eventBus.emit('generation:error-event', {
        error: 'Failed to start resource generation'
      });
    }
  }, [client]); // eventBus is a global singleton - never include in deps

  const cancelGeneration = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    setIsGenerating(false);
    setProgress(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.close();
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