/**
 * useContextCorrelationFlow - Context correlation capability hook
 *
 * Correlation capability: given a reference annotation, fetch the surrounding
 * text context (before/selected/after) from the source document so it can
 * be correlated and used as grounding material for generation.
 *
 * This hook is the single owner of correlation state. It is triggered by
 * correlate:requested on the event bus, making the capability
 * accessible to both human UI flows and agents.
 *
 * @subscribes correlate:requested - Fetch LLM context for an annotation
 * @emits correlate:complete - Context successfully fetched
 * @emits correlate:failed - Context fetch failed
 * @returns Correlation state (context, loading, error, which annotation)
 */

import { useState, useEffect, useRef } from 'react';
import type { EventBus, GenerationContext, ResourceUri } from '@semiont/core';
import { SemiontApiClient } from '@semiont/api-client';
import { accessToken } from '@semiont/core';
import { useAuthToken } from '../contexts/AuthTokenContext';


/** Helper to convert string | null to AccessToken | undefined */
function toAccessToken(token: string | null) {
  return token ? accessToken(token) : undefined;
}

export interface ContextCorrelationFlowConfig {
  client: SemiontApiClient;
  resourceUri: ResourceUri;
}

export interface ContextCorrelationFlowState {
  correlationContext: GenerationContext | null;
  correlationLoading: boolean;
  correlationError: Error | null;
  /** The annotationUri for which context was most recently correlated */
  correlationAnnotationUri: string | null;
}

export function useContextCorrelationFlow(
  eventBus: EventBus,
  config: ContextCorrelationFlowConfig
): ContextCorrelationFlowState {
  const token = useAuthToken();

  const [correlationContext, setCorrelationContext] = useState<GenerationContext | null>(null);
  const [correlationLoading, setCorrelationLoading] = useState(false);
  const [correlationError, setCorrelationError] = useState<Error | null>(null);
  const [correlationAnnotationUri, setCorrelationAnnotationUri] = useState<string | null>(null);

  // Store latest config/token in refs to avoid re-subscribing when they change
  const configRef = useRef(config);
  const tokenRef = useRef(token);
  useEffect(() => { configRef.current = config; });
  useEffect(() => { tokenRef.current = token; });

  useEffect(() => {
    const handleContextCorrelationRequested = async (event: {
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
          eventBus.get('correlate:complete').next({
            annotationUri: event.annotationUri,
            context,
          });
        }
      } catch (error) {
        const err = error as Error;
        setCorrelationError(err);
        setCorrelationLoading(false);

        eventBus.get('correlate:failed').next({
          annotationUri: event.annotationUri,
          error: err,
        });
      }
    };

    const subscription = eventBus.get('correlate:requested').subscribe(handleContextCorrelationRequested);
    return () => subscription.unsubscribe();
  }, [eventBus]);

  return { correlationContext, correlationLoading, correlationError, correlationAnnotationUri };
}
