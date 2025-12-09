"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { NEXT_PUBLIC_API_URL } from '@/lib/env';
import { useParams } from 'next/navigation';
import { useRouter } from '@/i18n/routing';
import { useLocale } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useResources, useEntityTypes, useApiClient, useAnnotations } from '@/lib/api-hooks';
import { QUERY_KEYS } from '@/lib/query-keys';
import { ResourceViewer } from '@/components/resource/ResourceViewer';
import { ResourceTagsInline } from '@/components/ResourceTagsInline';
import { ProposeEntitiesModal } from '@/components/modals/ProposeEntitiesModal';
import { buttonStyles } from '@/lib/button-styles';
import type { components, ResourceUri, ContentFormat } from '@semiont/api-client';
import { getResourceId, getLanguage, getPrimaryMediaType, getPrimaryRepresentation, searchQuery, getAnnotationExactText } from '@semiont/api-client';
import { groupAnnotationsByType } from '@/lib/annotation-registry';
import { decodeWithCharset } from '@/lib/text-encoding';

type SemiontResource = components['schemas']['ResourceDescriptor'];
import { useOpenResources } from '@/contexts/OpenResourcesContext';
import { useResourceAnnotations } from '@/contexts/ResourceAnnotationsContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useToast } from '@/components/Toast';
import { useDetectionProgress } from '@/hooks/useDetectionProgress';
import { DetectionProgressWidget } from '@/components/DetectionProgressWidget';
import { useGenerationProgress } from '@/hooks/useGenerationProgress';
import { AnnotationHistory } from '@/components/resource/AnnotationHistory';
import { useTheme } from '@/hooks/useTheme';
import { useToolbar } from '@/hooks/useToolbar';
import { useLineNumbers } from '@/hooks/useLineNumbers';
import { useResourceEvents } from '@/hooks/useResourceEvents';
import { useDebouncedCallback } from '@/hooks/useDebounce';
import { UnifiedAnnotationsPanel } from '@/components/resource/panels/UnifiedAnnotationsPanel';
import { ResourceInfoPanel } from '@/components/resource/panels/ResourceInfoPanel';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { CollaborationPanel } from '@/components/resource/panels/CollaborationPanel';
import { ResourceActionsPanel } from '@/components/resource/panels/ResourceActionsPanel';
import { JsonLdPanel } from '@/components/resource/panels/JsonLdPanel';
import { Toolbar } from '@/components/Toolbar';
import { annotationUri, resourceUri, resourceAnnotationUri } from '@semiont/api-client';
import { SearchResourcesModal } from '@/components/modals/SearchResourcesModal';

// Loading state component
function ResourceLoadingState() {
  return (
    <div className="flex items-center justify-center py-20">
      <p className="text-gray-600 dark:text-gray-300">Loading resource...</p>
    </div>
  );
}

// Error state component
function ResourceErrorState({
  error,
  onRetry
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 space-y-4">
      <p className="text-red-600 dark:text-red-400">
        {error instanceof Error ? error.message : 'Failed to load resource'}
      </p>
      <button
        onClick={onRetry}
        className={buttonStyles.secondary.base}
      >
        Try Again
      </button>
    </div>
  );
}

// Main page component with proper early returns
export default function KnowledgeResourcePage() {
  const params = useParams();

  // URI construction strategy:
  // 1. Browser URLs use clean IDs: /know/resource/{uuid}
  // 2. API calls require full URIs: http://localhost:4000/resources/{uuid}
  // 3. Construct initial URI from URL param to fetch the resource
  const initialUri = resourceUri(`${NEXT_PUBLIC_API_URL}/resources/${params?.id}`);

  // API hooks
  const resources = useResources();
  const entityTypesAPI = useEntityTypes();
  const annotationsAPI = useAnnotations();

  // Load resource data - this is the ONLY hook before early returns
  const {
    data: docData,
    isLoading,
    isError,
    error,
    refetch: refetchDocument
  } = resources.get.useQuery(initialUri) as {
    data: { resource: SemiontResource } | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => Promise<unknown>;
  };

  // Log error for debugging
  useEffect(() => {
    if (isError && !isLoading) {
      console.error(`[Document] Failed to load resource ${initialUri}:`, error);
    }
  }, [isError, isLoading, initialUri, error]);

  // Early return: Loading state
  if (isLoading) {
    return <ResourceLoadingState />;
  }

  // Early return: Error state
  if (isError) {
    return <ResourceErrorState error={error} onRetry={() => refetchDocument()} />;
  }

  // Early return: ResourceDescriptor not found
  if (!docData?.resource) {
    return <ResourceErrorState error={new Error('Resource not found')} onRetry={() => refetchDocument()} />;
  }

  const resource = docData.resource;

  // Use the canonical URI from the API response (resource['@id'])
  // This is the W3C-compliant URI that should match our constructed URI
  const canonicalUri = resourceUri(resource['@id']);

  // Assert that our constructed URI matches the canonical URI from the API
  // This ensures the frontend's URL construction matches the backend's URI generation
  if (canonicalUri !== initialUri) {
    console.warn(
      `[Document] URI mismatch:\n` +
      `  Constructed: ${initialUri}\n` +
      `  Canonical:   ${canonicalUri}\n` +
      `This may indicate environment misconfiguration.`
    );
  }

  return (
    <ResourceView
      resource={resource}
      rUri={canonicalUri}
      refetchDocument={refetchDocument}
      resources={resources}
      entityTypesAPI={entityTypesAPI}
      annotationsAPI={annotationsAPI}
    />
  );
}

