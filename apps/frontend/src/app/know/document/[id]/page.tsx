"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiService } from '@/lib/api-client';
import { DocumentViewer } from '@/components/document/DocumentViewer';
import { DocumentTags } from '@/components/DocumentTags';
import { ProposeEntitiesModal } from '@/components/ProposeEntitiesModal';
import { buttonStyles } from '@/lib/button-styles';
import type { Document as SemiontDocument } from '@/lib/api-client';
import { useOpenDocuments } from '@/contexts/OpenDocumentsContext';
import { useDocumentAnnotations } from '@/contexts/DocumentAnnotationsContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useToast } from '@/components/Toast';
import { useDetectionProgress } from '@/hooks/useDetectionProgress';
import { DetectionProgressWidget } from '@/components/DetectionProgressWidget';
import { useGenerationProgress } from '@/hooks/useGenerationProgress';
import { GenerationProgressWidget } from '@/components/GenerationProgressWidget';

export default function KnowledgeDocumentPage() {
  const params = useParams();
  const router = useRouter();
  const documentId = params?.id as string;
  const { addDocument } = useOpenDocuments();
  const { highlights, references, loadAnnotations, triggerSparkleAnimation } = useDocumentAnnotations();
  const { showError, showSuccess } = useToast();

  const [document, setDocument] = useState<SemiontDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [documentEntityTypes, setDocumentEntityTypes] = useState<string[]>([]);
  const [referencedBy, setReferencedBy] = useState<any[]>([]);
  const [referencedByLoading, setReferencedByLoading] = useState(false);
  const [curationMode, setCurationMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('curationMode') === 'true';
    }
    return false;
  });
  const [showProposeEntitiesModal, setShowProposeEntitiesModal] = useState(false);

  // Session is guaranteed by SecureAPIProvider

  // Load document - memoized to prevent recreating on every render
  const loadDocument = useCallback(async () => {
    if (!documentId) return;
    
    try {
      setLoading(true);
      setError(null);
      const response = await apiService.documents.get(documentId);
      setDocument(response.document);
      setDocumentEntityTypes(response.document.entityTypes || []);
    } catch (err) {
      console.error('Failed to load document:', err);
      setError('Failed to load document. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  // Load incoming references - memoized
  const loadReferencedBy = useCallback(async () => {
    if (!documentId) return;
    
    try {
      setReferencedByLoading(true);
      const response = await apiService.documents.getReferencedBy(documentId);
      setReferencedBy(response.referencedBy || []);
    } catch (err) {
      console.error('Failed to load incoming references:', err);
      // Don't show error for this secondary data
    } finally {
      setReferencedByLoading(false);
    }
  }, [documentId]);

  // Load document when authentication is ready
  useEffect(() => {
    loadDocument();
  }, [loadDocument]);

  // Load incoming references when document loads
  useEffect(() => {
    if (document) {
      loadReferencedBy();
    }
  }, [document, loadReferencedBy]);

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
      const response = await apiService.documents.search(pageName, 1);
      if (response.documents.length > 0 && response.documents[0]) {
        router.push(`/know/document/${response.documents[0].id}`);
      } else {
        // Optionally create a new document
        if (confirm(`Document "${pageName}" not found. Would you like to create it?`)) {
          const newDoc = await apiService.documents.create({
            name: pageName,
            content: `# ${pageName}\n\nThis page was created from a wiki link.`,
            contentType: 'text/markdown'
          });
          router.push(`/know/document/${newDoc.document.id}`);
        }
      }
    } catch (err) {
      console.error('Failed to navigate to wiki link:', err);
      setError('Failed to navigate to wiki link');
    }
  }, [router]);

  // Update document tags - memoized
  const updateDocumentTags = useCallback(async (tags: string[]) => {
    try {
      await apiService.documents.update(documentId, {
        entityTypes: tags
      });
      setDocumentEntityTypes(tags);
      showSuccess('Document tags updated successfully');
    } catch (err) {
      console.error('Failed to update document tags:', err);
      showError('Failed to update document tags');
    }
  }, [documentId, showSuccess, showError]);

  // Handle archive toggle - memoized
  const handleArchiveToggle = useCallback(async () => {
    if (!document) return;
    
    try {
      await apiService.documents.update(documentId, {
        archived: !document.archived
      });
      await loadDocument();
      showSuccess(document.archived ? 'Document unarchived' : 'Document archived');
    } catch (err) {
      console.error('Failed to update archive status:', err);
      showError('Failed to update archive status');
    }
  }, [document, documentId, loadDocument, showSuccess, showError]);

  // Handle clone - memoized
  const handleClone = useCallback(async () => {
    try {
      const response = await apiService.documents.clone(documentId);
      if (response.token) {
        router.push(`/know/compose?mode=clone&token=${encodeURIComponent(response.token)}`);
      } else {
        showError('Failed to prepare document for cloning');
      }
    } catch (err) {
      console.error('Failed to clone document:', err);
      showError('Failed to clone document');
    }
  }, [documentId, router, showError]);

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
      loadAnnotations(documentId);
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
      loadAnnotations(documentId);

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
        <div className="px-6 py-2">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            {document.name}
          </h2>
        </div>
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
                onWikiLinkClick={handleWikiLinkClick}
                curationMode={curationMode}
                onGenerateDocument={handleGenerateDocument}
              />
            </ErrorBoundary>
          </div>

          {/* Referenced by - moved to main panel */}
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

          {/* Provenance - moved to main panel */}
          <div className="mt-4 bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Provenance</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-gray-500 dark:text-gray-400 block">Last Updated</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {document.updatedAt && !isNaN(Date.parse(document.updatedAt))
                    ? new Date(document.updatedAt).toLocaleDateString()
                    : '---'}
                </span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block">Created At</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {document.createdAt && !isNaN(Date.parse(document.createdAt))
                    ? new Date(document.createdAt).toLocaleDateString()
                    : '---'}
                </span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400 block">Created By</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">---</span>
              </div>
              {document.creationMethod && (
                <div>
                  <span className="text-gray-500 dark:text-gray-400 block">Creation Method</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100 capitalize">
                    {document.creationMethod}
                  </span>
                </div>
              )}
              {document.sourceDocumentId && document.creationMethod === 'clone' && (
                <div>
                  <span className="text-gray-500 dark:text-gray-400 block">Cloned From</span>
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
          
          {/* Document Tags */}
          <div className="mt-3">
            <DocumentTags
              documentId={documentId}
              initialTags={documentEntityTypes}
              onUpdate={updateDocumentTags}
              disabled={!curationMode || !!document.archived}
            />
          </div>
        
          {/* Statistics */}
          <div className="mt-3 bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Statistics</h3>
            <div className="space-y-2 text-xs text-gray-600 dark:text-gray-400">
              <div className="flex justify-between">
                <span>Highlights</span>
                <span className="font-medium">{highlights.length}</span>
              </div>
              <div className="flex justify-between">
                <span>References</span>
                <span className="font-medium">{references.length}</span>
              </div>
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