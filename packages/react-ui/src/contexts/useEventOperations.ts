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
 * Handles: annotation:update-body, generation:start, job:cancel-requested,
 * reference:create-manual, reference:link
 *
 * annotation:create, annotation:delete, detection:start are handled
 * directly in useDetectionFlow.
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

  // Store SSE stream ref for generation cancellation
  const generationStreamRef = useRef<AbortController | null>(null);

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
    // JOB CANCELLATION
    // ========================================================================

    /**
     * Handle job cancellation
     * Emitted by: DetectionProgressWidget
     */
    const handleJobCancelRequested = (event: { jobType: 'detection' | 'generation' }) => {
      if (event.jobType === 'generation') {
        generationStreamRef.current?.abort();
        generationStreamRef.current = null;
      }
      // detection cancellation is handled in useDetectionFlow via detectionStreamRef
    };

    // ========================================================================
    // GENERATION OPERATIONS (SSE Stream)
    // ========================================================================

    /**
     * Handle document generation start
     * Emitted by: useGenerationFlow (when user submits generation modal with full options)
     */
    const handleGenerationStart = async (event: {
      annotationUri: string;
      resourceUri: string;
      options: {
        title: string;
        prompt?: string;
        language?: string;
        temperature?: number;
        maxTokens?: number;
        context: any; // GenerationContext - required
      };
    }) => {
      console.log('[useEventOperations] handleGenerationStart called', { annotationUri: event.annotationUri, options: event.options });
      try {
        generationStreamRef.current?.abort();
        generationStreamRef.current = new AbortController();

        const stream = client.sse.generateResourceFromAnnotation(
          event.resourceUri as any,
          event.annotationUri as any,
          event.options as any,
          { auth: toAccessToken(token) }
        );

        stream.onProgress((chunk) => {
          console.log('[useEventOperations] Generation progress chunk received', chunk);
          emitter.emit('generation:progress', chunk);
        });

        stream.onComplete((finalChunk) => {
          console.log('[useEventOperations] Generation complete with final chunk', finalChunk);
          // Forward final completion chunk as progress BEFORE emitting complete (like detection)
          emitter.emit('generation:progress', finalChunk);
          emitter.emit('generation:complete', {
            annotationUri: event.annotationUri,
            progress: finalChunk
          });
        });

        stream.onError((error) => {
          console.error('[useEventOperations] Generation failed:', error);
          emitter.emit('generation:failed', { error: error as Error });
        });
      } catch (error) {
        if ((error as any).name === 'AbortError') {
          // Normal cancellation
          console.log('[useEventOperations] Generation cancelled');
        } else {
          console.error('[useEventOperations] Generation failed:', error);
          emitter.emit('generation:failed', { error: error as Error });
        }
      }
    };

    // ========================================================================
    // REFERENCE OPERATIONS
    // ========================================================================

    /**
     * Handle manual document creation for reference
     * Emitted by: ReferenceEntry (when user clicks "Create Document")
     * This navigates to the compose page
     */
    const handleReferenceCreateManual = (event: {
      annotationUri: string;
      title: string;
      entityTypes: string[];
    }) => {
      // Navigate to compose page with reference completion params
      const baseUrl = window.location.origin;
      const resourceId = resourceUri.split('/resources/')[1];

      const params = new URLSearchParams({
        annotationUri: event.annotationUri,
        sourceDocumentId: resourceId || '',
        name: event.title,
        entityTypes: event.entityTypes.join(','),
      });

      window.location.href = `${baseUrl}/know/compose?${params.toString()}`;
    };

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
    emitter.on('job:cancel-requested', handleJobCancelRequested);
    emitter.on('generation:start', handleGenerationStart);
    emitter.on('reference:create-manual', handleReferenceCreateManual);
    emitter.on('reference:link', handleReferenceLink);

    // Cleanup: unsubscribe and abort any ongoing streams
    return () => {
      emitter.off('annotation:update-body', handleAnnotationUpdateBody);
      emitter.off('job:cancel-requested', handleJobCancelRequested);
      emitter.off('generation:start', handleGenerationStart);
      emitter.off('reference:create-manual', handleReferenceCreateManual);
      emitter.off('reference:link', handleReferenceLink);

      generationStreamRef.current?.abort();
    };
  }, [emitter, token]); // Only re-run if emitter or token changes
}
