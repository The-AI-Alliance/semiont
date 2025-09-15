"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { apiService } from '@/lib/api-client';
import { DocumentViewer } from '@/components/document/DocumentViewer';
import { DocumentTags } from '@/components/DocumentTags';
import { buttonStyles } from '@/lib/button-styles';
import type { Document as SemiontDocument } from '@/lib/api-client';
import { useOpenDocuments } from '@/contexts/OpenDocumentsContext';
import { useDocumentAnnotations } from '@/contexts/DocumentAnnotationsContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useToast } from '@/components/Toast';

export default function KnowledgeDocumentPage() {
  const params = useParams();
  const router = useRouter();
  const { data: session, status } = useSession();
  const documentId = params?.id as string;
  const { addDocument } = useOpenDocuments();
  const { highlights, references } = useDocumentAnnotations();
  const { showError, showSuccess } = useToast();

  const [document, setDocument] = useState<SemiontDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [documentEntityTypes, setDocumentEntityTypes] = useState<string[]>([]);
  const [referencedBy, setReferencedBy] = useState<any[]>([]);
  const [referencedByLoading, setReferencedByLoading] = useState(false);

  // Check authentication status  
  const isAuthenticated = !!session?.backendToken;
  const authLoading = status === 'loading';

  // Redirect to sign-in if not authenticated (after loading)
  useEffect(() => {
    if (status !== 'loading' && !session) {
      router.push('/auth/signin');
    }
  }, [status, session, router]);

  // Load document - memoized to prevent recreating on every render
  const loadDocument = useCallback(async () => {
    if (!isAuthenticated || !documentId) return;
    
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
  }, [documentId, isAuthenticated, session]);

  // Load incoming references - memoized
  const loadReferencedBy = useCallback(async () => {
    if (!isAuthenticated || !documentId) return;
    
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
  }, [documentId, isAuthenticated]);

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

  // Loading state
  if (authLoading || loading) {
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
    <div className="space-y-6">
      {/* Document Header */}
      <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 rounded-lg">
        <div className="px-6 py-4">
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
        <div className="flex-1 bg-white dark:bg-gray-800 rounded-lg shadow-sm p-8">
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
            />
          </ErrorBoundary>
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 text-sm text-gray-500 dark:text-gray-400">
            Last updated: {new Date(document.updatedAt).toLocaleDateString()}
          </div>
        </div>

        {/* Document Tags sidebar */}
        <div className="w-64">
          <DocumentTags 
            documentId={documentId}
            initialTags={documentEntityTypes}
            onUpdate={updateDocumentTags}
            disabled={document.archived || false}
          />
        
          {/* Statistics */}
          <div className="mt-4 bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
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
        
          {/* Referenced by */}
          <div className="mt-4 bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
              Referenced by
              {referencedByLoading && (
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">(loading...)</span>
              )}
            </h3>
            {referencedBy.length > 0 ? (
              <div className="space-y-2">
                {referencedBy.map((ref: any) => (
                  <div key={ref.id} className="text-xs">
                    <Link
                      href={`/know/document/${ref.documentId}`}
                      className="text-blue-600 dark:text-blue-400 hover:underline block"
                    >
                      {ref.documentName || 'Untitled Document'}
                    </Link>
                    <span className="text-gray-500 dark:text-gray-400 italic">
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
        
          {/* Cloned From */}
          {document.sourceDocumentId && document.creationMethod === 'clone' && (
            <div className="mt-4 bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Provenance</h3>
              <div className="text-xs text-gray-600 dark:text-gray-400">
                <span>Cloned from: </span>
                <Link
                  href={`/know/document/${document.sourceDocumentId}`}
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  View original
                </Link>
              </div>
            </div>
          )}
        
          {/* Archive Status */}
          <div className="mt-4 bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Manage</h3>
            {document.archived && (
              <div className="mb-3 px-3 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full text-sm font-medium text-center">
                Archived
              </div>
            )}
            <div className="space-y-2">
              <button
                onClick={handleArchiveToggle}
                className={`${buttonStyles.secondary.base} w-full`}
              >
                {document.archived ? 'Unarchive' : 'Archive'}
              </button>
              <button
                onClick={handleClone}
                className={`${buttonStyles.secondary.base} w-full`}
              >
                Clone
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}