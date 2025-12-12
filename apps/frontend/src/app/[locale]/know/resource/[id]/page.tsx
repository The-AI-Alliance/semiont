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
import { getResourceId, getLanguage, getPrimaryMediaType, getPrimaryRepresentation, searchQuery, getAnnotationExactText, entityType } from '@semiont/api-client';
import { groupAnnotationsByType, withHandlers, createDetectionHandler, createCancelDetectionHandler, ANNOTATORS } from '@/lib/annotation-registry';
import { supportsDetection } from '@/lib/resource-utils';

type Motivation = components['schemas']['Motivation'];
import { decodeWithCharset } from '@/lib/text-encoding';

type SemiontResource = components['schemas']['ResourceDescriptor'];
import { useOpenResources } from '@/contexts/OpenResourcesContext';
import { useResourceAnnotations } from '@/contexts/ResourceAnnotationsContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useToast } from '@/components/Toast';
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
  const updateAnnotationBodyMutation = annotationsAPI.updateBody.useMutation();
  const generateCloneTokenMutation = resources.generateCloneToken.useMutation();

  const [annotateMode, setAnnotateMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('annotateMode') === 'true';
    }
    return false;
  });

  // Debug logging
  console.log('[ResourcePage] annotateMode:', annotateMode, 'primaryMediaType:', primaryMediaType, 'isText:', supportsDetection(primaryMediaType));

  const { theme, setTheme } = useTheme();
  const { activePanel, togglePanel, setActivePanel } = useToolbar({ persistToStorage: true });
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  // Unified annotation state (motivation-agnostic)
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  const [scrollToAnnotationId, setScrollToAnnotationId] = useState<string | null>(null);

  // Pending selections for creating annotations
  const [pendingCommentSelection, setPendingCommentSelection] = useState<{ exact: string; start: number; end: number } | null>(null);
  const [pendingTagSelection, setPendingTagSelection] = useState<{ exact: string; start: number; end: number } | null>(null);
  const [pendingReferenceSelection, setPendingReferenceSelection] = useState<{
    exact: string;
    start: number;
    end: number;
    prefix?: string;
    suffix?: string;
    svgSelector?: string;
  } | null>(null);

  // Search state
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [pendingReferenceId, setPendingReferenceId] = useState<string | null>(null);

  // Unified detection state (motivation-based)
  const [detectingMotivation, setDetectingMotivation] = useState<Motivation | null>(null);
  const [motivationDetectionProgress, setMotivationDetectionProgress] = useState<{
    status: string;
    percentage?: number;
    message?: string;
    currentCategory?: string;
    processedCategories?: number;
    totalCategories?: number;
  } | null>(null);

  // SSE stream reference for cancellation
  const detectionStreamRef = React.useRef<any>(null);

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

  // Handle clone - memoized
  const handleClone = useCallback(async () => {
    if (!resource) return;

    try {
      const result = await generateCloneTokenMutation.mutateAsync(rUri);
      const token = result.token;
      const cloneUrl = `${window.location.origin}/know/clone?token=${token}`;

      await navigator.clipboard.writeText(cloneUrl);
      showSuccess('Clone link copied to clipboard');
    } catch (err) {
      console.error('Failed to generate clone token:', err);
      showError('Failed to generate clone link');
    }
  }, [resource, rUri, generateCloneTokenMutation, showSuccess, showError]);

  // Handle annotate mode toggle - memoized
  const handleAnnotateModeToggle = useCallback(() => {
    const newMode = !annotateMode;
    setAnnotateMode(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('annotateMode', newMode.toString());
    }
  }, [annotateMode]);



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

  // Generic detection context for all annotation types
  const detectionContext = {
    client,
    rUri,
    setDetectingMotivation,
    setMotivationDetectionProgress,
    detectionStreamRef,
    refetchAnnotations,
    queryClient,
    showSuccess,
    showError
  };

  // Generic cancel handler (works for all detection types)
  const handleCancelDetection = React.useMemo(
    () => createCancelDetectionHandler({
      detectionStreamRef,
      setDetectingMotivation,
      setMotivationDetectionProgress
    }),
    []
  );

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

  // Handle search for documents to link to reference
  const handleSearchDocuments = useCallback((referenceId: string, searchTerm: string) => {
    setPendingReferenceId(referenceId);
    setSearchTerm(searchTerm);
    setSearchModalOpen(true);
  }, []);

  // Handle unlinking a reference (clearing the body)
  const handleUpdateReference = useCallback(async (referenceId: string, updates: Partial<components['schemas']['Annotation']>) => {
    try {
      // Extract short annotation ID from the full URI
      const annotationIdShort = referenceId.split('/').pop();
      if (!annotationIdShort) {
        throw new Error('Invalid reference ID');
      }

      // Construct the nested URI format required by the API
      const resourceIdSegment = rUri.split('/').pop() || '';
      const nestedUri = `${NEXT_PUBLIC_API_URL}/resources/${resourceIdSegment}/annotations/${annotationIdShort}`;

      // Check if we're clearing the body (unlinking)
      // updates.body will be an empty array [] when unlinking
      const isClearing = Array.isArray(updates.body) && updates.body.length === 0;

      if (isClearing) {
        // Find the actual reference to get its body items
        const reference = references.find(r => r.id === referenceId);
        if (!reference) {
          throw new Error('Reference not found');
        }

        // Extract body items with purpose === 'linking' and create remove operations
        const bodyArray = Array.isArray(reference.body) ? reference.body : [];
        const operations = bodyArray
          .filter((item: any) => item.purpose === 'linking')
          .map((item: any) => ({
            op: 'remove' as const,
            item,
          }));

        if (operations.length === 0) {
          throw new Error('No linking body items found to remove');
        }

        await updateAnnotationBodyMutation.mutateAsync({
          annotationUri: resourceAnnotationUri(nestedUri),
          data: {
            resourceId: resourceIdSegment,
            operations,
          },
        });
        showSuccess('Reference unlinked successfully');
      }

      await refetchAnnotations();
    } catch (error) {
      console.error('Failed to update reference:', error);
      showError('Failed to update reference');
    }
  }, [rUri, references, updateAnnotationBodyMutation, refetchAnnotations, showSuccess, showError]);

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
            purpose: 'classifying',
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
                annotateMode={annotateMode}
                onAnnotateModeToggle={handleAnnotateModeToggle}
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
                onReferenceCreationRequested={(selection: {
                  exact: string;
                  start: number;
                  end: number;
                  prefix?: string;
                  suffix?: string;
                  svgSelector?: string;
                }) => {
                  // Store the selection and ensure the Annotations Panel is open
                  setPendingReferenceSelection(selection);
                  // Use setActivePanel instead of togglePanel to ensure it opens (not toggles)
                  setActivePanel('annotations');
                }}
                onCommentClick={(commentId) => {
                  // Open Annotations Panel and focus on this comment
                  setActivePanel('annotations');
                  setFocusedAnnotationId(commentId);
                  // Clear after a short delay to remove highlight
                  setTimeout(() => setFocusedAnnotationId(null), 3000);
                }}
                onReferenceClick={(referenceId) => {
                  // Open Annotations Panel and focus on this reference
                  setActivePanel('annotations');
                  setFocusedAnnotationId(referenceId);
                  // Clear after a short delay to remove highlight
                  setTimeout(() => setFocusedAnnotationId(null), 3000);
                }}
                onHighlightClick={(highlightId) => {
                  // Open Annotations Panel and focus on this highlight
                  setActivePanel('annotations');
                  setFocusedAnnotationId(highlightId);
                  // Clear after a short delay to remove highlight
                  setTimeout(() => setFocusedAnnotationId(null), 3000);
                }}
                onAssessmentClick={(assessmentId) => {
                  // Open Annotations Panel and focus on this assessment
                  setActivePanel('annotations');
                  setFocusedAnnotationId(assessmentId);
                  // Clear after a short delay to remove highlight
                  setTimeout(() => setFocusedAnnotationId(null), 3000);
                }}
                onTagClick={(tagId) => {
                  // Open Annotations Panel and focus on this tag
                  setActivePanel('annotations');
                  setFocusedAnnotationId(tagId);
                  // Clear after a short delay to remove highlight
                  setTimeout(() => setFocusedAnnotationId(null), 3000);
                }}
                generatingReferenceId={generationProgress?.referenceId ?? null}
                onAnnotationHover={setHoveredAnnotationId}
                onCommentHover={setHoveredAnnotationId}
                hoveredAnnotationId={hoveredAnnotationId}
                hoveredCommentId={hoveredAnnotationId}
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

            {/* Unified Annotations Panel */}
            {activePanel === 'annotations' && !resource.archived && (() => {
              // Create annotators with injected handlers
              const annotators = withHandlers({
                highlight: {
                  onClick: (annotation) => {
                    setHoveredAnnotationId(annotation.id);
                    setTimeout(() => setHoveredAnnotationId(null), 1500);
                  },
                  onHover: setHoveredAnnotationId,
                  ...(supportsDetection(primaryMediaType) ? { onDetect: createDetectionHandler(ANNOTATORS.highlight!, detectionContext) } : {})
                },
                reference: {
                  onClick: (annotation) => {
                    setHoveredAnnotationId(annotation.id);
                    setTimeout(() => setHoveredAnnotationId(null), 1500);
                  },
                  onHover: setHoveredAnnotationId,
                  onCreate: async (entityType?: string) => {
                    if (pendingReferenceSelection) {
                      const selector = pendingReferenceSelection.svgSelector
                        ? { type: 'SvgSelector' as const, value: pendingReferenceSelection.svgSelector }
                        : [
                            {
                              type: 'TextPositionSelector' as const,
                              start: pendingReferenceSelection.start,
                              end: pendingReferenceSelection.end
                            },
                            {
                              type: 'TextQuoteSelector' as const,
                              exact: pendingReferenceSelection.exact,
                              ...(pendingReferenceSelection.prefix && { prefix: pendingReferenceSelection.prefix }),
                              ...(pendingReferenceSelection.suffix && { suffix: pendingReferenceSelection.suffix })
                            }
                          ];

                      await createAnnotation(
                        rUri,
                        'linking',
                        selector,
                        entityType ? [{
                          type: 'TextualBody',
                          purpose: 'tagging',
                          value: entityType
                        }] : []
                      );
                      setPendingReferenceSelection(null);
                      refetchAnnotations();
                    }
                  },
                  ...(supportsDetection(primaryMediaType) ? { onDetect: createDetectionHandler(ANNOTATORS.reference!, detectionContext) } : {})
                },
                assessment: {
                  onClick: (annotation) => {
                    setHoveredAnnotationId(annotation.id);
                    setTimeout(() => setHoveredAnnotationId(null), 1500);
                  },
                  onHover: setHoveredAnnotationId,
                  ...(supportsDetection(primaryMediaType) ? { onDetect: createDetectionHandler(ANNOTATORS.assessment!, detectionContext) } : {})
                },
                comment: {
                  onClick: (annotation) => {
                    setHoveredAnnotationId(annotation.id);
                    setTimeout(() => setHoveredAnnotationId(null), 1500);
                  },
                  onHover: setHoveredAnnotationId,
                  onUpdate: async (annotationIdStr: string, newText: string) => {
                    // TODO: Implement update comment mutation
                  },
                  onCreate: async (commentText: string) => {
                    if (pendingCommentSelection) {
                      await addComment(rUri, pendingCommentSelection, commentText);
                      setPendingCommentSelection(null);
                    }
                  },
                  ...(supportsDetection(primaryMediaType) ? { onDetect: createDetectionHandler(ANNOTATORS.comment!, detectionContext) } : {})
                },
                tag: {
                  onClick: (annotation) => {
                    setHoveredAnnotationId(annotation.id);
                    setTimeout(() => setHoveredAnnotationId(null), 1500);
                  },
                  onHover: setHoveredAnnotationId,
                  ...(supportsDetection(primaryMediaType) ? { onDetect: createDetectionHandler(ANNOTATORS.tag!, detectionContext) } : {}),
                  ...(supportsDetection(primaryMediaType) ? { onCreate: handleCreateTag } : {})
                }
              });

              return (
                <UnifiedAnnotationsPanel
                  annotations={[...highlights, ...references, ...assessments, ...comments, ...tags]}
                  annotators={annotators}
                  focusedAnnotationId={focusedAnnotationId}
                  hoveredAnnotationId={hoveredAnnotationId}
                  annotateMode={annotateMode}
                  detectingMotivation={detectingMotivation}
                  detectionProgress={motivationDetectionProgress}
                  pendingCommentSelection={pendingCommentSelection}
                  pendingTagSelection={pendingTagSelection}
                  pendingReferenceSelection={pendingReferenceSelection}
                  allEntityTypes={allEntityTypes}
                  onGenerateDocument={handleGenerateDocument}
                  onSearchDocuments={handleSearchDocuments}
                  onUpdateReference={handleUpdateReference}
                  onCancelDetection={handleCancelDetection}
                  {...(primaryMediaType ? { mediaType: primaryMediaType } : {})}
                  referencedBy={referencedBy}
                  referencedByLoading={referencedByLoading}
                  resourceId={rUri.split('/').pop() || ''}
                />
              );
            })()}

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
                documentEntityTypes={documentEntityTypes}
                documentLocale={getLanguage(resource)}
                primaryMediaType={primaryMediaType}
                primaryByteSize={primaryByteSize}
                isArchived={resource.archived ?? false}
                onClone={handleClone}
                onArchive={handleArchive}
                onUnarchive={handleUnarchive}
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
            isArchived={resource.archived ?? false}
            onPanelToggle={togglePanel}
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