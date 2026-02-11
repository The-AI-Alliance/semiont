import { useEffect, useRef } from 'react';
import type { Emitter } from 'mitt';
import type { EventMap } from './EventBusContext';
import type { SemiontApiClient, ResourceUri, Motivation, Selector } from '@semiont/api-client';
import { resourceAnnotationUri } from '@semiont/api-client';
import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

export interface EventOperationsConfig {
  client?: SemiontApiClient;
  resourceUri?: ResourceUri;

  // Callbacks for state updates (React Query invalidation, toasts, etc.)
  onAnnotationCreated?: (annotation: Annotation) => void;
  onAnnotationDeleted?: (annotationId: string) => void;
  onDetectionProgress?: (progress: any) => void;
  onError?: (error: Error, operation: string) => void;
  onSuccess?: (message: string) => void;
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
  const { client, resourceUri, onAnnotationCreated, onAnnotationDeleted, onDetectionProgress, onError, onSuccess } = config;

  // Store SSE stream refs for cancellation
  const detectionStreamRef = useRef<AbortController | null>(null);
  const generationStreamRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Guard: Only set up subscriptions if we have required dependencies
    if (!client || !resourceUri) {
      return;
    }

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
      try {
        const result = await client.createAnnotation(resourceUri, {
          motivation: event.motivation,
          target: {
            source: resourceUri,
            selector: event.selector,
          },
          body: event.body,
        });

        if (result.annotation) {
          // Notify via callback (triggers React Query cache invalidation, sparkle animations, etc.)
          onAnnotationCreated?.(result.annotation);

          // Emit success event for other subscribers
          emitter.emit('annotation:created', { annotation: result.annotation });
        }
      } catch (error) {
        console.error('Failed to create annotation:', error);
        onError?.(error as Error, 'create annotation');
        emitter.emit('annotation:create-failed', { error: error as Error });
      }
    };

    /**
     * Handle annotation deletion
     * Emitted by: (future) delete buttons in annotation entries
     */
    const handleAnnotationDelete = async (event: { annotationId: string }) => {
      try {
        // Extract annotation ID segment if it's a full URI
        const annotationIdSegment = event.annotationId.split('/').pop() || event.annotationId;
        const annotationUri = resourceAnnotationUri(`${resourceUri}/annotations/${annotationIdSegment}`);

        await client.deleteAnnotation(annotationUri);

        // Notify via callback
        onAnnotationDeleted?.(event.annotationId);

        // Emit success event
        emitter.emit('annotation:deleted', { annotationId: event.annotationId });
      } catch (error) {
        console.error('Failed to delete annotation:', error);
        onError?.(error as Error, 'delete annotation');
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
        const annotationIdSegment = event.annotationUri.split('/').pop() || event.annotationUri;
        const nestedUri = resourceAnnotationUri(`${resourceUri}/annotations/${annotationIdSegment}`);

        await client.updateAnnotationBody(nestedUri, {
          resourceId: event.resourceId,
          operations: event.operations as any,
        });

        // Emit success event
        emitter.emit('annotation:body-updated', { annotationUri: event.annotationUri });
        onSuccess?.('Annotation updated');
      } catch (error) {
        console.error('Failed to update annotation body:', error);
        onError?.(error as Error, 'update annotation body');
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
        detectionStreamRef.current?.abort();
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
            onDetectionProgress?.(chunk as any);
            emitter.emit('detection:progress', chunk as any);
          });

          stream.onComplete(() => {
            emitter.emit('detection:complete', { motivation: event.motivation });
            onSuccess?.('Detection complete');
          });

          stream.onError((error) => {
            console.error('Detection failed:', error);
            onError?.(error as Error, 'detection');
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
            onDetectionProgress?.(chunk as any);
            emitter.emit('detection:progress', chunk as any);
          });

          stream.onComplete(() => {
            emitter.emit('detection:complete', { motivation: event.motivation });
            onSuccess?.('Detection complete');
          });

          stream.onError((error) => {
            console.error('Detection failed:', error);
            onError?.(error as Error, 'detection');
            emitter.emit('detection:failed', { error: error as Error } as any);
          });
        } else if (event.motivation === 'highlighting') {
          // Highlight detection
          const stream = client.sse.detectHighlights(resourceUri, {
            instructions: event.options.instructions,
          });

          stream.onProgress((chunk) => {
            onDetectionProgress?.(chunk as any);
            emitter.emit('detection:progress', chunk as any);
          });

          stream.onComplete(() => {
            emitter.emit('detection:complete', { motivation: event.motivation });
            onSuccess?.('Detection complete');
          });

          stream.onError((error) => {
            console.error('Detection failed:', error);
            onError?.(error as Error, 'detection');
            emitter.emit('detection:failed', { error: error as Error } as any);
          });
        } else if (event.motivation === 'assessing') {
          // Assessment detection
          const stream = client.sse.detectAssessments(resourceUri, {
            instructions: event.options.instructions,
          });

          stream.onProgress((chunk) => {
            onDetectionProgress?.(chunk as any);
            emitter.emit('detection:progress', chunk as any);
          });

          stream.onComplete(() => {
            emitter.emit('detection:complete', { motivation: event.motivation });
            onSuccess?.('Detection complete');
          });

          stream.onError((error) => {
            console.error('Detection failed:', error);
            onError?.(error as Error, 'detection');
            emitter.emit('detection:failed', { error: error as Error } as any);
          });
        } else if (event.motivation === 'commenting') {
          // Comment detection
          const stream = client.sse.detectComments(resourceUri, {
            instructions: event.options.instructions,
            tone: event.options.tone as any,
          });

          stream.onProgress((chunk) => {
            onDetectionProgress?.(chunk as any);
            emitter.emit('detection:progress', chunk as any);
          });

          stream.onComplete(() => {
            emitter.emit('detection:complete', { motivation: event.motivation });
            onSuccess?.('Detection complete');
          });

          stream.onError((error) => {
            console.error('Detection failed:', error);
            onError?.(error as Error, 'detection');
            emitter.emit('detection:failed', { error: error as Error } as any);
          });
        }
      } catch (error) {
        if ((error as any).name === 'AbortError') {
          // Normal cancellation, not an error
          emitter.emit('detection:cancelled', undefined);
        } else {
          console.error('Detection failed:', error);
          onError?.(error as Error, 'detection');
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
          onSuccess?.('Document generated');
        });

        stream.onError((error) => {
          console.error('Generation failed:', error);
          onError?.(error as Error, 'generate document');
          emitter.emit('reference:generation-failed', { error: error as Error });
        });
      } catch (error) {
        if ((error as any).name === 'AbortError') {
          // Normal cancellation
        } else {
          console.error('Generation failed:', error);
          onError?.(error as Error, 'generate document');
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
  }, [emitter, client, resourceUri, onAnnotationCreated, onAnnotationDeleted, onDetectionProgress, onError, onSuccess]);
}