// Main resource view - resource is guaranteed to exist
function ResourceView({
  resource,
  rUri,
  refetchDocument,
  resources,
  entityTypesAPI,
  annotationsAPI
}: {
  resource: SemiontResource;
  rUri: ResourceUri;
  refetchDocument: () => Promise<unknown>;
  resources: ReturnType<typeof useResources>;
  entityTypesAPI: ReturnType<typeof useEntityTypes>;
  annotationsAPI: ReturnType<typeof useAnnotations>;
}) {
  const router = useRouter();
  const { data: session } = useSession();
  const locale = useLocale();
  const { addResource } = useOpenResources();
  const { triggerSparkleAnimation, clearNewAnnotationId, convertHighlightToReference, convertReferenceToHighlight, deleteAnnotation, addComment, createAnnotation } = useResourceAnnotations();
  const { showError, showSuccess } = useToast();
  const client = useApiClient();
  const queryClient = useQueryClient();

  // Fetch document content separately
  const [content, setContent] = useState<string>('');
  const [contentLoading, setContentLoading] = useState(true);

  useEffect(() => {
    const loadContent = async () => {
      if (!client) return;

      try {
        // Get the primary representation's mediaType from the resource
        const mediaType = getPrimaryMediaType(resource) || 'text/plain';

        // Use api-client for W3C content negotiation
        const { data } = await client.getResourceRepresentation(rUri as ResourceUri, {
          accept: mediaType as ContentFormat,
        });
        // Decode ArrayBuffer to string using charset from mediaType
        // This ensures the same character space as backend annotation creation
        const text = decodeWithCharset(data, mediaType);
        setContent(text);
      } catch (error) {
        console.error('Failed to fetch representation:', error);
        showError('Failed to load resource representation');
      } finally {
        setContentLoading(false);
      }
    };
    loadContent();
  }, [rUri, resource, client, showError]);

  // Fetch all annotations with a single request
  const { data: annotationsData, refetch: refetchAnnotations } = resources.annotations.useQuery(rUri);
  const annotations = annotationsData?.annotations || [];

  // Group annotations by type using centralized registry
  type Annotation = components['schemas']['Annotation'];
  const groups = groupAnnotationsByType(annotations);
  const highlights = groups.highlight || [];
  const references = groups.reference || [];
  const assessments = groups.assessment || [];
  const comments = groups.comment || [];
  const tags = groups.tag || [];

  // Create debounced invalidation for real-time events (batches rapid updates)
  // Using React Query's invalidateQueries is the best practice - it invalidates cache
  // and triggers automatic refetch for all components using those queries
  const debouncedInvalidateAnnotations = useDebouncedCallback(
    () => {
      // Invalidate annotations and events queries using type-safe query keys
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.annotations(rUri) });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(rUri) });
    },
    500 // Wait 500ms after last event before invalidating (batches rapid updates)
  );
  const { data: referencedByData, isLoading: referencedByLoading } = resources.referencedBy.useQuery(rUri);
  const referencedBy = referencedByData?.referencedBy || [];

  // Derived state
  const documentEntityTypes = resource.entityTypes || [];

  // Get primary representation metadata
  const primaryRep = getPrimaryRepresentation(resource);
  const primaryMediaType = primaryRep?.mediaType;
  const primaryByteSize = primaryRep?.byteSize;

  // Get entity types for detection
  const { data: entityTypesData } = entityTypesAPI.list.useQuery();
  const allEntityTypes = (entityTypesData as { entityTypes: string[] } | undefined)?.entityTypes || [];

  // Set up mutations
  const updateDocMutation = resources.update.useMutation();
  const generateCloneTokenMutation = resources.generateCloneToken.useMutation();
  const updateAnnotationBodyMutation = annotationsAPI.updateBody.useMutation();

  const [annotateMode, setAnnotateMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('annotateMode') === 'true';
    }
    return false;
  });

  // Debug logging
  console.log('[ResourcePage] annotateMode:', annotateMode, 'primaryMediaType:', primaryMediaType, 'isText:', primaryMediaType?.startsWith('text/'));

  const { theme, setTheme } = useTheme();
  const { activePanel, togglePanel, setActivePanel } = useToolbar({ persistToStorage: true });
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
  const [scrollToAnnotationId, setScrollToAnnotationId] = useState<string | null>(null);
  const [pendingCommentSelection, setPendingCommentSelection] = useState<{ exact: string; start: number; end: number } | null>(null);
  const [pendingTagSelection, setPendingTagSelection] = useState<{ exact: string; start: number; end: number } | null>(null);
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);
  const [focusedReferenceId, setFocusedReferenceId] = useState<string | null>(null);
  const [focusedHighlightId, setFocusedHighlightId] = useState<string | null>(null);
  const [hoveredHighlightId, setHoveredHighlightId] = useState<string | null>(null);
  const [focusedAssessmentId, setFocusedAssessmentId] = useState<string | null>(null);
  const [hoveredAssessmentId, setHoveredAssessmentId] = useState<string | null>(null);
  const [focusedTagId, setFocusedTagId] = useState<string | null>(null);
  const [hoveredTagId, setHoveredTagId] = useState<string | null>(null);
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [pendingReferenceId, setPendingReferenceId] = useState<string | null>(null);

  // Detection states for highlights
  const [isDetectingHighlights, setIsDetectingHighlights] = useState(false);
  const [highlightDetectionProgress, setHighlightDetectionProgress] = useState<{
    status: string;
    percentage?: number;
    message?: string;
  } | null>(null);

  // Detection states for assessments
  const [isDetectingAssessments, setIsDetectingAssessments] = useState(false);
  const [assessmentDetectionProgress, setAssessmentDetectionProgress] = useState<{
    status: string;
    percentage?: number;
    message?: string;
  } | null>(null);

  // Detection states for comments
  const [isDetectingComments, setIsDetectingComments] = useState(false);
  const [commentDetectionProgress, setCommentDetectionProgress] = useState<{
    status: string;
    percentage?: number;
    message?: string;
  } | null>(null);

  // Detection states for tags
  const [isDetectingTags, setIsDetectingTags] = useState(false);
  const [tagDetectionProgress, setTagDetectionProgress] = useState<{
    status: string;
    percentage?: number;
    message?: string;
    currentCategory?: string;
  } | null>(null);

  // Handle event hover - trigger sparkle animation
  const handleEventHover = useCallback((annotationId: string | null) => {
    setHoveredAnnotationId(annotationId);
    if (annotationId) {
      triggerSparkleAnimation(annotationId);
    }
  }, [triggerSparkleAnimation]);

  // Handle event click - scroll to annotation
  const handleEventClick = useCallback((annotationId: string | null) => {
    setScrollToAnnotationId(annotationId);
  }, []);

  // Helper to reload document after mutations
  const loadDocument = useCallback(async () => {
    await refetchDocument();
  }, [refetchDocument]);

  // Add resource to open tabs when it loads
  useEffect(() => {
    if (resource && rUri) {
      // Extract ID segment from full URI (format: http://host/resources/{id})
      const resourceIdSegment = rUri.split('/').pop() || '';
      const mediaType = getPrimaryMediaType(resource);
      addResource(resourceIdSegment, resource.name, mediaType || undefined);
      localStorage.setItem('lastViewedDocumentId', resourceIdSegment);
    }
  }, [resource, rUri, addResource]);

  // Update document tags - memoized
  const updateDocumentTags = useCallback(async (tags: string[]) => {
    try {
      await updateDocMutation.mutateAsync({
        rUri,
        data: { entityTypes: tags }
      });
      showSuccess('Document tags updated successfully');
      await refetchDocument();
    } catch (err) {
      console.error('Failed to update document tags:', err);
      showError('Failed to update document tags');
    }
  }, [rUri, updateDocMutation, refetchDocument, showSuccess, showError]);

  // Handle archive toggle - memoized
  const handleArchive = useCallback(async () => {
    if (!resource) return;

    try {
      await updateDocMutation.mutateAsync({
        rUri,
        data: { archived: true }
      });
      await loadDocument();
      showSuccess('Document archived');
    } catch (err) {
      console.error('Failed to archive document:', err);
      showError('Failed to archive document');
    }
  }, [resource, rUri, updateDocMutation, loadDocument, showSuccess, showError]);

  const handleUnarchive = useCallback(async () => {
    if (!resource) return;

    try {
      await updateDocMutation.mutateAsync({
        rUri,
        data: { archived: false }
      });
      await loadDocument();
      showSuccess('Document unarchived');
    } catch (err) {
      console.error('Failed to unarchive document:', err);
      showError('Failed to unarchive document');
    }
  }, [resource, rUri, updateDocMutation, loadDocument, showSuccess, showError]);

  const handleClone = useCallback(async () => {
    try {
      const response = await generateCloneTokenMutation.mutateAsync(rUri) as { token: string; expiresAt: string; resource: SemiontResource };
      if (response.token) {
        // Navigate to compose page with clone token
        router.push(`/know/compose?mode=clone&token=${response.token}`);
      } else {
        showError('Failed to generate clone token');
      }
    } catch (err) {
      console.error('Failed to generate clone token:', err);
      showError('Failed to clone document');
    }
  }, [rUri, generateCloneTokenMutation, router, showError]);

  // Handle annotate mode toggle - memoized
  const handleAnnotateModeToggle = useCallback(() => {
    const newMode = !annotateMode;
    setAnnotateMode(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('annotateMode', newMode.toString());
    }
  }, [annotateMode]);


  // Use SSE-based detection progress
  const {
    isDetecting,
    progress: detectionProgress,
    startDetection,
    cancelDetection
  } = useDetectionProgress({
    rUri,
    onProgress: (progress) => {
      // When an entity type completes, refetch to show new annotations immediately
      // Use both refetch (for immediate document view update) AND invalidate (for Annotation History)
      refetchAnnotations();
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(rUri) });
    },
    onComplete: (progress) => {
      // Don't show toast - the widget already shows completion status
      // Final refetch + invalidation when ALL entity types complete
      refetchAnnotations();
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(rUri) });
    },
    onError: (error) => {
      showError(error);
    }
  });

  // Use SSE-based document generation progress - provides inline sparkle animation
  const {
    progress: generationProgress,
    startGeneration,
    clearProgress
  } = useGenerationProgress({
    onComplete: (progress) => {
      // Sparkle animation was already triggered when generation started (in handleGenerateDocument)
      // It will continue pulsing until annotation.body.updated event updates the cache

      // Clear progress widget
      setTimeout(() => clearProgress(), 1000);
    },
    onError: (error) => {
      console.error('[Generation] Error:', error);
    }
  });

  // Handle detect entity references - updated for SSE
  const handleDetectEntityReferences = useCallback(async (selectedTypes: string[]) => {
    // Start detection with the selected entity types
    setTimeout(() => startDetection(selectedTypes), 100);
  }, [startDetection]);

  // Handle document generation from stub reference
  const handleGenerateDocument = useCallback((referenceId: string, options: { title: string; prompt?: string }) => {
    // Clear CSS sparkle animation if reference was recently created
    // (it may still be in newAnnotationIds with a 6-second timer from creation)
    // We only want the widget sparkle (✨ emoji) during generation, not the CSS pulse
    // referenceId is already a full W3C-compliant URI from the API
    clearNewAnnotationId(annotationUri(referenceId));

    // Widget sparkle (✨ emoji) will show automatically during generation via generatingReferenceId
    // Pass language (using locale from Next.js routing) to ensure generated content is in the user's preferred language
    const optionsWithLanguage = { ...options, language: locale };
    // Use full resource URI (W3C Web Annotation spec requires URIs)
    const resourceUriStr = resource['@id'];
    startGeneration(annotationUri(referenceId), resourceUri(resourceUriStr), optionsWithLanguage);
  }, [startGeneration, resource, clearNewAnnotationId, locale]);

  /**
   * Handle highlight detection
   */
  const handleDetectHighlights = useCallback(async (instructions?: string) => {
    if (!client) return;

    setIsDetectingHighlights(true);
    setHighlightDetectionProgress({ status: 'started', message: 'Starting highlight detection...' });

    try {
      const stream = client.sse.detectHighlights(rUri, instructions ? { instructions } : {});

      stream.onProgress((progress: any) => {
        setHighlightDetectionProgress({
          status: progress.status,
          percentage: progress.percentage,
          message: progress.message
        });
      });

      stream.onComplete((result: any) => {
        setHighlightDetectionProgress({
          status: 'complete',
          percentage: 100,
          message: `Created ${result.createdCount} highlights`
        });
        setIsDetectingHighlights(false);
        refetchAnnotations();
        showSuccess(`Created ${result.createdCount} highlights`);
      });

      stream.onError((error: any) => {
        setHighlightDetectionProgress(null);
        setIsDetectingHighlights(false);
        showError(`Highlight detection failed: ${error.message}`);
      });
    } catch (error) {
      setIsDetectingHighlights(false);
      setHighlightDetectionProgress(null);
      showError('Failed to start highlight detection');
    }
  }, [client, rUri, refetchAnnotations, showSuccess, showError]);

  /**
   * Handle assessment detection
   */
  const handleDetectAssessments = useCallback(async (instructions?: string) => {
    if (!client) return;

    setIsDetectingAssessments(true);
    setAssessmentDetectionProgress({ status: 'started', message: 'Starting assessment detection...' });

    try {
      const stream = client.sse.detectAssessments(rUri, instructions ? { instructions } : {});

      stream.onProgress((progress: any) => {
        setAssessmentDetectionProgress({
          status: progress.status,
          percentage: progress.percentage,
          message: progress.message
        });
      });

      stream.onComplete((result: any) => {
        setAssessmentDetectionProgress({
          status: 'complete',
          percentage: 100,
          message: `Created ${result.createdCount} assessments`
        });
        setIsDetectingAssessments(false);
        refetchAnnotations();
        showSuccess(`Created ${result.createdCount} assessments`);
      });

      stream.onError((error: any) => {
        setAssessmentDetectionProgress(null);
        setIsDetectingAssessments(false);
        showError(`Assessment detection failed: ${error.message}`);
      });
    } catch (error) {
      setIsDetectingAssessments(false);
      setAssessmentDetectionProgress(null);
      showError('Failed to start assessment detection');
    }
  }, [client, rUri, refetchAnnotations, showSuccess, showError]);

  /**
   * Handle comment detection
   */
  const handleDetectComments = useCallback(async (instructions?: string, tone?: string) => {
    if (!client) return;

    setIsDetectingComments(true);
    setCommentDetectionProgress({ status: 'started', message: 'Starting comment detection...' });

    try {
      const stream = client.sse.detectComments(rUri, {
        ...(instructions && { instructions }),
        ...(tone && { tone: tone as 'scholarly' | 'explanatory' | 'conversational' | 'technical' })
      });

      stream.onProgress((progress: any) => {
        setCommentDetectionProgress({
          status: progress.status,
          percentage: progress.percentage,
          message: progress.message
        });
      });

      stream.onComplete((result: any) => {
        setCommentDetectionProgress({
          status: 'complete',
          percentage: 100,
          message: `Created ${result.createdCount} comments`
        });
        setIsDetectingComments(false);
        refetchAnnotations();
        showSuccess(`Created ${result.createdCount} comments`);
      });

      stream.onError((error: any) => {
        setCommentDetectionProgress(null);
        setIsDetectingComments(false);
        showError(`Comment detection failed: ${error.message}`);
      });
    } catch (error) {
      setIsDetectingComments(false);
      setCommentDetectionProgress(null);
      showError('Failed to start comment detection');
    }
  }, [client, rUri, refetchAnnotations, showSuccess, showError]);

  /**
   * Handle tag detection
   */
  const handleDetectTags = useCallback(async (schemaId: string, categories: string[]) => {
    if (!client) return;

    setIsDetectingTags(true);
    setTagDetectionProgress({ status: 'started', message: 'Starting tag detection...' });

    try {
      const stream = client.sse.detectTags(rUri, { schemaId, categories });

      stream.onProgress((progress: any) => {
        setTagDetectionProgress({
          status: progress.status,
          percentage: progress.percentage,
          message: progress.message,
          currentCategory: progress.currentCategory
        });
      });

      stream.onComplete((result: any) => {
        setTagDetectionProgress({
          status: 'complete',
          percentage: 100,
          message: `Created ${result.tagsCreated} tags`
        });
        setIsDetectingTags(false);
        refetchAnnotations();
        showSuccess(`Created ${result.tagsCreated} tags`);
      });

      stream.onError((error: any) => {
        setTagDetectionProgress(null);
        setIsDetectingTags(false);
        showError(`Tag detection failed: ${error.message}`);
      });
    } catch (error) {
      setIsDetectingTags(false);
      setTagDetectionProgress(null);
      showError('Failed to start tag detection');
    }
  }, [client, rUri, refetchAnnotations, showSuccess, showError]);

  // Manual tag creation handler
  const handleCreateTag = useCallback(async (
    selection: { exact: string; start: number; end: number },
    schemaId: string,
    category: string
  ) => {
    try {
      // Create tag annotation with dual-body structure
      await createAnnotation(
        rUri,
        'tagging',
        [
          {
            type: 'TextPositionSelector',
            start: selection.start,
            end: selection.end
          },
          {
            type: 'TextQuoteSelector',
            exact: selection.exact
          }
        ],
        [
          {
            type: 'TextualBody',
            purpose: 'tagging',
            value: category
          },
          {
            type: 'TextualBody',
            purpose: 'describing',
            value: schemaId
          }
        ]
      );

      setPendingTagSelection(null);
      refetchAnnotations();
      showSuccess(`Tag "${category}" created`);
    } catch (error) {
      console.error('Failed to create tag:', error);
      showError('Failed to create tag');
    }
  }, [createAnnotation, rUri, refetchAnnotations, showSuccess, showError]);

  // Real-time document events for collaboration - document is guaranteed to exist here
  const { status: eventStreamStatus, isConnected, eventCount, lastEvent } = useResourceEvents({
    rUri,
    autoConnect: true,  // Document exists, safe to connect

    // Annotation events - use debounced invalidation to batch rapid updates
    onAnnotationAdded: useCallback((event) => {
      debouncedInvalidateAnnotations();
    }, [debouncedInvalidateAnnotations]),

    onAnnotationRemoved: useCallback((event) => {
      debouncedInvalidateAnnotations();
    }, [debouncedInvalidateAnnotations]),

    onAnnotationBodyUpdated: useCallback((event) => {
      // Optimistically update annotations cache with body operations
      queryClient.setQueryData(QUERY_KEYS.documents.annotations(rUri), (old: any) => {
        if (!old) return old;
        return {
          ...old,
          annotations: old.annotations.map((annotation: any) => {
            // Match by ID portion (handle both URI and internal ID formats)
            // annotation.id is full URI: http://localhost:4000/annotations/{id}
            // event.payload.annotationId is just the ID segment: {id}
            const annotationIdSegment = annotation.id.split('/').pop();
            if (annotationIdSegment === event.payload.annotationId) {
              // Apply body operations
              let bodyArray = Array.isArray(annotation.body) ? [...annotation.body] : [];

              for (const op of event.payload.operations || []) {
                if (op.op === 'add') {
                  bodyArray.push(op.item);
                } else if (op.op === 'remove') {
                  bodyArray = bodyArray.filter((item: any) =>
                    JSON.stringify(item) !== JSON.stringify(op.item)
                  );
                } else if (op.op === 'replace') {
                  const index = bodyArray.findIndex((item: any) =>
                    JSON.stringify(item) === JSON.stringify(op.oldItem)
                  );
                  if (index !== -1) {
                    bodyArray[index] = op.newItem;
                  }
                }
              }

              return {
                ...annotation,
                body: bodyArray,
              };
            }
            return annotation;
          }),
        };
      });

      // Immediately invalidate events to update History Panel
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(rUri) });
    }, [queryClient, rUri]),

    // Document status events
    onDocumentArchived: useCallback((event) => {
      // Reload document to show archived status
      loadDocument();
      showSuccess('This document has been archived');
      debouncedInvalidateAnnotations();
    }, [loadDocument, showSuccess, debouncedInvalidateAnnotations]),

    onDocumentUnarchived: useCallback((event) => {
      // Reload document to show unarchived status
      loadDocument();
      showSuccess('This document has been unarchived');
      debouncedInvalidateAnnotations();
    }, [loadDocument, showSuccess, debouncedInvalidateAnnotations]),

    // Entity tag events
    onEntityTagAdded: useCallback((event) => {
      // Reload document to show updated tags
      loadDocument();
      debouncedInvalidateAnnotations();
    }, [loadDocument, debouncedInvalidateAnnotations]),

    onEntityTagRemoved: useCallback((event) => {
      // Reload document to show updated tags
      loadDocument();
      debouncedInvalidateAnnotations();
    }, [loadDocument, debouncedInvalidateAnnotations]),

    onError: useCallback((error) => {
      console.error('[RealTime] Event stream error:', error);
      // Don't show error toast - will auto-reconnect
    }, []),
  });

  // Document is guaranteed to exist here, render the view
  return (
    <div className="flex flex-col h-full">
      {/* Main Content - Fills remaining height */}
      <div className="flex flex-1 overflow-hidden">
        {/* Document Content - Left Side */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Document Header - Only spans document content width */}
          <div className="flex-none bg-white dark:bg-gray-800 shadow-sm rounded-t-lg">
            <div className="px-6 py-2 flex items-center justify-between gap-4">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                {resource.name}
              </h2>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            <ErrorBoundary
              fallback={(error, reset) => (
                <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
                  <h3 className="text-sm font-semibold text-red-800 dark:text-red-300 mb-1">
                    Error loading document viewer
                  </h3>
                  <p className="text-sm text-red-700 dark:text-red-400">
                    {error.message}
                  </p>
                  <button
                    onClick={reset}
                    className="mt-2 text-sm text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300 underline"
                  >
                    Try again
                  </button>
                </div>
              )}
            >
              {contentLoading ? (
                <div className="p-8 flex items-center justify-center text-gray-600 dark:text-gray-300">
                  Loading document content...
                </div>
              ) : (
                <ResourceViewer
                  resource={{ ...resource, content }}
                annotations={{ highlights, references, assessments, comments, tags }}
                onRefetchAnnotations={() => {
                  // Don't refetch immediately - the SSE event will trigger invalidation after projection is updated
                  // This prevents race condition where we refetch before the event is processed
                }}
                curationMode={annotateMode}
                onCommentCreationRequested={(selection) => {
                  // Store the selection and ensure the Annotations Panel is open
                  setPendingCommentSelection(selection);
                  // Use setActivePanel instead of togglePanel to ensure it opens (not toggles)
                  setActivePanel('annotations');
                }}
                onTagCreationRequested={(selection) => {
                  // Store the selection and ensure the Annotations Panel is open
                  setPendingTagSelection(selection);
                  // Use setActivePanel instead of togglePanel to ensure it opens (not toggles)
                  setActivePanel('annotations');
                }}
                onCommentClick={(commentId) => {
                  // Open Annotations Panel and focus on this comment
                  setActivePanel('annotations');
                  setFocusedCommentId(commentId);
                  // Clear after a short delay to remove highlight
                  setTimeout(() => setFocusedCommentId(null), 3000);
                }}
                onReferenceClick={(referenceId) => {
                  // Open Annotations Panel and focus on this reference
                  setActivePanel('annotations');
                  setFocusedReferenceId(referenceId);
                  // Clear after a short delay to remove highlight
                  setTimeout(() => setFocusedReferenceId(null), 3000);
                }}
                onHighlightClick={(highlightId) => {
                  // Open Annotations Panel and focus on this highlight
                  setActivePanel('annotations');
                  setFocusedHighlightId(highlightId);
                  // Clear after a short delay to remove highlight
                  setTimeout(() => setFocusedHighlightId(null), 3000);
                }}
                onAssessmentClick={(assessmentId) => {
                  // Open Annotations Panel and focus on this assessment
                  setActivePanel('annotations');
                  setFocusedAssessmentId(assessmentId);
                  // Clear after a short delay to remove highlight
                  setTimeout(() => setFocusedAssessmentId(null), 3000);
                }}
                onTagClick={(tagId) => {
                  // Open Annotations Panel and focus on this tag
                  setActivePanel('annotations');
                  setFocusedTagId(tagId);
                  // Clear after a short delay to remove highlight
                  setTimeout(() => setFocusedTagId(null), 3000);
                }}
                generatingReferenceId={generationProgress?.referenceId ?? null}
                onAnnotationHover={setHoveredAnnotationId}
                onCommentHover={setHoveredCommentId}
                hoveredAnnotationId={hoveredAnnotationId}
                hoveredCommentId={hoveredCommentId}
                scrollToAnnotationId={scrollToAnnotationId}
                showLineNumbers={showLineNumbers}
              />
              )}
            </ErrorBoundary>
          </div>

        </div>

        {/* Sidebar */}
        <div className="flex">
          {/* Right Panel - Conditional based on active toolbar panel */}
          <ToolbarPanels
            activePanel={activePanel}
            theme={theme}
            onThemeChange={setTheme}
            showLineNumbers={showLineNumbers}
            onLineNumbersToggle={toggleLineNumbers}
            width={
              activePanel === 'jsonld' ? 'w-[600px]' :
              activePanel === 'annotations' ? 'w-[400px]' :
              'w-64'
            }
          >
            {/* Archived Status */}
            {annotateMode && resource.archived && (
              <div className="bg-gray-100 dark:bg-gray-700 rounded-lg shadow-sm p-3 mb-3">
                <div className="text-gray-600 dark:text-gray-400 text-sm font-medium text-center">
                  📦 Archived
                </div>
              </div>
            )}

            {/* Document Panel */}
            {activePanel === 'document' && (
              <ResourceActionsPanel
                isArchived={resource.archived ?? false}
                onArchive={handleArchive}
                onUnarchive={handleUnarchive}
                onClone={handleClone}
              />
            )}

            {/* Unified Annotations Panel */}
            {activePanel === 'annotations' && !resource.archived && (
              <UnifiedAnnotationsPanel
                highlights={highlights}
                references={references}
                assessments={assessments}
                comments={comments}
                tags={tags}
                onHighlightClick={(annotation) => {
                  setHoveredHighlightId(annotation.id);
                  setTimeout(() => setHoveredHighlightId(null), 1500);
                }}
                onReferenceClick={(annotation) => {
                  setHoveredAnnotationId(annotation.id);
                  setTimeout(() => setHoveredAnnotationId(null), 1500);
                }}
                onAssessmentClick={(annotation) => {
                  setHoveredAssessmentId(annotation.id);
                  setTimeout(() => setHoveredAssessmentId(null), 1500);
                }}
                onCommentClick={(annotation) => {
                  setHoveredCommentId(annotation.id);
                  setTimeout(() => setHoveredCommentId(null), 1500);
                }}
                onTagClick={(annotation) => {
                  setHoveredTagId(annotation.id);
                  setTimeout(() => setHoveredTagId(null), 1500);
                }}
                onHighlightHover={setHoveredHighlightId}
                onReferenceHover={setHoveredAnnotationId}
                onAssessmentHover={setHoveredAssessmentId}
                onCommentHover={setHoveredCommentId}
                onTagHover={setHoveredTagId}
                focusedHighlightId={focusedHighlightId}
                focusedReferenceId={focusedReferenceId}
                focusedAssessmentId={focusedAssessmentId}
                focusedCommentId={focusedCommentId}
                focusedTagId={focusedTagId}
                hoveredHighlightId={hoveredHighlightId}
                hoveredReferenceId={hoveredAnnotationId}
                hoveredAssessmentId={hoveredAssessmentId}
                hoveredCommentId={hoveredCommentId}
                hoveredTagId={hoveredTagId}
                annotateMode={annotateMode}
                {...(primaryMediaType?.startsWith('text/') ? {
                  onDetectHighlights: handleDetectHighlights,
                  onDetectAssessments: handleDetectAssessments,
                  onDetectComments: handleDetectComments,
                  onDetectTags: handleDetectTags,
                } : {})}
                isDetectingHighlights={isDetectingHighlights}
                isDetectingAssessments={isDetectingAssessments}
                isDetectingComments={isDetectingComments}
                isDetectingTags={isDetectingTags}
                highlightDetectionProgress={highlightDetectionProgress}
                assessmentDetectionProgress={assessmentDetectionProgress}
                commentDetectionProgress={commentDetectionProgress}
                tagDetectionProgress={tagDetectionProgress}
                onUpdateComment={async (annotationIdStr, newText) => {
                  // TODO: Implement update comment mutation
                }}
                onCreateComment={async (commentText) => {
                  if (pendingCommentSelection) {
                    await addComment(rUri, pendingCommentSelection, commentText);
                    setPendingCommentSelection(null);
                  }
                }}
                pendingCommentSelection={pendingCommentSelection}
                {...(primaryMediaType?.startsWith('text/') ? { onCreateTag: handleCreateTag } : {})}
                pendingTagSelection={pendingTagSelection}
                resourceId={rUri.split('/').pop() || ''}
              />
            )}

            {/* History Panel */}
            {activePanel === 'history' && (
              <AnnotationHistory
                rUri={rUri}
                hoveredAnnotationId={hoveredAnnotationId}
                onEventHover={handleEventHover}
                onEventClick={handleEventClick}
              />
            )}

            {/* Document Info Panel */}
            {activePanel === 'info' && (
              <ResourceInfoPanel
                highlights={highlights}
                comments={comments}
                assessments={assessments}
                references={references}
                documentEntityTypes={documentEntityTypes}
                documentLocale={getLanguage(resource)}
                primaryMediaType={primaryMediaType}
                primaryByteSize={primaryByteSize}
              />
            )}

            {/* Collaboration Panel */}
            {activePanel === 'collaboration' && (
              <CollaborationPanel
                isConnected={isConnected}
                eventCount={eventCount}
                {...(lastEvent?.timestamp && { lastEventTimestamp: lastEvent.timestamp })}
              />
            )}

            {/* JSON-LD Panel */}
            {activePanel === 'jsonld' && (
              <JsonLdPanel resource={resource} />
            )}
          </ToolbarPanels>

          {/* Toolbar - Always visible on the right */}
          <Toolbar
            context="document"
            activePanel={activePanel}
            annotateMode={annotateMode}
            isArchived={resource.archived ?? false}
            onPanelToggle={togglePanel}
            onAnnotateModeToggle={handleAnnotateModeToggle}
          />
        </div>
      </div>

      {/* Search Resources Modal */}
      <SearchResourcesModal
        isOpen={searchModalOpen}
        onClose={() => {
          setSearchModalOpen(false);
          setPendingReferenceId(null);
        }}
        onSelect={async (documentId: string) => {
          if (pendingReferenceId) {
            try {
              // Extract short annotation ID from the full URI
              const annotationIdShort = pendingReferenceId.split('/').pop();
              if (!annotationIdShort) {
                throw new Error('Invalid reference ID');
              }

              // Construct the nested URI format required by the API
              const resourceIdSegment = rUri.split('/').pop() || '';
              const nestedUri = `${NEXT_PUBLIC_API_URL}/resources/${resourceIdSegment}/annotations/${annotationIdShort}`;

              await updateAnnotationBodyMutation.mutateAsync({
                annotationUri: resourceAnnotationUri(nestedUri),
                data: {
                  resourceId: resourceIdSegment,
                  operations: [{
                    op: 'add',
                    item: {
                      type: 'SpecificResource' as const,
                      source: documentId,
                      purpose: 'linking' as const,
                    },
                  }],
                },
              });
              showSuccess('Reference linked successfully');
              await refetchAnnotations();
              setSearchModalOpen(false);
              setPendingReferenceId(null);
            } catch (error) {
              console.error('Failed to link reference:', error);
              showError('Failed to link reference');
            }
          }
        }}
        searchTerm={searchTerm}
      />
    </div>
  );
}