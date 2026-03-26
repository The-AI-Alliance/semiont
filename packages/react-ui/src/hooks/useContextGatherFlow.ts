/**
 * useContextGatherFlow - Context gather capability hook
 *
 * Gather capability: given a reference annotation, fetch the surrounding
 * text context (before/selected/after) from the source document so it can
 * be gathered and used as grounding material for generation.
 *
 * This hook is the single owner of gather state. It is triggered by
 * gather:requested on the event bus, making the capability
 * accessible to both human UI flows and agents.
 *
 * @subscribes gather:requested - Fetch LLM context for an annotation
 * @emits gather:complete - Context successfully fetched
 * @emits gather:failed - Context fetch failed
 * @returns Gather state (context, loading, error, which annotation)
 */

import { useState, useEffect, useRef } from 'react';
import type { EventBus, EventMap, GatheredContext, ResourceId, AnnotationId } from '@semiont/core';
import { SemiontApiClient } from '@semiont/api-client';
import { accessToken } from '@semiont/core';
import { useAuthToken } from '../contexts/AuthTokenContext';


/** Helper to convert string | null to AccessToken | undefined */
function toAccessToken(token: string | null) {
  return token ? accessToken(token) : undefined;
}

export interface ContextGatherFlowConfig {
  client: SemiontApiClient;
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
  eventBus: EventBus,
  config: ContextGatherFlowConfig
): ContextGatherFlowState {
  const token = useAuthToken();

  const [gatherContext, setCorrelationContext] = useState<GatheredContext | null>(null);
  const [gatherLoading, setCorrelationLoading] = useState(false);
  const [gatherError, setCorrelationError] = useState<Error | null>(null);
  const [gatherAnnotationId, setCorrelationAnnotationId] = useState<AnnotationId | null>(null);

  // Store latest config/token in refs to avoid re-subscribing when they change
  const configRef = useRef(config);
  const tokenRef = useRef(token);
  useEffect(() => { configRef.current = config; });
  useEffect(() => { tokenRef.current = token; });

  useEffect(() => {
    const handleGatherRequested = (event: EventMap['gather:requested']) => {
      setCorrelationLoading(true);
      setCorrelationError(null);
      setCorrelationContext(null);
      setCorrelationAnnotationId(event.annotationId);

      const { client, resourceId } = configRef.current;
      const contextWindow = event.options?.contextWindow ?? 2000;

      // Subscribe to result events before starting the stream
      const finishedSub = eventBus.get('gather:annotation-finished').subscribe((finishedEvent) => {
        if (finishedEvent.annotationId !== event.annotationId) return;
        finishedSub.unsubscribe();
        failedSub.unsubscribe();

        const context = finishedEvent.response.context ?? null;
        setCorrelationContext(context);
        setCorrelationLoading(false);

        eventBus.get('gather:complete').next({
          annotationId: finishedEvent.annotationId,
          response: finishedEvent.response,
        });
      });

      const failedSub = eventBus.get('gather:failed').subscribe((failedEvent) => {
        if (failedEvent.annotationId !== event.annotationId) return;
        finishedSub.unsubscribe();
        failedSub.unsubscribe();

        setCorrelationError(failedEvent.error);
        setCorrelationLoading(false);
      });

      client.sse.gatherAnnotation(
        resourceId,
        event.annotationId,
        { contextWindow },
        { auth: toAccessToken(tokenRef.current), eventBus },
      );
    };

    const subscription = eventBus.get('gather:requested').subscribe(handleGatherRequested);
    return () => subscription.unsubscribe();
  }, [eventBus]);

  return { gatherContext, gatherLoading, gatherError, gatherAnnotationId };
}
