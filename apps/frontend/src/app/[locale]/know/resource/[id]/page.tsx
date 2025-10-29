"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { NEXT_PUBLIC_API_URL } from '@/lib/env';
import { useParams } from 'next/navigation';
import { useRouter } from '@/i18n/routing';
import { useLocale } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { resources } from '@/lib/api/resources';
import { entityTypes } from '@/lib/api/entity-types';
import { QUERY_KEYS } from '@/lib/query-keys';
import { ResourceViewer } from '@/components/resource/ResourceViewer';
import { ResourceTagsInline } from '@/components/ResourceTagsInline';
import { ProposeEntitiesModal } from '@/components/modals/ProposeEntitiesModal';
import { buttonStyles } from '@/lib/button-styles';
import type { components } from '@semiont/api-client';
import { getResourceId, getLanguage, getPrimaryMediaType } from '@/lib/resource-helpers';

type SemiontResource = components['schemas']['ResourceDescriptor'];
import { useOpenResources } from '@/contexts/OpenResourcesContext';
import { useResourceAnnotations } from '@/contexts/ResourceAnnotationsContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useToast } from '@/components/Toast';
import { useAuthenticatedAPI } from '@/hooks/useAuthenticatedAPI';
import { useDetectionProgress } from '@/hooks/useDetectionProgress';
import { DetectionProgressWidget } from '@/components/DetectionProgressWidget';
import { useGenerationProgress } from '@/hooks/useGenerationProgress';
import { AnnotationHistory } from '@/components/resource/AnnotationHistory';
import { useTheme } from '@/hooks/useTheme';
import { useToolbar } from '@/hooks/useToolbar';
import { useLineNumbers } from '@/hooks/useLineNumbers';
import { useResourceEvents } from '@/hooks/useResourceEvents';
import { useDebouncedCallback } from '@/hooks/useDebounce';
import { DetectPanel } from '@/components/resource/panels/DetectPanel';
import { ResourceInfoPanel } from '@/components/resource/panels/ResourceInfoPanel';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { CollaborationPanel } from '@/components/resource/panels/CollaborationPanel';
import { ResourceActionsPanel } from '@/components/resource/panels/ResourceActionsPanel';
import { JsonLdPanel } from '@/components/resource/panels/JsonLdPanel';
import { Toolbar } from '@/components/Toolbar';
import { extractAnnotationId, compareAnnotationIds } from '@semiont/api-client';

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
  const resourceId = decodeURIComponent(params?.id as string);
  const { data: session } = useSession();

  // Load resource data - this is the ONLY hook before early returns
  const {
    data: docData,
    isLoading,
    isError,
    error,
    refetch: refetchDocument
  } = resources.get.useQuery(resourceId);

  // Log error for debugging
  useEffect(() => {
    if (isError && !isLoading) {
      console.error(`[Document] Failed to load resource ${resourceId}:`, error);
    }
  }, [isError, isLoading, resourceId, error]);

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

  return <ResourceView resource={resource} resourceId={resourceId} refetchDocument={refetchDocument} />;
}

