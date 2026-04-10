/**
 * useYieldFlow - Document generation flow hook
 *
 * Triggers yield.fromAnnotation() on the namespace API.
 * Manages generation progress state (React-specific) via EventBus subscriptions
 * from the events-stream auto-router.
 */

import { useState, useCallback } from 'react';
import type { GatheredContext, YieldProgress } from '@semiont/core';
import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';
import type { AnnotationId } from '@semiont/core';

import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useApiClient } from '../contexts/ApiClientContext';
import { useToast } from '../components/Toast';

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

export function useYieldFlow(
  locale: string,
  resourceId: string,
  clearNewAnnotationId: (annotationId: AnnotationId) => void
): YieldFlowState {
  const client = useApiClient();
  const { showSuccess, showError } = useToast();

  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setYieldProgress] = useState<YieldProgress | null>(null);

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
    clearNewAnnotationId(makeAnnotationId(referenceId));

    // Subscribe to the Observable returned by yield.fromAnnotation()
    // Progress, completion, and failure arrive via the Observable
    // (which internally filters EventBus events by annotationId).
    const sub = client.yield.fromAnnotation(
      makeResourceId(resourceId),
      makeAnnotationId(referenceId),
      { ...options, language: options.language || locale },
    ).subscribe({
      next: (chunk) => {
        setYieldProgress(chunk);
        setIsGenerating(true);
      },
      complete: () => {
        // Observable completes on yield:finished — progress was set by last next()
      },
      error: (error) => {
        setYieldProgress(null);
        setIsGenerating(false);
        const msg = error instanceof Error ? error.message : 'Generation failed';
        showError(`Resource generation failed: ${msg}`);
      },
    });

    // No cleanup needed — Observable completes naturally on yield:finished/failed
    return sub;
  }, [resourceId, clearNewAnnotationId, locale, client, showError]);

  const clearProgress = useCallback(() => { setYieldProgress(null); }, []);

  // EventBus subscriptions for events-stream events (also handles cross-tab events)
  useEventSubscriptions({
    'yield:progress': (chunk: YieldProgress) => {
      setYieldProgress(chunk);
      setIsGenerating(true);
    },
    'yield:finished': (progress: YieldProgress) => {
      setYieldProgress(progress);
      setIsGenerating(false);
      showSuccess(progress.resourceName
        ? `Resource "${progress.resourceName}" created successfully!`
        : 'Resource created successfully!');
      setTimeout(() => clearProgress(), 2000);
    },
    'yield:failed': ({ error, message }) => {
      setYieldProgress(null);
      setIsGenerating(false);
      const msg = message || error || 'Generation failed';
      showError(`Resource generation failed: ${msg}`);
    },
  });

  return { isGenerating, generationProgress, onGenerateDocument: handleGenerateDocument };
}
