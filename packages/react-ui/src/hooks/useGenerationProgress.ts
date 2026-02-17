'use client';

import { useState, useCallback } from 'react';
import type { GenerationProgress } from '../types/progress';
import { useEventSubscriptions } from '../contexts/useEventSubscription';

/**
 * Hook for managing generation progress tracking via events
 *
 * Subscribes to generation events from useEventOperations (Service Layer).
 * No direct SSE stream creation - follows three-layer architecture:
 * Service (useEventOperations) → Hook (this) → Component
 *
 * @subscribes generation:progress - Progress update during generation
 * @subscribes generation:complete - Generation completed successfully
 * @subscribes generation:failed - Error during generation
 */
export function useGenerationProgress() {
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);

  // Subscribe to generation events (from useEventOperations)
  useEventSubscriptions({
    'generation:progress': (chunk: GenerationProgress) => {
      setProgress(chunk);
      setIsGenerating(true);
    },
    'generation:complete': ({ progress: finalProgress }: { annotationUri: string; progress: GenerationProgress }) => {
      setProgress(finalProgress);
      setIsGenerating(false);
    },
    'generation:failed': ({ error }: { error: Error }) => {
      console.error('[useGenerationProgress] Generation failed:', error);
      setProgress(null);
      setIsGenerating(false);
    },
  });

  const clearProgress = useCallback(() => {
    setProgress(null);
  }, []);

  return {
    isGenerating,
    progress,
    clearProgress
  };
}
