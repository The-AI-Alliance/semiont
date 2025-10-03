"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api, QUERY_KEYS } from '@/lib/api-client';
import { DocumentViewer } from '@/components/document/DocumentViewer';
import { DocumentTagsInline } from '@/components/DocumentTagsInline';
import { ProposeEntitiesModal } from '@/components/modals/ProposeEntitiesModal';
import { buttonStyles } from '@/lib/button-styles';
import type { Document as SemiontDocument } from '@/lib/api-client';
import { useOpenDocuments } from '@/contexts/OpenDocumentsContext';
import { useDocumentAnnotations } from '@/contexts/DocumentAnnotationsContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useToast } from '@/components/Toast';
import { useAuthenticatedAPI } from '@/hooks/useAuthenticatedAPI';
import { useDetectionProgress } from '@/hooks/useDetectionProgress';
import { DetectionProgressWidget } from '@/components/DetectionProgressWidget';
import { useGenerationProgress } from '@/hooks/useGenerationProgress';
import { GenerationProgressWidget } from '@/components/GenerationProgressWidget';
import { AnnotationHistory } from '@/components/document/AnnotationHistory';
import { useDocumentEvents } from '@/hooks/useDocumentEvents';
import { useDebouncedCallback } from '@/hooks/useDebounce';

// Loading state component
function DocumentLoadingState() {
  return (
    <div className="flex items-center justify-center py-20">
      <p className="text-gray-600 dark:text-gray-300">Loading document...</p>
    </div>
  );
}