/**
 * Non-hook version of event operations setup for use outside React context
 * Used by EventBusProvider to set up operation handlers
 */
export function setupEventOperations(
  emitter: Emitter<EventMap>,
  config: {
    rUri: ResourceUri;
    client: SemiontApiClient;
  }
) {
  const { rUri: resourceUri, client } = config;

  // Store SSE stream refs for cancellation
  let detectionStreamRef: AbortController | null = null;
  let generationStreamRef: AbortController | null = null;

  // ========================================================================
  // ANNOTATION OPERATIONS
  // ========================================================================

  const handleAnnotationCreate = async (event: {
    motivation: Motivation;
    selector: Selector | Selector[];
    body: any[];
  }) => {
    try {
      const result = await client.createAnnotation(resourceUri, {
        motivation: event.motivation,
        target: {
          source: resourceUri,
          selector: event.selector,
        },
        body: event.body,
      });

      if (result.annotation) {
        emitter.emit('annotation:created', { annotation: result.annotation });
      }
    } catch (error) {
      console.error('Failed to create annotation:', error);
      emitter.emit('annotation:create-failed', { error: error as Error });
    }
  };

  const handleAnnotationDelete = async (event: { annotationId: string }) => {
    try {
      const annotationIdSegment = event.annotationId.split('/').pop() || event.annotationId;
      const annotationUri = resourceAnnotationUri(`${resourceUri}/annotations/${annotationIdSegment}`);

      await client.deleteAnnotation(annotationUri);
      emitter.emit('annotation:deleted', { annotationId: event.annotationId });
    } catch (error) {
      console.error('Failed to delete annotation:', error);
      emitter.emit('annotation:delete-failed', { error: error as Error });
    }
  };

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
      const annotationIdSegment = event.annotationUri.split('/').pop() || event.annotationUri;
      const nestedUri = resourceAnnotationUri(`${resourceUri}/annotations/${annotationIdSegment}`);

      await client.updateAnnotationBody(nestedUri, {
        resourceId: event.resourceId,
        operations: event.operations as any,
      });

      emitter.emit('annotation:body-updated', { annotationUri: event.annotationUri });
    } catch (error) {
      console.error('Failed to update annotation body:', error);
      emitter.emit('annotation:body-update-failed', { error: error as Error });
    }
  };

  // ========================================================================
  // DETECTION OPERATIONS (SSE Streams)
  // ========================================================================

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
      detectionStreamRef?.abort();
      detectionStreamRef = new AbortController();

      if (event.motivation === 'tagging') {
        const { schemaId, categories } = event.options;
        if (!schemaId || !categories || categories.length === 0) {
          throw new Error('Tag detection requires schemaId and categories');
        }

        const stream = client.sse.detectTags(resourceUri, { schemaId, categories });
        stream.onProgress((chunk) => emitter.emit('detection:progress', chunk as any));
        stream.onComplete(() => emitter.emit('detection:complete', { motivation: event.motivation }));
        stream.onError((error) => {
          console.error('Detection failed:', error);
          emitter.emit('detection:failed', { error: error as Error } as any);
        });
      } else if (event.motivation === 'linking') {
        const { entityTypes, includeDescriptiveReferences } = event.options;
        if (!entityTypes || entityTypes.length === 0) {
          throw new Error('Reference detection requires entityTypes');
        }

        const stream = client.sse.detectAnnotations(resourceUri, {
          entityTypes: entityTypes as any,
          includeDescriptiveReferences: includeDescriptiveReferences || false,
        });
        stream.onProgress((chunk) => emitter.emit('detection:progress', chunk as any));
        stream.onComplete(() => emitter.emit('detection:complete', { motivation: event.motivation }));
        stream.onError((error) => {
          console.error('Detection failed:', error);
          emitter.emit('detection:failed', { error: error as Error } as any);
        });
      } else if (event.motivation === 'highlighting') {
        const stream = client.sse.detectHighlights(resourceUri, { instructions: event.options.instructions });
        stream.onProgress((chunk) => emitter.emit('detection:progress', chunk as any));
        stream.onComplete(() => emitter.emit('detection:complete', { motivation: event.motivation }));
        stream.onError((error) => {
          console.error('Detection failed:', error);
          emitter.emit('detection:failed', { error: error as Error } as any);
        });
      } else if (event.motivation === 'assessing') {
        const stream = client.sse.detectAssessments(resourceUri, { instructions: event.options.instructions });
        stream.onProgress((chunk) => emitter.emit('detection:progress', chunk as any));
        stream.onComplete(() => emitter.emit('detection:complete', { motivation: event.motivation }));
        stream.onError((error) => {
          console.error('Detection failed:', error);
          emitter.emit('detection:failed', { error: error as Error } as any);
        });
      } else if (event.motivation === 'commenting') {
        const stream = client.sse.detectComments(resourceUri, {
          instructions: event.options.instructions,
          tone: event.options.tone as any,
        });
        stream.onProgress((chunk) => emitter.emit('detection:progress', chunk as any));
        stream.onComplete(() => emitter.emit('detection:complete', { motivation: event.motivation }));
        stream.onError((error) => {
          console.error('Detection failed:', error);
          emitter.emit('detection:failed', { error: error as Error } as any);
        });
      }
    } catch (error) {
      if ((error as any).name === 'AbortError') {
        emitter.emit('detection:cancelled', undefined);
      } else {
        console.error('Detection failed:', error);
        emitter.emit('detection:failed', { error: error as Error } as any);
      }
    }
  };

  const handleJobCancelRequested = (event: { jobType: 'detection' | 'generation' }) => {
    if (event.jobType === 'detection') {
      detectionStreamRef?.abort();
      detectionStreamRef = null;
      emitter.emit('detection:cancelled', undefined);
    } else if (event.jobType === 'generation') {
      generationStreamRef?.abort();
      generationStreamRef = null;
    }
  };

  // ========================================================================
  // REFERENCE OPERATIONS
  // ========================================================================

  const handleReferenceGenerate = async (event: {
    annotationUri: string;
    resourceUri: string;
    options: { title: string; prompt?: string; language?: string; temperature?: number; maxTokens?: number };
  }) => {
    try {
      generationStreamRef?.abort();
      generationStreamRef = new AbortController();

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

      stream.onProgress((chunk) => emitter.emit('reference:generation-progress', { chunk: chunk as any }));
      stream.onComplete(() => emitter.emit('reference:generation-complete', { annotationUri: event.annotationUri }));
      stream.onError((error) => {
        console.error('Generation failed:', error);
        emitter.emit('reference:generation-failed', { error: error as Error });
      });
    } catch (error) {
      if ((error as any).name !== 'AbortError') {
        console.error('Generation failed:', error);
        emitter.emit('reference:generation-failed', { error: error as Error });
      }
    }
  };

  const handleReferenceCreateManual = (event: {
    annotationUri: string;
    title: string;
    entityTypes: string[];
  }) => {
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

  const handleReferenceLink = (event: {
    annotationUri: string;
    searchTerm: string;
  }) => {
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

  // Return cleanup function
  return () => {
    emitter.off('annotation:create', handleAnnotationCreate);
    emitter.off('annotation:delete', handleAnnotationDelete);
    emitter.off('annotation:update-body', handleAnnotationUpdateBody);
    emitter.off('detection:start', handleDetectionStart);
    emitter.off('job:cancel-requested', handleJobCancelRequested);
    emitter.off('reference:generate', handleReferenceGenerate);
    emitter.off('reference:create-manual', handleReferenceCreateManual);
    emitter.off('reference:link', handleReferenceLink);

    detectionStreamRef?.abort();
    generationStreamRef?.abort();
  };
}
