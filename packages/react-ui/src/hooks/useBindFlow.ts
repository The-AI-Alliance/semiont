/**
 * useBindFlow - Reference resolution flow hook
 *
 * Handles the write side of reference resolution:
 * - Annotation body updates (linking/unlinking)
 * - Error notifications
 *
 * The wizard modal (ReferenceWizardModal) handles modal state, context
 * gathering, search configuration, and result display. This hook handles
 * the downstream API calls after the wizard emits bind:update-body.
 *
 * @subscribes bind:update-body - Update annotation body via API
 * @emits bind:body-updated - Annotation body successfully updated
 * @emits bind:body-update-failed - Annotation body update failed
 */

import { useEffect, useRef } from 'react';
import type { EventMap, ResourceId } from '@semiont/core';
import { accessToken } from '@semiont/core';
import { useEventBus } from '../contexts/EventBusContext';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useToast } from '../components/Toast';

/** Helper to convert string | null to AccessToken | undefined */
function toAccessToken(token: string | null) {
  return token ? accessToken(token) : undefined;
}

export function useBindFlow(rUri: ResourceId): void {
  const eventBus = useEventBus();
  const client = useApiClient();
  const token = useAuthToken();
  const { showError } = useToast();

  // Store latest values in refs to avoid re-subscribing
  const rUriRef = useRef(rUri);
  useEffect(() => { rUriRef.current = rUri; });

  const clientRef = useRef(client);
  useEffect(() => { clientRef.current = client; });

  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; });

  useEffect(() => {
    /**
     * Handle annotation body updates
     * Emitted by: ReferenceWizardModal (linking) and ReferenceEntry (unlinking)
     */
    const handleAnnotationUpdateBody = async (event: EventMap['bind:update-body']) => {
      try {
        await clientRef.current.updateAnnotationBody(rUriRef.current, event.annotationId, {
          resourceId: event.resourceId,
          operations: event.operations as any,
        }, { auth: toAccessToken(tokenRef.current) });

        eventBus.get('bind:body-updated').next({ annotationId: event.annotationId });
      } catch (error) {
        console.error('Failed to update annotation body:', error);
        eventBus.get('bind:body-update-failed').next({ error: error as Error });
      }
    };

    /**
     * Handle bind search requests
     * Emitted by: ReferenceWizardModal (search button)
     * Bridges to backend Binder actor via SSE stream.
     * Results auto-emit as bind:search-results on the browser EventBus.
     */
    const handleSearchRequested = (event: EventMap['bind:search-requested']) => {
      clientRef.current.sse.bindSearch(rUriRef.current, {
        referenceId: event.referenceId,
        context: event.context,
        limit: event.limit,
        useSemanticScoring: event.useSemanticScoring,
      }, { auth: toAccessToken(tokenRef.current), eventBus });
    };

    const updateSub = eventBus.get('bind:update-body').subscribe(handleAnnotationUpdateBody);
    const searchSub = eventBus.get('bind:search-requested').subscribe(handleSearchRequested);
    return () => {
      updateSub.unsubscribe();
      searchSub.unsubscribe();
    };
  }, [eventBus]);

  // Toast notifications for resolution errors
  useEventSubscriptions({
    'bind:body-update-failed': ({ error }) => showError(`Failed to update reference: ${error.message}`),
  });
}
