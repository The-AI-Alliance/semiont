/**
 * useContextRetrievalFlow - Context retrieval capability hook
 *
 * Retrieval capability: given a reference annotation, fetch the surrounding
 * text context (before/selected/after) from the source document so it can
 * be used as grounding material for generation.
 *
 * This hook is the single owner of retrieval state. It is triggered by
 * context:retrieval-requested on the event bus, making the capability
 * accessible to both human UI flows and agents.
 *
 * @subscribes context:retrieval-requested - Fetch LLM context for an annotation
 * @emits context:retrieval-complete - Context successfully fetched
 * @emits context:retrieval-failed - Context fetch failed
 * @returns Retrieval state (context, loading, error, which annotation)
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

export interface ContextRetrievalFlowConfig {
  client: SemiontApiClient;
  resourceUri: ResourceUri;
}

export interface ContextRetrievalFlowState {
  retrievalContext: GenerationContext | null;
  retrievalLoading: boolean;
  retrievalError: Error | null;
  /** The annotationUri for which context was most recently retrieved */
  retrievalAnnotationUri: string | null;
}

export function useContextRetrievalFlow(
  eventBus: EventBus,
  config: ContextRetrievalFlowConfig
): ContextRetrievalFlowState {
  const token = useAuthToken();

  const [retrievalContext, setRetrievalContext] = useState<GenerationContext | null>(null);
  const [retrievalLoading, setRetrievalLoading] = useState(false);
  const [retrievalError, setRetrievalError] = useState<Error | null>(null);
  const [retrievalAnnotationUri, setRetrievalAnnotationUri] = useState<string | null>(null);

  // Store latest config/token in refs to avoid re-subscribing when they change
  const configRef = useRef(config);
  const tokenRef = useRef(token);
  useEffect(() => { configRef.current = config; });
  useEffect(() => { tokenRef.current = token; });

  useEffect(() => {
    const handleContextRetrievalRequested = async (event: {
      annotationUri: string;
      resourceUri: string;
    }) => {
      setRetrievalLoading(true);
      setRetrievalError(null);
      setRetrievalContext(null);
      setRetrievalAnnotationUri(event.annotationUri);

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
        setRetrievalContext(context);
        setRetrievalLoading(false);

        if (context) {
          eventBus.get('context:retrieval-complete').next({
            annotationUri: event.annotationUri,
            context,
          });
        }
      } catch (error) {
        const err = error as Error;
        setRetrievalError(err);
        setRetrievalLoading(false);

        eventBus.get('context:retrieval-failed').next({
          annotationUri: event.annotationUri,
          error: err,
        });
      }
    };

    const subscription = eventBus.get('context:retrieval-requested').subscribe(handleContextRetrievalRequested);
    return () => subscription.unsubscribe();
  }, [eventBus]);

  return { retrievalContext, retrievalLoading, retrievalError, retrievalAnnotationUri };
}
