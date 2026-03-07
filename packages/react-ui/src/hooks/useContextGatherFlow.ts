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
import type { EventBus, YieldContext, ResourceUri } from '@semiont/core';
import { SemiontApiClient } from '@semiont/api-client';
import { accessToken } from '@semiont/core';
import { useAuthToken } from '../contexts/AuthTokenContext';


/** Helper to convert string | null to AccessToken | undefined */
function toAccessToken(token: string | null) {
  return token ? accessToken(token) : undefined;
}

export interface ContextGatherFlowConfig {
  client: SemiontApiClient;
  resourceUri: ResourceUri;
}

export interface ContextGatherFlowState {
  gatherContext: YieldContext | null;
  gatherLoading: boolean;
  gatherError: Error | null;
  /** The annotationUri for which context was most recently gathered */
  gatherAnnotationUri: string | null;
}

export function useContextGatherFlow(
  eventBus: EventBus,
  config: ContextGatherFlowConfig
): ContextGatherFlowState {
  const token = useAuthToken();

  const [gatherContext, setCorrelationContext] = useState<YieldContext | null>(null);
  const [gatherLoading, setCorrelationLoading] = useState(false);
  const [gatherError, setCorrelationError] = useState<Error | null>(null);
  const [gatherAnnotationUri, setCorrelationAnnotationUri] = useState<string | null>(null);

  // Store latest config/token in refs to avoid re-subscribing when they change
  const configRef = useRef(config);
  const tokenRef = useRef(token);
  useEffect(() => { configRef.current = config; });
  useEffect(() => { tokenRef.current = token; });

  useEffect(() => {
    const handleGatherRequested = async (event: {
      annotationUri: string;
      resourceUri: string;
    }) => {
      setCorrelationLoading(true);
      setCorrelationError(null);
      setCorrelationContext(null);
      setCorrelationAnnotationUri(event.annotationUri);

      try {
        const { client } = configRef.current;
        // Extract short annotation ID from full URI
        const annotationId = event.annotationUri.split('/').pop() || '';

        const response = await client.getAnnotationLLMContext(
          event.resourceUri as ResourceUri,
          annotationId,
          { contextWindow: 2000, auth: toAccessToken(tokenRef.current) }
        );

        const context = response.context ?? null;
        setCorrelationContext(context);
        setCorrelationLoading(false);

        if (context) {
          eventBus.get('gather:complete').next({
            annotationUri: event.annotationUri,
            context,
          });
        }
      } catch (error) {
        const err = error as Error;
        setCorrelationError(err);
        setCorrelationLoading(false);

        eventBus.get('gather:failed').next({
          annotationUri: event.annotationUri,
          error: err,
        });
      }
    };

    const subscription = eventBus.get('gather:requested').subscribe(handleGatherRequested);
    return () => subscription.unsubscribe();
  }, [eventBus]);

  return { gatherContext, gatherLoading, gatherError, gatherAnnotationUri };
}
