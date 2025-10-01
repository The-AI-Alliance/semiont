"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api-client';
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

export default function KnowledgeDocumentPage() {
  const params = useParams();
  const router = useRouter();
  const documentId = params?.id as string;
  const { addDocument } = useOpenDocuments();
  const { triggerSparkleAnimation, convertHighlightToReference, convertReferenceToHighlight } = useDocumentAnnotations();
  const { showError, showSuccess } = useToast();
  const { fetchAPI } = useAuthenticatedAPI();

  // Use React Query for annotations data
  const { data: highlightsData, refetch: refetchHighlights } = api.selections.getHighlights.useQuery(documentId);
  const { data: referencesData, refetch: refetchReferences } = api.selections.getReferences.useQuery(documentId);
  const highlights = highlightsData?.selections || [];
  const references = referencesData?.selections || [];

  // Use React Query for document data
  const { data: docData, isLoading: loading, isError, refetch: refetchDocument } = api.documents.get.useQuery(documentId);
  const document = docData?.document || null;
  const error = isError ? 'Failed to load document. Please try again.' : null;
  const documentEntityTypes = document?.entityTypes || [];

  // Use React Query for referenced-by data
  const { data: referencedByData, isLoading: referencedByLoading } = api.documents.getReferencedBy.useQuery(documentId);
  const referencedBy = referencedByData?.referencedBy || [];

  // Set up mutations
  const updateDocMutation = api.documents.update.useMutation();
  const createDocMutation = api.documents.create.useMutation();
  const cloneDocMutation = api.documents.clone.useMutation();

  const [curationMode, setCurationMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('curationMode') === 'true';
    }
    return false;
  });
  const [showProposeEntitiesModal, setShowProposeEntitiesModal] = useState(false);

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
      const response = await fetchAPI(`/api/documents/search?query=${encodeURIComponent(pageName)}&limit=1`) as any;

      if (response.documents?.length > 0 && response.documents[0]) {
        // Document found - navigate to it
        router.push(`/know/document/${response.documents[0].id}`);
      } else {
        // Document not found - offer to create it
        if (confirm(`Document "${pageName}" not found. Would you like to create it?`)) {
          const newDoc = await createDocMutation.mutateAsync({
            name: pageName,
            content: `# ${pageName}\n\nThis page was created from a wiki link.`,
            contentType: 'text/markdown'
          });
          router.push(`/know/document/${newDoc.document.id}`);
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

  // Handle curation mode toggle - memoized
  const handleCurationModeToggle = useCallback(() => {
    const newMode = !curationMode;
    setCurationMode(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('curationMode', newMode.toString());
    }
  }, [curationMode]);

  // State for entity types being detected
  const [detectionEntityTypes, setDetectionEntityTypes] = useState<string[]>([]);

  // Use SSE-based detection progress
  const {
    isDetecting,
    progress: detectionProgress,
    startDetection,
    cancelDetection
  } = useDetectionProgress({
    documentId,
    onComplete: (progress) => {
      // Don't show toast - the widget already shows completion status
      // Reload annotations to show new references with sparkle animation
      refetchHighlights();
      refetchReferences();
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
    // Close modal immediately
    setShowProposeEntitiesModal(false);

    // Set entity types for display and start detection
    setDetectionEntityTypes(selectedTypes);

    // Start detection with the selected entity types
    setTimeout(() => startDetection(selectedTypes), 100);
  }, [startDetection]);

  // Handle document generation from stub reference
  const handleGenerateDocument = useCallback((referenceId: string, options: { title: string; prompt?: string }) => {
    startGeneration(referenceId, options);
  }, [startGeneration]);

  // Real-time document events for collaboration
  const { status: eventStreamStatus, isConnected, eventCount } = useDocumentEvents({
    documentId,

    // Highlight events
    onHighlightAdded: useCallback((event) => {
      console.log('[RealTime] Highlight added:', event.payload);
      // Reload annotations to show new highlight
      refetchHighlights();
    }, [refetchHighlights]),

    onHighlightRemoved: useCallback((event) => {
      console.log('[RealTime] Highlight removed:', event.payload);
      // Reload annotations to remove highlight from UI
      refetchHighlights();
    }, [refetchHighlights]),

    // Reference events
    onReferenceCreated: useCallback((event) => {
      console.log('[RealTime] Reference created:', event.payload);
      // Reload annotations to show new reference
      refetchReferences();
    }, [refetchReferences]),

    onReferenceResolved: useCallback((event) => {
      console.log('[RealTime] Reference resolved:', event.payload);
      // Reload annotations to update reference state
      refetchReferences();
    }, [refetchReferences]),

    onReferenceDeleted: useCallback((event) => {
      console.log('[RealTime] Reference deleted:', event.payload);
      // Reload annotations to remove reference from UI
      refetchReferences();
    }, [refetchReferences]),

    // Document status events
    onDocumentArchived: useCallback((event) => {
      console.log('[RealTime] Document archived');
      // Reload document to show archived status
      loadDocument();
      showSuccess('This document has been archived');
    }, [loadDocument, showSuccess]),

    onDocumentUnarchived: useCallback((event) => {
      console.log('[RealTime] Document unarchived');
      // Reload document to show unarchived status
      loadDocument();
      showSuccess('This document has been unarchived');
    }, [loadDocument, showSuccess]),

    // Entity tag events
    onEntityTagAdded: useCallback((event) => {
      console.log('[RealTime] Entity tag added:', event.payload.entityType);
      // Reload document to show updated tags
      loadDocument();
    }, [loadDocument]),

    onEntityTagRemoved: useCallback((event) => {
      console.log('[RealTime] Entity tag removed:', event.payload.entityType);
      // Reload document to show updated tags
      loadDocument();
    }, [loadDocument]),

    onError: useCallback((error) => {
      console.error('[RealTime] Event stream error:', error);
      // Don't show error toast - will auto-reconnect
    }, []),
  });

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">Loading document...</p>
      </div>
    );
  }

  // Error state
  if (error || !document) {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-4">
        <p className="text-red-600 dark:text-red-400">{error || 'Failed to load document'}</p>
        <button
          onClick={loadDocument}
          className={buttonStyles.secondary.base}
        >
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 pt-6">
      {/* Document Header */}
      <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 rounded-lg">
        <div className="px-6 py-2 flex items-center justify-between">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            {document.name}
          </h2>
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
        {/* Document Tags - inline display */}
        <DocumentTagsInline
          documentId={documentId}
          tags={documentEntityTypes}
          isEditing={false}
          onUpdate={updateDocumentTags}
          disabled={!!document.archived}
        />
      </div>

      {/* Error Message Banner */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Main Content */}
      <div className="flex gap-6">
        {/* Document Content - Left Side */}
        <div className="flex-1">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm px-6 py-4">
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
                  refetchHighlights();
                  refetchReferences();
                }}
                onWikiLinkClick={handleWikiLinkClick}
                curationMode={curationMode}
                onGenerateDocument={handleGenerateDocument}
              />
            </ErrorBoundary>
          </div>

          {/* Statistics */}
          <div className="mt-4 bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Statistics</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-gray-500 dark:text-gray-400 block">Highlights</span>
                <span className="font-medium text-gray-900 dark:text-gray-100 text-lg">
                  {highlights.length}
                </span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block">Total References</span>
                <span className="font-medium text-gray-900 dark:text-gray-100 text-lg">
                  {references.length}
                </span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block">Stub References</span>
                <span className="font-medium text-gray-900 dark:text-gray-100 text-lg">
                  {references.filter((r: any) => r.referencedDocumentId === null || r.referencedDocumentId === undefined).length}
                </span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block">Resolved References</span>
                <span className="font-medium text-gray-900 dark:text-gray-100 text-lg">
                  {references.filter((r: any) => r.referencedDocumentId !== null && r.referencedDocumentId !== undefined).length}
                </span>
              </div>
            </div>
          </div>

          {/* Referenced by */}
          <div className="mt-4 bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
              Referenced by
              {referencedByLoading && (
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">(loading...)</span>
              )}
            </h3>
            {referencedBy.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {referencedBy.map((ref: any) => (
                  <div key={ref.id} className="border border-gray-200 dark:border-gray-700 rounded p-2">
                    <Link
                      href={`/know/document/${ref.documentId}`}
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
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {referencedByLoading ? 'Loading...' : 'No incoming references'}
              </p>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-64 space-y-3">
          {/* Detection Progress Widget - Show at top of sidebar when active */}
          {detectionProgress && (
            <DetectionProgressWidget
              progress={detectionProgress}
              onCancel={cancelDetection}
            />
          )}

          {/* Generation Progress Widget - Show at top of sidebar when active */}
          {generationProgress && (
            <GenerationProgressWidget
              progress={generationProgress}
              onCancel={cancelGeneration}
              onDismiss={clearGenerationProgress}
            />
          )}

          {/* Curation Mode Toggle */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
            <button
              onClick={handleCurationModeToggle}
              className={`${
                curationMode ? buttonStyles.primary.base : buttonStyles.secondary.base
              } w-full`}
              title="Toggle global curation mode"
            >
              {curationMode ? '✏️ Curation Mode ON' : '👁️ Curation Mode OFF'}
            </button>
          </div>

          {/* Archived Status - show above Manage when document is archived */}
          {curationMode && document.archived && (
            <div className="bg-gray-100 dark:bg-gray-700 rounded-lg shadow-sm p-3 mt-3">
              <div className="text-gray-600 dark:text-gray-400 text-sm font-medium text-center">
                📦 Archived
              </div>
            </div>
          )}

          {/* Manage - only show in Curation Mode */}
          {curationMode && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 mt-3">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Manage</h3>
              <div className="space-y-2">
                {document.archived ? (
                  // Archived documents only show Unarchive button
                  <button
                    onClick={handleArchiveToggle}
                    className={`${buttonStyles.secondary.base} w-full`}
                  >
                    Unarchive
                  </button>
                ) : (
                  // Non-archived documents show all actions
                  <>
                    {/* Tags are immutable after creation - can only be set when creating document */}

                    <button
                      onClick={() => setShowProposeEntitiesModal(true)}
                      className={`${buttonStyles.secondary.base} w-full`}
                      title="Automatically detect entity references"
                    >
                      ✨ Detect Entity References
                    </button>

                    <button
                      onClick={handleClone}
                      className={`${buttonStyles.secondary.base} w-full`}
                    >
                      Clone
                    </button>

                    <button
                      onClick={handleArchiveToggle}
                      className={`${buttonStyles.secondary.base} w-full`}
                    >
                      Archive
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Annotation History */}
          <div className="mt-3">
            <AnnotationHistory documentId={documentId} />
          </div>

          {/* Creation */}
          <div className="mt-3 bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Creation</h3>
            <div className="space-y-3 text-sm">
              <div>
                <span className="text-gray-500 dark:text-gray-400 block text-xs">Date</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {document.createdAt && !isNaN(Date.parse(document.createdAt))
                    ? new Date(document.createdAt).toLocaleDateString()
                    : '---'}
                </span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block text-xs">User</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">---</span>
              </div>
              {document.creationMethod && (
                <div>
                  <span className="text-gray-500 dark:text-gray-400 block text-xs">Method</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100 capitalize">
                    {document.creationMethod}
                  </span>
                </div>
              )}
              {document.sourceDocumentId && document.creationMethod === 'clone' && (
                <div>
                  <span className="text-gray-500 dark:text-gray-400 block text-xs">Cloned From</span>
                  <Link
                    href={`/know/document/${document.sourceDocumentId}`}
                    className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                  >
                    View original
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* Detect Entity References Modal */}
      <ProposeEntitiesModal
        isOpen={showProposeEntitiesModal}
        onConfirm={handleDetectEntityReferences}
        onCancel={() => setShowProposeEntitiesModal(false)}
      />
    </div>
  );
}