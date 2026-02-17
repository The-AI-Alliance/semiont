import { useEffect, useRef } from 'react';
import type { Emitter } from 'mitt';
import type { EventMap } from './EventBusContext';
import type { SemiontApiClient, ResourceUri } from '@semiont/api-client';
import { resourceAnnotationUri, accessToken } from '@semiont/api-client';
import { uriToAnnotationIdOrPassthrough } from '@semiont/core';
import { useAuthToken } from './AuthTokenContext';

/** Helper to convert string | null to AccessToken | undefined */
function toAccessToken(token: string | null) {
  return token ? accessToken(token) : undefined;
}

export interface EventOperationsConfig {
  client: SemiontApiClient;
  resourceUri: ResourceUri;
}

/**
 * Hook that subscribes to remaining operation events and coordinates API calls
 *
 * Handles: annotation:update-body, reference:link
 *
 * annotation:create, annotation:delete, detection:start are handled
 * directly in useDetectionFlow.
 *
 * generation:start, job:cancel-requested (generation half), reference:create-manual
 * are handled directly in useGenerationFlow.
 *
 * @param emitter - The mitt event bus instance
 * @param config - Configuration including API client and resource URI
 */
export function useEventOperations(
  emitter: Emitter<EventMap>,
  config: EventOperationsConfig
) {
  const { client, resourceUri } = config;

  // Get current auth token for API calls
  const token = useAuthToken();

  // Store latest config in ref to avoid re-subscribing when client/resourceUri change
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  });

  useEffect(() => {
    // Get current config from ref (always latest)
    const getCurrentConfig = () => configRef.current;

    // ========================================================================
    // ANNOTATION BODY UPDATE
    // ========================================================================

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
        const { client: currentClient, resourceUri: currentResourceUri } = getCurrentConfig();
        const annotationIdSegment = uriToAnnotationIdOrPassthrough(event.annotationUri);
        const nestedUri = resourceAnnotationUri(`${currentResourceUri}/annotations/${annotationIdSegment}`);

        await currentClient.updateAnnotationBody(nestedUri, {
          resourceId: event.resourceId,
          operations: event.operations as any,
        }, { auth: toAccessToken(token) });

        emitter.emit('annotation:body-updated', { annotationUri: event.annotationUri });
      } catch (error) {
        console.error('Failed to update annotation body:', error);
        emitter.emit('annotation:body-update-failed', { error: error as Error });
      }
    };

    // ========================================================================
    // REFERENCE OPERATIONS
    // ========================================================================

    /**
     * Handle reference linking (search for existing documents)
     * Emitted by: ReferenceEntry (when user clicks "Link Document")
     * Opens the search modal
     */
    const handleReferenceLink = (event: {
      annotationUri: string;
      searchTerm: string;
    }) => {
      // Emit event to open search modal (SearchResourcesModal will subscribe to this)
      emitter.emit('reference:search-modal-open', {
        referenceId: event.annotationUri,
        searchTerm: event.searchTerm,
      });
    };

    // ========================================================================
    // SUBSCRIBE TO EVENTS
    // ========================================================================

    emitter.on('annotation:update-body', handleAnnotationUpdateBody);
    emitter.on('reference:link', handleReferenceLink);

    // Cleanup: unsubscribe
    return () => {
      emitter.off('annotation:update-body', handleAnnotationUpdateBody);
      emitter.off('reference:link', handleReferenceLink);
    };
  }, [emitter, token]); // Only re-run if emitter or token changes
}
