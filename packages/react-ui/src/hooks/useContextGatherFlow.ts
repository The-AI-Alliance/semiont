/**
 * useContextGatherFlow - Context gather capability hook
 *
 * Activates gather orchestration for a resource by delegating to
 * client.flows.gatherContext(). Manages UI state (gatherContext, gatherLoading,
 * gatherError, gatherAnnotationId) via EventBus subscriptions — the
 * React-specific portion.
 *
 * @subscribes gather:requested - Triggers loading state
 * @subscribes gather:complete - Sets gathered context
 * @subscribes gather:failed - Sets error state
 * @returns Gather flow state
 */

import { useState, useEffect, useRef } from 'react';
import type { GatheredContext, ResourceId, AnnotationId } from '@semiont/core';
import { accessToken } from '@semiont/core';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
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
  const token = useAuthToken();
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; });

  const [gatherContext, setGatherContext] = useState<GatheredContext | null>(null);
  const [gatherLoading, setGatherLoading] = useState(false);
  const [gatherError, setGatherError] = useState<Error | null>(null);
  const [gatherAnnotationId, setGatherAnnotationId] = useState<AnnotationId | null>(null);

  // Activate flow engine subscription (SSE orchestration)
  useEffect(() => {
    const sub = client.flows.gatherContext(config.resourceId, () =>
      tokenRef.current ? accessToken(tokenRef.current) : undefined
    );
    return () => sub.unsubscribe();
  }, [config.resourceId, client]);

  useEventSubscriptions({
    'gather:requested': (event) => {
      setGatherLoading(true);
      setGatherError(null);
      setGatherContext(null);
      setGatherAnnotationId(event.annotationId);
    },
    'gather:complete': (event) => {
      setGatherContext(event.response.context ?? null);
      setGatherLoading(false);
    },
    'gather:failed': (event) => {
      setGatherError(new Error(event.message));
      setGatherLoading(false);
    },
  });

  return { gatherContext, gatherLoading, gatherError, gatherAnnotationId };
}
