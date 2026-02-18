import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceUri } from '@semiont/api-client';
import { resourceAnnotationUri, accessToken } from '@semiont/api-client';
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
 * @emits annotation:body-updated - Annotation body successfully updated
 * @emits annotation:body-update-failed - Annotation body update failed
 * @emits resolution:search-requested - Search modal requested
 * @subscribes annotation:update-body - Update annotation body via API
 * @subscribes reference:link - User clicked "Link Document"; opens search modal
 * @subscribes resolution:search-requested - Opens search modal with pending reference
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

        eventBus.emit('annotation:body-updated', { annotationUri: event.annotationUri });
      } catch (error) {
        console.error('Failed to update annotation body:', error);
        eventBus.emit('annotation:body-update-failed', { error: error as Error });
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
      eventBus.emit('resolution:search-requested', {
        referenceId: event.annotationUri,
        searchTerm: event.searchTerm,
      });
    };

    eventBus.on('annotation:update-body', handleAnnotationUpdateBody);
    eventBus.on('reference:link', handleReferenceLink);

    return () => {
      eventBus.off('annotation:update-body', handleAnnotationUpdateBody);
      eventBus.off('reference:link', handleReferenceLink);
    };
  }, [eventBus]); // eventBus is stable singleton; client/rUri/token accessed via refs

  useEffect(() => {
    const handleResolutionSearchRequested = (event: { referenceId: string; searchTerm: string }) => {
      setPendingReferenceId(event.referenceId);
      setSearchModalOpen(true);
    };

    eventBus.on('resolution:search-requested', handleResolutionSearchRequested);
    return () => {
      eventBus.off('resolution:search-requested', handleResolutionSearchRequested);
    };
  }, [eventBus]);

  return { searchModalOpen, pendingReferenceId, onCloseSearchModal };
}
