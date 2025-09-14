"use client";

import React, { useState, useEffect } from 'react';
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

export default function KnowledgeDocumentPage() {
  const params = useParams();
  const router = useRouter();
  const { data: session, status } = useSession();
  const documentId = params?.id as string;
  const { addDocument } = useOpenDocuments();
  const { highlights, references } = useDocumentAnnotations();

  const [document, setDocument] = useState<SemiontDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [documentEntityTypes, setDocumentEntityTypes] = useState<string[]>([]);

  // Load document
  const loadDocument = async () => {
    try {
      setLoading(true);
      const response = await apiService.documents.get(documentId);
      setDocument(response.document);
      setDocumentEntityTypes(response.document.entityTypes || []);
      setError(null);
    } catch (err) {
      console.error('Failed to load document:', err);
      setError('Failed to load document');
    } finally {
      setLoading(false);
    }
  };

  // Load document when ID changes or session is ready
  useEffect(() => {
    if (status === 'loading') return;
    if (!session?.backendToken) {
      router.push('/auth/signin');
      return;
    }

    // Set the auth token for API calls
    const { LazyTypedAPIClient } = require('@/lib/api-client');
    LazyTypedAPIClient.getInstance().setAuthToken(session.backendToken);

    loadDocument();
  }, [documentId, session, status, router]);

  // Add document to open tabs when it loads
  useEffect(() => {
    if (document && documentId) {
      addDocument(documentId, document.name);
      localStorage.setItem('lastViewedDocumentId', documentId);
    }
  }, [document, documentId, addDocument]);

  // Handle wiki link clicks
  const handleWikiLinkClick = async (pageName: string) => {
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
    }
  };

  // Update document tags
  const updateDocumentTags = async (tags: string[]) => {
    try {
      await apiService.documents.update(documentId, {
        entityTypes: tags
      });
      setDocumentEntityTypes(tags);
    } catch (err) {
      console.error('Failed to update document tags:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">Loading document...</p>
      </div>
    );
  }

  if (error || !document) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-red-600">Failed to load document</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Document Header */}
      <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 rounded-lg">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
              {document.name}
            </h2>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Last updated: {new Date(document.updatedAt).toLocaleDateString()}
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex gap-6">
        {/* Document Content - Left Side */}
        <div className="flex-1 bg-white dark:bg-gray-800 rounded-lg shadow-sm p-8">
          <DocumentViewer
            document={document}
            onWikiLinkClick={handleWikiLinkClick}
          />
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
                onClick={async () => {
                  try {
                    await apiService.documents.update(documentId, {
                      archived: !document.archived
                    });
                    await loadDocument();
                  } catch (err) {
                    console.error('Failed to update archive status:', err);
                    alert('Failed to update archive status');
                  }
                }}
                className={`${buttonStyles.secondary.base} w-full`}
              >
                {document.archived ? 'Unarchive' : 'Archive'}
              </button>
              <button
                onClick={async () => {
                  try {
                    const response = await apiService.documents.clone(documentId);
                    if (response.token) {
                      router.push(`/know/create?mode=clone&token=${encodeURIComponent(response.token)}`);
                    } else {
                      alert('Failed to prepare clone');
                    }
                  } catch (err) {
                    console.error('Failed to clone document:', err);
                    alert('Failed to clone document');
                  }
                }}
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