/**
 * useYieldFlow - Document generation flow hook
 *
 * Activates yield orchestration by delegating to client.flows.yield().
 * Manages generation progress state (React-specific) via EventBus subscriptions.
 *
 * @subscribes yield:request - Triggers SSE call to yieldResource
 * @subscribes job:cancel-requested - Cancels in-flight generation stream
 * @subscribes yield:progress, yield:finished, yield:failed
 * @returns Generation flow state
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { GatheredContext, YieldProgress } from '@semiont/core';
import { annotationId as makeAnnotationId, resourceId as makeResourceId, accessToken } from '@semiont/core';
import type { AnnotationId } from '@semiont/core';

import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useEventBus } from '../contexts/EventBusContext';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
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
  const eventBus = useEventBus();
  const client = useApiClient();
  const token = useAuthToken();
  const { showSuccess, showError } = useToast();

  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; });

  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setYieldProgress] = useState<YieldProgress | null>(null);

  // Activate flow engine subscription
  useEffect(() => {
    const sub = client.flows.yield(makeResourceId(resourceId), () =>
      tokenRef.current ? accessToken(tokenRef.current) : undefined
    );
    return () => sub.unsubscribe();
  }, [resourceId, client]);

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
    eventBus.get('yield:request').next({
      annotationId: makeAnnotationId(referenceId),
      resourceId: makeResourceId(resourceId),
      options: { ...options, language: options.language || locale },
    });
  }, [resourceId, clearNewAnnotationId, locale]);

  const clearProgress = useCallback(() => { setYieldProgress(null); }, []);

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
    'yield:failed': ({ error }: { error: Error }) => {
      setYieldProgress(null);
      setIsGenerating(false);
      showError(`Resource generation failed: ${error.message}`);
    },
  });

  return { isGenerating, generationProgress, onGenerateDocument: handleGenerateDocument };
}
