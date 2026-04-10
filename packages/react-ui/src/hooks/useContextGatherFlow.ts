/**
 * useContextGatherFlow - Context gather capability hook
 *
 * Manages UI state for context gathering. The actual gather trigger
 * comes from components emitting gather:requested on the EventBus.
 * This hook bridges to client.gather.annotation() and manages the
 * React state (loading, context, error).
 */

import { useState } from 'react';
import type { GatheredContext, ResourceId, AnnotationId } from '@semiont/core';
import { annotationId } from '@semiont/core';
import { useApiClient } from '../contexts/ApiClientContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';

export interface ContextGatherFlowConfig {
  resourceId: ResourceId;
}

export interface ContextGatherFlowState {
  gatherContext: GatheredContext | null;
  gatherLoading: boolean;
  gatherError: Error | null;
  /** The annotationId for which context was most recently gathered */
  gatherAnnotationId: AnnotationId | null;
}

export function useContextGatherFlow(
  config: ContextGatherFlowConfig,
): ContextGatherFlowState {
  const client = useApiClient();

  const [gatherContext, setGatherContext] = useState<GatheredContext | null>(null);
  const [gatherLoading, setGatherLoading] = useState(false);
  const [gatherError, setGatherError] = useState<Error | null>(null);
  const [gatherAnnotationId, setGatherAnnotationId] = useState<AnnotationId | null>(null);

  // Bridge gather:requested EventBus events to client.gather.annotation()
  // and listen for completion/failure via EventBus (events-stream auto-routes)
  useEventSubscriptions({
    'gather:requested': (event) => {
      setGatherLoading(true);
      setGatherError(null);
      setGatherContext(null);
      setGatherAnnotationId(annotationId(event.annotationId));

      // Fire the gather via namespace API
      client.gather.annotation(
        annotationId(event.annotationId),
        config.resourceId,
        { contextWindow: event.options?.contextWindow ?? 2000 },
      ).subscribe({
        next: (progress) => {
          // Check if this is the completion event (has response.context)
          if ('response' in progress && progress.response) {
            setGatherContext((progress as { response: { context: GatheredContext } }).response.context ?? null);
            setGatherLoading(false);
          }
        },
        error: (error) => {
          setGatherError(error instanceof Error ? error : new Error(String(error)));
          setGatherLoading(false);
        },
        complete: () => {
          setGatherLoading(false);
        },
      });
      // Observable completes naturally — no need to track subscription
    },
  });

  return { gatherContext, gatherLoading, gatherError, gatherAnnotationId };
}
