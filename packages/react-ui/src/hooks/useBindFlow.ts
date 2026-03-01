import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceUri } from '@semiont/core';
import { resourceAnnotationUri, accessToken } from '@semiont/core';
import { uriToAnnotationIdOrPassthrough } from '@semiont/core';
import { useEventBus } from '../contexts/EventBusContext';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useToast } from '../components/Toast';

/** Helper to convert string | null to AccessToken | undefined */
function toAccessToken(token: string | null) {
  return token ? accessToken(token) : undefined;
}

export interface BindFlowState {
  searchModalOpen: boolean;
  pendingReferenceId: string | null;
  onCloseSearchModal: () => void;
}

/**
 * Hook that handles the Resolution capability: resolving reference annotations
 * to existing resources (search) or new resources (manual creation).
 *
 * @param rUri - Resource URI being viewed
 * @returns Resolution flow state (search modal open state and close handler)
 *
 * @emits bind:body-updated - Annotation body successfully updated
 * @emits bind:body-update-failed - Annotation body update failed
 * @emits bind:search-requested - Search modal requested
 * @subscribes bind:update-body - Update annotation body via API
 * @subscribes bind:link - User clicked "Link Document"; opens search modal
 * @subscribes bind:search-requested - Opens search modal with pending reference
 */
export function useBindFlow(rUri: ResourceUri): BindFlowState {
  const eventBus = useEventBus();
  const client = useApiClient();
  const token = useAuthToken();
  const { showError } = useToast();

  // Resolution search modal state
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [pendingReferenceId, setPendingReferenceId] = useState<string | null>(null);

  const onCloseSearchModal = useCallback(() => {
    setSearchModalOpen(false);
  }, []);

  // Store latest rUri in ref to avoid re-subscribing when it changes
  const rUriRef = useRef(rUri);
  useEffect(() => {
    rUriRef.current = rUri;
  });

  // Store latest client in ref to avoid re-subscribing when it changes
  const clientRef = useRef(client);
  useEffect(() => {
    clientRef.current = client;
  });

  // Store latest token in ref
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  });

  useEffect(() => {
    /**
     * Handle annotation body updates
     * Emitted by: ReferenceEntry (for unlinking), future body editing features
     */
    const handleAnnotationUpdateBody = async (event: {
      annotationUri: string;
      resourceId: string;
      operations: Array<{
        op: 'add' | 'remove' | 'replace';
        item?: any;
        oldItem?: any;
        newItem?: any;
      }>;
    }) => {
      try {
        const annotationIdSegment = uriToAnnotationIdOrPassthrough(event.annotationUri);
        const nestedUri = resourceAnnotationUri(`${rUriRef.current}/annotations/${annotationIdSegment}`);

        await clientRef.current.updateAnnotationBody(nestedUri, {
          resourceId: event.resourceId,
          operations: event.operations as any,
        }, { auth: toAccessToken(tokenRef.current) });

        eventBus.get('bind:body-updated').next({ annotationUri: event.annotationUri });
      } catch (error) {
        console.error('Failed to update annotation body:', error);
        eventBus.get('bind:body-update-failed').next({ error: error as Error });
      }
    };

    /**
     * Handle reference linking (search for existing documents)
     * Emitted by: ReferenceEntry (when user clicks "Link Document")
     */
    const handleReferenceLink = (event: {
      annotationUri: string;
      searchTerm: string;
    }) => {
      eventBus.get('bind:search-requested').next({
        referenceId: event.annotationUri,
        searchTerm: event.searchTerm,
      });
    };

    const subscription1 = eventBus.get('bind:update-body').subscribe(handleAnnotationUpdateBody);
    const subscription2 = eventBus.get('bind:link').subscribe(handleReferenceLink);

    return () => {
      subscription1.unsubscribe();
      subscription2.unsubscribe();
    };
  }, [eventBus]); // eventBus is stable singleton; client/rUri/token accessed via refs

  useEffect(() => {
    const handleResolutionSearchRequested = (event: { referenceId: string; searchTerm: string }) => {
      setPendingReferenceId(event.referenceId);
      setSearchModalOpen(true);
    };

    const subscription = eventBus.get('bind:search-requested').subscribe(handleResolutionSearchRequested);
    return () => subscription.unsubscribe();
  }, [eventBus]);

  // Toast notifications for resolution errors (matching annotation flow pattern)
  useEventSubscriptions({
    'bind:body-update-failed': ({ error }) => showError(`Failed to update reference: ${error.message}`),
  });

  return { searchModalOpen, pendingReferenceId, onCloseSearchModal };
}
