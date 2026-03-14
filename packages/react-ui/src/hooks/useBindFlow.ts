import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnnotationId, EventMap, GatheredContext, ResourceId, ResourceUri } from '@semiont/core';
import { resourceAnnotationUri, accessToken } from '@semiont/core';
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
  /** Whether the context modal (step 1) is open */
  contextModalOpen: boolean;
  /** Whether the search results modal (step 2) is open */
  searchModalOpen: boolean;
  pendingReferenceId: string | null;
  pendingSearchTerm: string | null;
  pendingResourceId: ResourceId | null;
  onCloseContextModal: () => void;
  onCloseSearchModal: () => void;
  /** Called from BindContextModal when user clicks "Search" */
  onSearch: (searchTerm: string, context: GatheredContext) => void;
}

/**
 * Hook that handles the Resolution capability: resolving reference annotations
 * to existing resources (search) or new resources (manual creation).
 *
 * Two-step flow:
 * 1. bind:link → opens context modal + triggers gather:requested
 * 2. User reviews context, clicks "Search" → emits bind:search-requested with context
 * 3. bind:search-requested → opens search results modal
 *
 * @param rUri - Resource URI being viewed
 * @returns Resolution flow state
 *
 * @emits bind:body-updated - Annotation body successfully updated
 * @emits bind:body-update-failed - Annotation body update failed
 * @emits bind:search-requested - Context-driven search requested
 * @emits gather:requested - Triggers context gathering for the annotation
 * @subscribes bind:update-body - Update annotation body via API
 * @subscribes bind:link - User clicked "Link Document"; opens context modal
 * @subscribes bind:search-requested - Opens search results modal
 */
export function useBindFlow(rUri: ResourceUri): BindFlowState {
  const eventBus = useEventBus();
  const client = useApiClient();
  const token = useAuthToken();
  const { showError } = useToast();

  // Step 1: Context modal state
  const [contextModalOpen, setContextModalOpen] = useState(false);
  const [pendingReferenceId, setPendingReferenceId] = useState<string | null>(null);
  const [pendingSearchTerm, setPendingSearchTerm] = useState<string | null>(null);
  const [pendingResourceId, setPendingResourceId] = useState<ResourceId | null>(null);

  // Step 2: Search results modal state
  const [searchModalOpen, setSearchModalOpen] = useState(false);

  const onCloseContextModal = useCallback(() => {
    setContextModalOpen(false);
  }, []);

  const onCloseSearchModal = useCallback(() => {
    setSearchModalOpen(false);
  }, []);

  /**
   * Called from BindContextModal when user clicks "Search".
   * Emits bind:search-requested with the gathered context.
   */
  const onSearch = useCallback((searchTerm: string, context: GatheredContext) => {
    if (!pendingReferenceId) return;
    setContextModalOpen(false);
    eventBus.get('bind:search-requested').next({
      referenceId: pendingReferenceId,
      searchTerm,
      context,
    });
  }, [eventBus, pendingReferenceId]);

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
    const handleAnnotationUpdateBody = async (event: EventMap['bind:update-body']) => {
      try {
        const nestedUri = resourceAnnotationUri(`${rUriRef.current}/annotations/${event.annotationId}`);

        await clientRef.current.updateAnnotationBody(nestedUri, {
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
     * Handle reference linking (search for existing documents)
     * Emitted by: ReferenceEntry (when user clicks "Link Document")
     *
     * Step 1: Open context modal and trigger gather:requested.
     * The search is deferred until the user reviews context and clicks "Search".
     */
    const handleReferenceLink = (event: EventMap['bind:link']) => {
      setPendingReferenceId(event.annotationId);
      setPendingSearchTerm(event.searchTerm);
      setPendingResourceId(event.resourceId);
      setContextModalOpen(true);

      // Trigger context gathering (same event used by Generate flow)
      eventBus.get('gather:requested').next({
        annotationId: event.annotationId as AnnotationId,
        resourceId: event.resourceId,
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
    /**
     * Step 2: When bind:search-requested fires, open the search results modal.
     * This happens after the user clicks "Search" in the context modal.
     */
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

  return {
    contextModalOpen,
    searchModalOpen,
    pendingReferenceId,
    pendingSearchTerm,
    pendingResourceId,
    onCloseContextModal,
    onCloseSearchModal,
    onSearch,
  };
}
