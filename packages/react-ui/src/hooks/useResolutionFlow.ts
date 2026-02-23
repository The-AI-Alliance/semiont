import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceUri } from '@semiont/core';
import { resourceAnnotationUri, accessToken } from '@semiont/core';
import { uriToAnnotationIdOrPassthrough } from '@semiont/core';
import { useEventBus } from '../contexts/EventBusContext';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';

/** Helper to convert string | null to AccessToken | undefined */
function toAccessToken(token: string | null) {
  return token ? accessToken(token) : undefined;
}

export interface ResolutionFlowState {
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
 * @emits resolve:body-updated - Annotation body successfully updated
 * @emits resolve:body-update-failed - Annotation body update failed
 * @emits resolve:search-requested - Search modal requested
 * @subscribes resolve:update-body - Update annotation body via API
 * @subscribes resolve:link - User clicked "Link Document"; opens search modal
 * @subscribes resolve:search-requested - Opens search modal with pending reference
 */
export function useResolutionFlow(rUri: ResourceUri): ResolutionFlowState {
  const eventBus = useEventBus();
  const client = useApiClient();
  const token = useAuthToken();

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

        eventBus.get('resolve:body-updated').next({ annotationUri: event.annotationUri });
      } catch (error) {
        console.error('Failed to update annotation body:', error);
        eventBus.get('resolve:body-update-failed').next({ error: error as Error });
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
      eventBus.get('resolve:search-requested').next({
        referenceId: event.annotationUri,
        searchTerm: event.searchTerm,
      });
    };

    const subscription1 = eventBus.get('resolve:update-body').subscribe(handleAnnotationUpdateBody);
    const subscription2 = eventBus.get('resolve:link').subscribe(handleReferenceLink);

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

    const subscription = eventBus.get('resolve:search-requested').subscribe(handleResolutionSearchRequested);
    return () => subscription.unsubscribe();
  }, [eventBus]);

  return { searchModalOpen, pendingReferenceId, onCloseSearchModal };
}
