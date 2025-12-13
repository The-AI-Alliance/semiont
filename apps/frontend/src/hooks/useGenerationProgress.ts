'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import type { AnnotationUri, ResourceUri, GenerationProgress as ApiGenerationProgress, SSEStream, GenerationContext } from '@semiont/api-client';
import { useApiClient } from '@/lib/api-hooks';

// Use API type directly (no extensions needed)
export type GenerationProgress = ApiGenerationProgress;

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
  const client = useApiClient();
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
    console.log('[useGenerationProgress] startGeneration called with:', {
      referenceId,
      resourceId,
      options,
      language: options?.language
    });

    // Close any existing stream
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }

    // Check if client is available
    if (!client) {
      onError?.('Authentication required');
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
        console.log('[useGenerationProgress] Received progress event:', apiProgress);
        setProgress(apiProgress);
        onProgress?.(apiProgress);
      });

      // Handle completion
      stream.onComplete((apiProgress) => {
        console.log('[useGenerationProgress] Processing completion event');
        setIsGenerating(false);
        // Keep progress visible to show completion state and link
        onComplete?.(apiProgress);
        streamRef.current = null;
      });

      // Handle errors
      stream.onError((error) => {
        console.error('[useGenerationProgress] Stream error:', error);
        setIsGenerating(false);
        setProgress(null); // Clear progress to hide widget
        onError?.(error.message || 'Generation failed');
        streamRef.current = null;
      });
    } catch (error) {
      console.error('[useGenerationProgress] Failed to start generation:', error);
      setIsGenerating(false);
      onError?.('Failed to start resource generation');
    }
  }, [client, onComplete, onError, onProgress]);

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