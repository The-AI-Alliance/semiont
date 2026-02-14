import { useEffect, useRef } from 'react';
import type { Emitter } from 'mitt';
import type { EventMap } from './EventBusContext';
import type { SemiontApiClient, ResourceUri, Motivation, Selector } from '@semiont/api-client';
import { resourceAnnotationUri } from '@semiont/api-client';
import { uriToAnnotationIdOrPassthrough } from '@semiont/core';

export interface EventOperationsConfig {
  client?: SemiontApiClient;
  resourceUri?: ResourceUri;
}

/**
 * Hook that subscribes to operation events and coordinates API calls
 *
 * This hook implements the event-driven architecture by listening to events
 * emitted by UI components and translating them into API operations.
 *
 * @param emitter - The mitt event bus instance
 * @param config - Configuration including API client and callbacks
 */
export function useEventOperations(
  emitter: Emitter<EventMap>,
  config: EventOperationsConfig
) {
  const { client, resourceUri } = config;

  // Store SSE stream refs for cancellation
  const detectionStreamRef = useRef<AbortController | null>(null);
  const generationStreamRef = useRef<AbortController | null>(null);

  // Store latest config in ref to avoid re-subscribing when client/resourceUri change
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  });

  useEffect(() => {
    // Guard: Only set up subscriptions if we have required dependencies
    if (!client || !resourceUri) {
      return;
    }

    // Get current config from ref (always latest)
    const getCurrentConfig = () => configRef.current;

    // ========================================================================
    // ANNOTATION OPERATIONS
    // ========================================================================

    /**
     * Handle annotation creation
     * Emitted by: HighlightPanel, AssessmentPanel, CommentsPanel, TaggingPanel, ReferencesPanel
     */
    const handleAnnotationCreate = async (event: {
      motivation: Motivation;
      selector: Selector | Selector[];
      body: any[];
    }) => {
      const { client: currentClient, resourceUri: currentResourceUri } = getCurrentConfig();
      if (!currentClient || !currentResourceUri) return;

      try {
        const result = await currentClient.createAnnotation(currentResourceUri, {
          motivation: event.motivation,
          target: {
            source: resourceUri,
            selector: event.selector,
          },
          body: event.body,
        });

        if (result.annotation) {
          // Emit success event for subscribers to handle UI updates
          emitter.emit('annotation:created', { annotation: result.annotation });
        }
      } catch (error) {
        console.error('Failed to create annotation:', error);
        emitter.emit('annotation:create-failed', { error: error as Error });
      }
    };

    /**
     * Handle annotation deletion
     * Emitted by: (future) delete buttons in annotation entries
     */
    const handleAnnotationDelete = async (event: { annotationId: string }) => {
      try {
        const annotationIdSegment = uriToAnnotationIdOrPassthrough(event.annotationId);
        const annotationUri = resourceAnnotationUri(`${resourceUri}/annotations/${annotationIdSegment}`);

        await client.deleteAnnotation(annotationUri);

        // Emit success event
        emitter.emit('annotation:deleted', { annotationId: event.annotationId });
      } catch (error) {
        console.error('Failed to delete annotation:', error);
        emitter.emit('annotation:delete-failed', { error: error as Error });
      }
    };

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
        const nestedUri = resourceAnnotationUri(`${resourceUri}/annotations/${annotationIdSegment}`);

        await client.updateAnnotationBody(nestedUri, {
          resourceId: event.resourceId,
          operations: event.operations as any,
        });

        // Emit success event
        emitter.emit('annotation:body-updated', { annotationUri: event.annotationUri });
      } catch (error) {
        console.error('Failed to update annotation body:', error);
        emitter.emit('annotation:body-update-failed', { error: error as Error });
      }
    };

    // ========================================================================
    // DETECTION OPERATIONS (SSE Streams)
    // ========================================================================

    /**
     * Handle detection start
     * Emitted by: DetectSection, TaggingPanel, ReferencesPanel
     */
    const handleDetectionStart = async (event: {
      motivation: Motivation;
      options: {
        instructions?: string;
        tone?: string;
        density?: number;
        entityTypes?: string[];
        includeDescriptiveReferences?: boolean;
        schemaId?: string;
        categories?: string[];
      };
    }) => {
      try {
        // Cancel any existing detection
        if (detectionStreamRef.current) {
          detectionStreamRef.current.abort();
        }
        detectionStreamRef.current = new AbortController();

        // Different detection endpoints based on motivation
        if (event.motivation === 'tagging') {
          // Tag detection requires schemaId and categories
          const { schemaId, categories } = event.options;
          if (!schemaId || !categories || categories.length === 0) {
            throw new Error('Tag detection requires schemaId and categories');
          }

          const stream = client.sse.detectTags(resourceUri, {
            schemaId,
            categories,
          });

          stream.onProgress((chunk) => {
            emitter.emit('detection:progress', chunk as any);
          });

          stream.onComplete(() => {
            emitter.emit('detection:complete', { motivation: event.motivation });
          });

          stream.onError((error) => {
            console.error('Detection failed:', error);
            emitter.emit('detection:failed', { error: error as Error } as any);
          });
        } else if (event.motivation === 'linking') {
          // Reference detection (uses detectAnnotations with entityTypes)
          const { entityTypes, includeDescriptiveReferences } = event.options;
          if (!entityTypes || entityTypes.length === 0) {
            throw new Error('Reference detection requires entityTypes');
          }

          const stream = client.sse.detectAnnotations(resourceUri, {
            entityTypes: entityTypes as any,
            includeDescriptiveReferences: includeDescriptiveReferences || false,
          });

          stream.onProgress((chunk) => {
            emitter.emit('detection:progress', chunk as any);
          });

          stream.onComplete(() => {
            emitter.emit('detection:complete', { motivation: event.motivation });
          });

          stream.onError((error) => {
            console.error('Detection failed:', error);
            emitter.emit('detection:failed', { error: error as Error } as any);
          });
        } else if (event.motivation === 'highlighting') {
          // Highlight detection
          const stream = client.sse.detectHighlights(resourceUri, {
            instructions: event.options.instructions,
          });

          stream.onProgress((chunk) => {
            emitter.emit('detection:progress', chunk as any);
          });

          stream.onComplete(() => {
            emitter.emit('detection:complete', { motivation: event.motivation });
          });

          stream.onError((error) => {
            console.error('Detection failed:', error);
            emitter.emit('detection:failed', { error: error as Error } as any);
          });
        } else if (event.motivation === 'assessing') {
          // Assessment detection
          const stream = client.sse.detectAssessments(resourceUri, {
            instructions: event.options.instructions,
          });

          stream.onProgress((chunk) => {
            emitter.emit('detection:progress', chunk as any);
          });

          stream.onComplete(() => {
            emitter.emit('detection:complete', { motivation: event.motivation });
          });

          stream.onError((error) => {
            console.error('[useEventOperations] Assessment detection error:', error);
            emitter.emit('detection:failed', { error: error as Error } as any);
          });
        } else if (event.motivation === 'commenting') {
          // Comment detection
          const stream = client.sse.detectComments(resourceUri, {
            instructions: event.options.instructions,
            tone: event.options.tone as any,
          });

          stream.onProgress((chunk) => {
            emitter.emit('detection:progress', chunk as any);
          });

          stream.onComplete(() => {
            emitter.emit('detection:complete', { motivation: event.motivation });
          });

          stream.onError((error) => {
            console.error('Detection failed:', error);
            emitter.emit('detection:failed', { error: error as Error } as any);
          });
        }
      } catch (error) {
        if ((error as any).name === 'AbortError') {
          // Normal cancellation, not an error
          emitter.emit('detection:cancelled', undefined);
        } else {
          console.error('Detection failed:', error);
          emitter.emit('detection:failed', { error: error as Error } as any);
        }
      }
    };

    /**
     * Handle job cancellation
     * Emitted by: DetectionProgressWidget
     */
    const handleJobCancelRequested = (event: { jobType: 'detection' | 'generation' }) => {
      if (event.jobType === 'detection') {
        detectionStreamRef.current?.abort();
        detectionStreamRef.current = null;
        emitter.emit('detection:cancelled', undefined);
      } else if (event.jobType === 'generation') {
        generationStreamRef.current?.abort();
        generationStreamRef.current = null;
      }
    };

    // ========================================================================
    // REFERENCE OPERATIONS
    // ========================================================================

    /**
     * Handle document generation from reference
     * Emitted by: ReferenceEntry (when user clicks generate button)
     */
    const handleReferenceGenerate = async (event: {
      annotationUri: string;
      resourceUri: string;
      options: { title: string; prompt?: string; language?: string; temperature?: number; maxTokens?: number };
    }) => {
      try {
        generationStreamRef.current?.abort();
        generationStreamRef.current = new AbortController();

        const stream = client.sse.generateResourceFromAnnotation(
          event.resourceUri as any,
          event.annotationUri as any,
          {
            title: event.options.title,
            prompt: event.options.prompt,
            language: event.options.language,
            temperature: event.options.temperature,
            maxTokens: event.options.maxTokens,
          } as any
        );

        stream.onProgress((chunk) => {
          emitter.emit('reference:generation-progress', { chunk: chunk as any });
        });

        stream.onComplete(() => {
          emitter.emit('reference:generation-complete', { annotationUri: event.annotationUri });
        });

        stream.onError((error) => {
          console.error('Generation failed:', error);
          emitter.emit('reference:generation-failed', { error: error as Error });
        });
      } catch (error) {
        if ((error as any).name === 'AbortError') {
          // Normal cancellation
        } else {
          console.error('Generation failed:', error);
          emitter.emit('reference:generation-failed', { error: error as Error });
        }
      }
    };

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
    // SUBSCRIBE TO ALL EVENTS
    // ========================================================================

    emitter.on('annotation:create', handleAnnotationCreate);
    emitter.on('annotation:delete', handleAnnotationDelete);
    emitter.on('annotation:update-body', handleAnnotationUpdateBody);
    emitter.on('detection:start', handleDetectionStart);
    emitter.on('job:cancel-requested', handleJobCancelRequested);
    emitter.on('reference:generate', handleReferenceGenerate);
    emitter.on('reference:create-manual', handleReferenceCreateManual);
    emitter.on('reference:link', handleReferenceLink);

    // Cleanup: unsubscribe and abort any ongoing streams
    return () => {
      emitter.off('annotation:create', handleAnnotationCreate);
      emitter.off('annotation:delete', handleAnnotationDelete);
      emitter.off('annotation:update-body', handleAnnotationUpdateBody);
      emitter.off('detection:start', handleDetectionStart);
      emitter.off('job:cancel-requested', handleJobCancelRequested);
      emitter.off('reference:generate', handleReferenceGenerate);
      emitter.off('reference:create-manual', handleReferenceCreateManual);
      emitter.off('reference:link', handleReferenceLink);

      detectionStreamRef.current?.abort();
      generationStreamRef.current?.abort();
    };
  }, [emitter]); // Only re-run if emitter changes (it shouldn't)
}

/**
 * Non-hook version of event operations setup for use outside React context
 * Used by EventBusProvider to set up operation handlers
 */
// setupEventOperations removed - only useEventOperations hook is needed
// The non-hook version was only used by EventBusProvider's useEffect, which has been removed