// Error state component
function DocumentErrorState({
  error,
  onRetry
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 space-y-4">
      <p className="text-red-600 dark:text-red-400">
        {error instanceof Error ? error.message : 'Failed to load document'}
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
export default function KnowledgeDocumentPage() {
  const params = useParams();
  const documentId = decodeURIComponent(params?.id as string);

  // Load document data - this is the ONLY hook before early returns
  const {
    data: docData,
    isLoading,
    isError,
    error,
    refetch: refetchDocument
  } = api.documents.get.useQuery(documentId);

  // Log error for debugging
  useEffect(() => {
    if (isError && !isLoading) {
      console.error(`[Document] Failed to load document ${documentId}:`, error);
    }
  }, [isError, isLoading, documentId, error]);

  // Early return: Loading state
  if (isLoading) {
    return <DocumentLoadingState />;
  }

  // Early return: Error state
  if (isError) {
    return <DocumentErrorState error={error} onRetry={() => refetchDocument()} />;
  }

  // Early return: Document not found
  if (!docData?.document) {
    return <DocumentErrorState error={new Error('Document not found')} onRetry={() => refetchDocument()} />;
  }

  // From here on, TypeScript knows document exists
  const document = docData.document;

  return <DocumentView document={document} documentId={documentId} refetchDocument={refetchDocument} />;
}

// Main document view - document is guaranteed to exist here
function DocumentView({
  document,
  documentId,
  refetchDocument
}: {
  document: SemiontDocument;
  documentId: string;
  refetchDocument: () => Promise<unknown>;
}) {
  const router = useRouter();
  const { addDocument } = useOpenDocuments();
  const { triggerSparkleAnimation, convertHighlightToReference, convertReferenceToHighlight } = useDocumentAnnotations();
  const { showError, showSuccess } = useToast();
  const { fetchAPI } = useAuthenticatedAPI();
  const queryClient = useQueryClient();

  // Now that document exists, we can safely fetch dependent data
  const { data: highlightsData, refetch: refetchHighlights } = api.selections.getHighlights.useQuery(documentId);
  const { data: referencesData, refetch: refetchReferences } = api.selections.getReferences.useQuery(documentId);
  const highlights = highlightsData?.highlights || [];
  const references = referencesData?.references || [];

  // Create debounced invalidation for real-time events (batches rapid updates)
  // Using React Query's invalidateQueries is the best practice - it invalidates cache
  // and triggers automatic refetch for all components using those queries
  const debouncedInvalidateAnnotations = useDebouncedCallback(
    () => {
      // Invalidate highlights, references, and events queries using type-safe query keys
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.highlights(documentId) });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.references(documentId) });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(documentId) });
    },
    500 // Wait 500ms after last event before invalidating (batches rapid updates)
  );

  // Debug logging
  useEffect(() => {
    console.log('[DocumentPage] References data updated:', {
      count: references.length,
      references: references.map((r: { id: string; text: string }) => ({ id: r.id, text: r.text }))
    });
  }, [references]);

  const { data: referencedByData, isLoading: referencedByLoading } = api.documents.getReferencedBy.useQuery(documentId);
  const referencedBy = referencedByData?.referencedBy || [];

  // Derived state
  const documentEntityTypes = document.entityTypes || [];

  // Get entity types for detection
  const { data: entityTypesData } = api.entityTypes.list.useQuery();
  const allEntityTypes = entityTypesData?.entityTypes || [];

  // Set up mutations
  const updateDocMutation = api.documents.update.useMutation();
  const createDocMutation = api.documents.create.useMutation();
  const cloneDocMutation = api.documents.clone.useMutation();

  const [annotateMode, setAnnotateMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('annotateMode') === 'true';
    }
    return false;
  });
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  const [scrollToAnnotationId, setScrollToAnnotationId] = useState<string | null>(null);
  const [activeToolbarPanel, setActiveToolbarPanel] = useState<'history' | 'stats' | 'detect' | null>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('activeToolbarPanel');
      if (saved === 'history' || saved === 'stats' || saved === 'detect') {
        return saved;
      }
    }
    return null;
  });

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

  // Add document to open tabs when it loads
  useEffect(() => {
    if (document && documentId) {
      addDocument(documentId, document.name);
      localStorage.setItem('lastViewedDocumentId', documentId);
    }
  }, [document, documentId, addDocument]);

  // Handle wiki link clicks - memoized
  const handleWikiLinkClick = useCallback(async (pageName: string) => {
    try {
      // Search for the document using authenticated API
      const response = await fetchAPI(`/api/documents/search?q=${encodeURIComponent(pageName)}&limit=1`) as any;

      if (response.documents?.length > 0 && response.documents[0]) {
        // Document found - navigate to it
        router.push(`/know/document/${encodeURIComponent(response.documents[0].id)}`);
      } else {
        // Document not found - offer to create it
        if (confirm(`Document "${pageName}" not found. Would you like to create it?`)) {
          const newDoc = await createDocMutation.mutateAsync({
            name: pageName,
            content: `# ${pageName}\n\nThis page was created from a wiki link.`,
            contentType: 'text/markdown'
          });
          router.push(`/know/document/${encodeURIComponent(newDoc.document.id)}`);
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
        id: documentId,
        data: { entityTypes: tags }
      });
      showSuccess('Document tags updated successfully');
      await refetchDocument();
    } catch (err) {
      console.error('Failed to update document tags:', err);
      showError('Failed to update document tags');
    }
  }, [documentId, updateDocMutation, refetchDocument, showSuccess, showError]);

  // Handle archive toggle - memoized
  const handleArchiveToggle = useCallback(async () => {
    if (!document) return;

    try {
      await updateDocMutation.mutateAsync({
        id: documentId,
        data: { archived: !document.archived }
      });
      await loadDocument();
      showSuccess(document.archived ? 'Document unarchived' : 'Document archived');
    } catch (err) {
      console.error('Failed to update archive status:', err);
      showError('Failed to update archive status');
    }
  }, [document, documentId, updateDocMutation, loadDocument, showSuccess, showError]);

  // Handle clone - memoized
  const handleClone = useCallback(async () => {
    try {
      const response = await cloneDocMutation.mutateAsync(documentId);
      if (response.token) {
        router.push(`/know/compose?mode=clone&token=${encodeURIComponent(response.token)}`);
      } else {
        showError('Failed to prepare document for cloning');
      }
    } catch (err) {
      console.error('Failed to clone document:', err);
      showError('Failed to clone document');
    }
  }, [documentId, cloneDocMutation, router, showError]);

  // Handle annotate mode toggle - memoized
  const handleAnnotateModeToggle = useCallback(() => {
    const newMode = !annotateMode;
    setAnnotateMode(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('annotateMode', newMode.toString());
    }
  }, [annotateMode]);

  // Handle toolbar panel toggle
  const handleToolbarPanelToggle = useCallback((panel: 'history' | 'stats' | 'detect') => {
    setActiveToolbarPanel(current => {
      const newPanel = current === panel ? null : panel;
      if (typeof window !== 'undefined') {
        if (newPanel) {
          localStorage.setItem('activeToolbarPanel', newPanel);
        } else {
          localStorage.removeItem('activeToolbarPanel');
        }
      }
      return newPanel;
    });
  }, []);

  // State for entity types being detected
  const [detectionEntityTypes, setDetectionEntityTypes] = useState<string[]>([]);
  const [lastDetectionLog, setLastDetectionLog] = useState<Array<{ entityType: string; foundCount: number }> | null>(null);

  // Use SSE-based detection progress
  const {
    isDetecting,
    progress: detectionProgress,
    startDetection,
    cancelDetection
  } = useDetectionProgress({
    documentId,
    onProgress: (progress) => {
      // When an entity type completes, refetch to show new references immediately
      // Use both refetch (for immediate document view update) AND invalidate (for Annotation History)
      console.log('[DocumentPage] Detection progress - refetching annotations', progress);
      refetchReferences();
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(documentId) });
    },
    onComplete: (progress) => {
      // Don't show toast - the widget already shows completion status
      // Final refetch + invalidation when ALL entity types complete
      console.log('[DocumentPage] Detection complete - final refetch');
      refetchHighlights();
      refetchReferences();
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(documentId) });

      // Save the log entries for display after completion
      if (progress.completedEntityTypes) {
        setLastDetectionLog(progress.completedEntityTypes);
      }
      setDetectionEntityTypes([]);
    },
    onError: (error) => {
      showError(error);
      setDetectionEntityTypes([]);
    }
  });

  // Use SSE-based document generation progress
  const {
    isGenerating,
    progress: generationProgress,
    startGeneration,
    cancelGeneration,
    clearProgress: clearGenerationProgress
  } = useGenerationProgress({
    onComplete: (progress) => {
      // Don't show toast - the widget already shows completion status
      // Don't auto-navigate, let user click the link when ready

      // Refresh annotations to update the reference with the new resolvedDocumentId
      refetchReferences();

      // After 5 seconds (when widget auto-dismisses), trigger sparkle on the reference
      setTimeout(() => {
        if (progress.referenceId) {
          triggerSparkleAnimation(progress.referenceId);
        }
      }, 5000);
    },
    onError: (error) => {
      // Don't show toast - the widget already shows error status
    }
  });

  // Handle detect entity references - updated for SSE
  const handleDetectEntityReferences = useCallback(async (selectedTypes: string[]) => {
    // Set entity types for display and start detection
    setDetectionEntityTypes(selectedTypes);

    // Start detection with the selected entity types
    setTimeout(() => startDetection(selectedTypes), 100);
  }, [startDetection]);

  // Handle document generation from stub reference
  const handleGenerateDocument = useCallback((referenceId: string, options: { title: string; prompt?: string }) => {
    startGeneration(referenceId, documentId, options);
  }, [startGeneration, documentId]);

  // Real-time document events for collaboration - document is guaranteed to exist here
  const { status: eventStreamStatus, isConnected, eventCount } = useDocumentEvents({
    documentId,
    autoConnect: true,  // Document exists, safe to connect

    // Highlight events - use debounced invalidation to batch rapid updates
    onHighlightAdded: useCallback((event) => {
      console.log('[RealTime] Highlight added:', event.payload);
      debouncedInvalidateAnnotations();
    }, [debouncedInvalidateAnnotations]),

    onHighlightRemoved: useCallback((event) => {
      console.log('[RealTime] Highlight removed:', event.payload);
      debouncedInvalidateAnnotations();
    }, [debouncedInvalidateAnnotations]),

    // Reference events - use debounced invalidation to batch rapid updates
    onReferenceCreated: useCallback((event) => {
      console.log('[RealTime] Reference created:', event.payload);
      debouncedInvalidateAnnotations();
    }, [debouncedInvalidateAnnotations]),

    onReferenceResolved: useCallback((event) => {
      console.log('[RealTime] Reference resolved:', event.payload);
      debouncedInvalidateAnnotations();
    }, [debouncedInvalidateAnnotations]),

    onReferenceDeleted: useCallback((event) => {
      console.log('[RealTime] Reference deleted:', event.payload);
      debouncedInvalidateAnnotations();
    }, [debouncedInvalidateAnnotations]),

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
    <div className="h-screen flex flex-col">
      {/* Main Content - Fills remaining height */}
      <div className="flex-1 flex gap-6 p-6 min-h-0">
        {/* Document Content - Left Side */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Document Header - Only spans document content width */}
          <div className="flex-none bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 rounded-t-lg">
            <div className="px-6 py-2 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                  {document.name}
                </h2>
                {/* Document Tags - inline with title */}
                {documentEntityTypes.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {documentEntityTypes.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded text-xs"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3">
                {/* Clone Button - only show in Annotate Mode */}
                {annotateMode && !document.archived && (
                  <button
                    onClick={handleClone}
                    className={`${buttonStyles.secondary.base} text-xs px-3 py-1`}
                    title="Clone document"
                  >
                    Clone
                  </button>
                )}

                {/* Annotate Mode Toggle */}
                <button
                  onClick={handleAnnotateModeToggle}
                  className={`${
                    annotateMode ? buttonStyles.primary.base : buttonStyles.secondary.base
                  } text-xs px-3 py-1`}
                  title="Toggle annotation mode"
                >
                  {annotateMode ? '✏️ Annotate ON' : '👁️ Annotate OFF'}
                </button>

                {/* Real-time connection indicator */}
                {isConnected && (
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                      Live
                    </span>
                    {eventCount > 0 && (
                      <span className="text-gray-400 dark:text-gray-500">
                        ({eventCount} events)
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="flex-1 bg-white dark:bg-gray-800 rounded-b-lg shadow-sm px-6 py-4 overflow-y-auto">
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
              <DocumentViewer
                document={document}
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
                onAnnotationHover={setHoveredAnnotationId}
                hoveredAnnotationId={hoveredAnnotationId}
                scrollToAnnotationId={scrollToAnnotationId}
              />
            </ErrorBoundary>
          </div>

          {/* Archive/Unarchive Button - below document content */}
          {annotateMode && (
            <div className="mt-3 flex justify-center">
              <button
                onClick={handleArchiveToggle}
                className="text-xs px-3 py-1 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/30 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded-lg transition-colors"
                title={document.archived ? "Unarchive document" : "Archive document"}
              >
                {document.archived ? '📦 Unarchive' : '📦 Archive'}
              </button>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="flex-none flex gap-0">
          {/* Right Panel - Conditional based on active toolbar panel */}
          {activeToolbarPanel && (
            <div className="w-64 flex flex-col overflow-y-auto p-3 bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700">
              {/* Generation Progress Widget - shown at top when active */}
              {generationProgress && (
                <GenerationProgressWidget
                  progress={generationProgress}
                  onCancel={cancelGeneration}
                  onDismiss={clearGenerationProgress}
                />
              )}

              {/* Archived Status */}
              {annotateMode && document.archived && (
                <div className="bg-gray-100 dark:bg-gray-700 rounded-lg shadow-sm p-3 mb-3">
                  <div className="text-gray-600 dark:text-gray-400 text-sm font-medium text-center">
                    📦 Archived
                  </div>
                </div>
              )}

              {/* Detect Panel */}
              {activeToolbarPanel === 'detect' && !document.archived && (
                <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
                  <div className="mb-4">
                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                      Detect References
                    </h3>
                  </div>

                  {/* Show selection UI only when not detecting and no completed log */}
                  {!detectionProgress && !lastDetectionLog && (
                    <>
                      {/* Entity Types Selection */}
                      <div className="mb-4">
                        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                          Select entity types to detect:
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {allEntityTypes.length > 0 ? (
                            allEntityTypes.map((type: string) => (
                              <button
                                key={type}
                                onClick={() => {
                                  setDetectionEntityTypes(prev =>
                                    prev.includes(type)
                                      ? prev.filter(t => t !== type)
                                      : [...prev, type]
                                  );
                                }}
                                className={`px-3 py-1 text-sm rounded-full transition-colors border ${
                                  detectionEntityTypes.includes(type)
                                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700'
                                    : 'bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
                                }`}
                              >
                                {type}
                              </button>
                            ))
                          ) : (
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                              No entity types available
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Selected Count */}
                      {detectionEntityTypes.length > 0 && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 text-center mb-4">
                          {detectionEntityTypes.length} type{detectionEntityTypes.length !== 1 ? 's' : ''} selected
                        </p>
                      )}

                      {/* Start Detection Button */}
                      <button
                        onClick={() => handleDetectEntityReferences(detectionEntityTypes)}
                        disabled={detectionEntityTypes.length === 0}
                        className={`w-full px-4 py-2 rounded-lg transition-colors duration-200 font-medium ${
                          detectionEntityTypes.length > 0
                            ? 'bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white shadow-md hover:shadow-lg'
                            : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
                        }`}
                      >
                        ✨ Start Detection
                      </button>
                    </>
                  )}

                  {/* Detection Progress - shown when active */}
                  {detectionProgress && (
                    <div className="mt-4">
                      <DetectionProgressWidget
                        progress={detectionProgress}
                        onCancel={cancelDetection}
                      />
                    </div>
                  )}

                  {/* Completed detection log - shown after completion */}
                  {!detectionProgress && lastDetectionLog && lastDetectionLog.length > 0 && (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        {lastDetectionLog.map((item, index) => (
                          <div key={index} className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-2">
                            <span className="text-green-600 dark:text-green-400">✓</span>
                            <span className="font-medium">{item.entityType}:</span>
                            <span>{item.foundCount} found</span>
                          </div>
                        ))}
                      </div>
                      <button
                        onClick={() => setLastDetectionLog(null)}
                        className="w-full px-4 py-2 rounded-lg transition-colors duration-200 font-medium bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white shadow-md hover:shadow-lg"
                      >
                        More
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* History Panel */}
              {activeToolbarPanel === 'history' && (
                <AnnotationHistory
                  documentId={documentId}
                  hoveredAnnotationId={hoveredAnnotationId}
                  onEventHover={handleEventHover}
                  onEventClick={handleEventClick}
                />
              )}

              {/* Statistics Panel */}
              {activeToolbarPanel === 'stats' && (
                <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Statistics</h3>
                  <div className="space-y-3 text-sm">
                    {/* Highlights */}
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block">Highlights</span>
                      <span className="font-medium text-gray-900 dark:text-gray-100 text-lg">
                        {highlights.length}
                      </span>
                    </div>

                    {/* References */}
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block">References</span>
                      <span className="font-medium text-gray-900 dark:text-gray-100 text-lg">
                        {references.length}
                      </span>

                      {/* Sub-categories indented */}
                      <div className="ml-4 mt-2 space-y-1.5 text-xs">
                        <div className="flex justify-between">
                          <span className="text-gray-500 dark:text-gray-400">Stub</span>
                          <span className="font-medium text-gray-900 dark:text-gray-100">
                            {references.filter((r: any) => r.referencedDocumentId === null || r.referencedDocumentId === undefined).length}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500 dark:text-gray-400">Resolved</span>
                          <span className="font-medium text-gray-900 dark:text-gray-100">
                            {references.filter((r: any) => r.referencedDocumentId !== null && r.referencedDocumentId !== undefined).length}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Referenced By section */}
                    <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
                      <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                        Referenced by
                        {referencedByLoading && (
                          <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">(loading...)</span>
                        )}
                      </h4>
                      {referencedBy.length > 0 ? (
                        <div className="space-y-2">
                          {referencedBy.map((ref: any) => (
                            <div key={ref.id} className="border border-gray-200 dark:border-gray-700 rounded p-2">
                              <Link
                                href={`/know/document/${encodeURIComponent(ref.documentId)}`}
                                className="text-sm text-blue-600 dark:text-blue-400 hover:underline block font-medium mb-1"
                              >
                                {ref.documentName || 'Untitled Document'}
                              </Link>
                              <span className="text-xs text-gray-500 dark:text-gray-400 italic line-clamp-2">
                                "{ref.selectionData?.text || 'No text'}"
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {referencedByLoading ? 'Loading...' : 'No incoming references'}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Toolbar - Always visible on the right */}
          <div className="w-12 flex flex-col items-center gap-2 py-3 bg-gray-50 dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700">
            {/* Detect Icon - only show in Annotate Mode */}
            {annotateMode && !document.archived && (
              <button
                onClick={() => handleToolbarPanelToggle('detect')}
                className={`p-2 rounded-md transition-colors ${
                  activeToolbarPanel === 'detect'
                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                    : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400'
                }`}
                title="Detect References"
              >
                <span className="text-xl">🔵</span>
              </button>
            )}

            {/* History Icon */}
            <button
              onClick={() => handleToolbarPanelToggle('history')}
              className={`p-2 rounded-md transition-colors ${
                activeToolbarPanel === 'history'
                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                  : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400'
              }`}
              title="History"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>

            {/* Statistics Icon */}
            <button
              onClick={() => handleToolbarPanelToggle('stats')}
              className={`p-2 rounded-md transition-colors ${
                activeToolbarPanel === 'stats'
                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                  : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400'
              }`}
              title="Statistics"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}