// Main resource view - resource is guaranteed to exist
function ResourceView({
  resource,
  resourceId,
  refetchDocument
}: {
  resource: SemiontResource;
  resourceId: string;
  refetchDocument: () => Promise<unknown>;
}) {
  const router = useRouter();
  const { data: session } = useSession();
  const locale = useLocale();
  const { addResource } = useOpenResources();
  const { triggerSparkleAnimation, clearNewAnnotationId, convertHighlightToReference, convertReferenceToHighlight } = useResourceAnnotations();
  const { showError, showSuccess } = useToast();
  const { fetchAPI } = useAuthenticatedAPI();
  const queryClient = useQueryClient();

  // Fetch document content separately
  const [content, setContent] = useState<string>('');
  const [contentLoading, setContentLoading] = useState(true);

  useEffect(() => {
    const loadContent = async () => {
      try {
        // Get the primary representation's mediaType from the resource
        const mediaType = getPrimaryMediaType(resource) || 'text/plain';

        const response = await fetch(`${NEXT_PUBLIC_API_URL}/resources/${encodeURIComponent(resourceId)}`, {
          headers: {
            'Authorization': `Bearer ${session?.backendToken}`,
            'Accept': mediaType,
          },
        });
        if (response.ok) {
          const text = await response.text();
          setContent(text);
        } else {
          showError('Failed to load resource representation');
        }
      } catch (error) {
        console.error('Failed to fetch representation:', error);
        showError('Failed to load resource representation');
      } finally {
        setContentLoading(false);
      }
    };
    loadContent();
  }, [resourceId, resource, session?.backendToken, showError]);

  // Fetch all annotations with a single request
  const { data: annotationsData, refetch: refetchAnnotations } = resources.annotations.useQuery(resourceId);
  const annotations = annotationsData?.annotations || [];

  // Filter by motivation client-side
  type Annotation = components['schemas']['Annotation'];
  const highlights = annotations.filter((a: Annotation) => a.motivation === 'highlighting');
  const references = annotations.filter((a: Annotation) => a.motivation === 'linking');

  // Create debounced invalidation for real-time events (batches rapid updates)
  // Using React Query's invalidateQueries is the best practice - it invalidates cache
  // and triggers automatic refetch for all components using those queries
  const debouncedInvalidateAnnotations = useDebouncedCallback(
    () => {
      // Invalidate annotations and events queries using type-safe query keys
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.annotations(resourceId) });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(resourceId) });
    },
    500 // Wait 500ms after last event before invalidating (batches rapid updates)
  );
  const { data: referencedByData, isLoading: referencedByLoading } = resources.referencedBy.useQuery(resourceId);
  const referencedBy = referencedByData?.referencedBy || [];

  // Derived state
  const documentEntityTypes = resource.entityTypes || [];

  // Get entity types for detection
  const { data: entityTypesData } = entityTypes.all.useQuery();
  const allEntityTypes = entityTypesData?.entityTypes || [];

  // Set up mutations
  const updateDocMutation = resources.update.useMutation();
  const createDocMutation = resources.create.useMutation();
  const generateCloneTokenMutation = resources.generateCloneToken.useMutation();

  const [annotateMode, setAnnotateMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('annotateMode') === 'true';
    }
    return false;
  });
  const { theme, setTheme } = useTheme();
  const { activePanel, togglePanel } = useToolbar({ persistToStorage: true });
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  const [scrollToAnnotationId, setScrollToAnnotationId] = useState<string | null>(null);

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
    if (resource && resourceId) {
      addResource(resourceId, resource.name);
      localStorage.setItem('lastViewedDocumentId', resourceId);
    }
  }, [resource, resourceId, addResource]);

  // Handle wiki link clicks - memoized
  const handleWikiLinkClick = useCallback(async (pageName: string) => {
    try {
      // Search for the resource using authenticated API
      const response = await fetchAPI(`/api/resources/search?q=${encodeURIComponent(pageName)}&limit=1`) as any;

      if (response.resources?.length > 0 && response.resources[0]) {
        // Resource found - navigate to it
        router.push(`/know/resource/${encodeURIComponent(response.resources[0].id)}`);
      } else {
        // Resource not found - offer to create it
        if (confirm(`Resource "${pageName}" not found. Would you like to create it?`)) {
          const newDoc = await createDocMutation.mutateAsync({
            name: pageName,
            content: `# ${pageName}\n\nThis page was created from a wiki link.`,
            format: 'text/markdown',
            entityTypes: []
          });
          const resourceId = getResourceId(newDoc.resource);
          if (resourceId) {
            router.push(`/know/resource/${encodeURIComponent(resourceId)}`);
          }
        }
      }
    } catch (err) {
      console.error('Failed to navigate to wiki link:', err);
      showError('Failed to navigate to wiki link');
    }
  }, [router, createDocMutation, showError, fetchAPI]);

  // Update document tags - memoized
  const updateDocumentTags = useCallback(async (tags: string[]) => {
    try {
      await updateDocMutation.mutateAsync({
        id: resourceId,
        data: { entityTypes: tags }
      });
      showSuccess('Document tags updated successfully');
      await refetchDocument();
    } catch (err) {
      console.error('Failed to update document tags:', err);
      showError('Failed to update document tags');
    }
  }, [resourceId, updateDocMutation, refetchDocument, showSuccess, showError]);

  // Handle archive toggle - memoized
  const handleArchive = useCallback(async () => {
    if (!resource) return;

    try {
      await updateDocMutation.mutateAsync({
        id: resourceId,
        data: { archived: true }
      });
      await loadDocument();
      showSuccess('Document archived');
    } catch (err) {
      console.error('Failed to archive document:', err);
      showError('Failed to archive document');
    }
  }, [resource, resourceId, updateDocMutation, loadDocument, showSuccess, showError]);

  const handleUnarchive = useCallback(async () => {
    if (!resource) return;

    try {
      await updateDocMutation.mutateAsync({
        id: resourceId,
        data: { archived: false }
      });
      await loadDocument();
      showSuccess('Document unarchived');
    } catch (err) {
      console.error('Failed to unarchive document:', err);
      showError('Failed to unarchive document');
    }
  }, [resource, resourceId, updateDocMutation, loadDocument, showSuccess, showError]);

  const handleClone = useCallback(async () => {
    try {
      const response = await generateCloneTokenMutation.mutateAsync(resourceId);
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
  }, [resourceId, generateCloneTokenMutation, router, showError]);

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
    resourceId,
    onProgress: (progress) => {
      // When an entity type completes, refetch to show new annotations immediately
      // Use both refetch (for immediate document view update) AND invalidate (for Annotation History)
      refetchAnnotations();
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(resourceId) });
    },
    onComplete: (progress) => {
      // Don't show toast - the widget already shows completion status
      // Final refetch + invalidation when ALL entity types complete
      refetchAnnotations();
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(resourceId) });
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
    console.log('[DocumentPage] handleGenerateDocument called with:', {
      referenceId,
      options,
      locale,
      resourceId
    });

    // Clear CSS sparkle animation if reference was recently created
    // (it may still be in newAnnotationIds with a 6-second timer from creation)
    // We only want the widget sparkle (✨ emoji) during generation, not the CSS pulse
    const apiUrl = NEXT_PUBLIC_API_URL;
    const fullUri = referenceId.includes('/')
      ? referenceId
      : `${apiUrl}/annotations/${referenceId}`;
    clearNewAnnotationId(fullUri);

    // Widget sparkle (✨ emoji) will show automatically during generation via generatingReferenceId
    // Pass language (using locale from Next.js routing) to ensure generated content is in the user's preferred language
    const optionsWithLanguage = { ...options, language: locale };
    console.log('[DocumentPage] Calling startGeneration with:', optionsWithLanguage);
    startGeneration(referenceId, resourceId, optionsWithLanguage);
  }, [startGeneration, resourceId, clearNewAnnotationId, locale]);

  // Real-time document events for collaboration - document is guaranteed to exist here
  const { status: eventStreamStatus, isConnected, eventCount, lastEvent } = useResourceEvents({
    resourceId,
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
      queryClient.setQueryData(QUERY_KEYS.documents.annotations(resourceId), (old: any) => {
        if (!old) return old;
        return {
          ...old,
          annotations: old.annotations.map((annotation: any) => {
            // Match by ID portion (handle both URI and internal ID formats)
            if (compareAnnotationIds(annotation.id, event.payload.annotationId)) {
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
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(resourceId) });
    }, [queryClient, resourceId]),

    // Document status events
    onDocumentArchived: useCallback((event) => {
      console.log('[RealTime] Document archived');
      // Reload document to show archived status
      loadDocument();
      showSuccess('This document has been archived');
      debouncedInvalidateAnnotations();
    }, [loadDocument, showSuccess, debouncedInvalidateAnnotations]),

    onDocumentUnarchived: useCallback((event) => {
      console.log('[RealTime] Document unarchived');
      // Reload document to show unarchived status
      loadDocument();
      showSuccess('This document has been unarchived');
      debouncedInvalidateAnnotations();
    }, [loadDocument, showSuccess, debouncedInvalidateAnnotations]),

    // Entity tag events
    onEntityTagAdded: useCallback((event) => {
      console.log('[RealTime] Entity tag added:', event.payload.entityType);
      // Reload document to show updated tags
      loadDocument();
      debouncedInvalidateAnnotations();
    }, [loadDocument, debouncedInvalidateAnnotations]),

    onEntityTagRemoved: useCallback((event) => {
      console.log('[RealTime] Entity tag removed:', event.payload.entityType);
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
                highlights={highlights}
                references={references}
                onRefetchAnnotations={() => {
                  console.log('[DocumentPage] Annotation mutation - waiting for real-time event to trigger refetch');
                  // Don't refetch immediately - the SSE event will trigger invalidation after projection is updated
                  // This prevents race condition where we refetch before the event is processed
                }}
                onWikiLinkClick={handleWikiLinkClick}
                curationMode={annotateMode}
                onGenerateDocument={handleGenerateDocument}
                generatingReferenceId={generationProgress?.referenceId ?? null}
                onAnnotationHover={setHoveredAnnotationId}
                hoveredAnnotationId={hoveredAnnotationId}
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
            width={activePanel === 'jsonld' ? 'w-[600px]' : 'w-64'}
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

            {/* Detect Panel */}
            {activePanel === 'detect' && !resource.archived && (
              <DetectPanel
                allEntityTypes={allEntityTypes}
                isDetecting={isDetecting}
                detectionProgress={detectionProgress}
                onDetect={handleDetectEntityReferences}
                onCancelDetection={cancelDetection}
              />
            )}

            {/* History Panel */}
            {activePanel === 'history' && (
              <AnnotationHistory
                resourceId={resourceId}
                hoveredAnnotationId={hoveredAnnotationId}
                onEventHover={handleEventHover}
                onEventClick={handleEventClick}
              />
            )}

            {/* Document Info Panel */}
            {activePanel === 'info' && (
              <ResourceInfoPanel
                highlights={highlights}
                references={references}
                referencedBy={referencedBy}
                referencedByLoading={referencedByLoading}
                documentEntityTypes={documentEntityTypes}
                documentLocale={getLanguage(resource)}
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
    </div>
  );
}