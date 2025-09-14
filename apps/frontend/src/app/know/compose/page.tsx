"use client";

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiService } from '@/lib/api-client';
import { buttonStyles } from '@/lib/button-styles';
import { useOpenDocuments } from '@/contexts/OpenDocumentsContext';

function ComposeDocumentContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { addDocument } = useOpenDocuments();
  const mode = searchParams?.get('mode');
  const tokenFromUrl = searchParams?.get('token');
  
  const [newDocName, setNewDocName] = useState('');
  const [newDocContent, setNewDocContent] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isClone, setIsClone] = useState(false);
  const [cloneToken, setCloneToken] = useState<string | null>(null);
  const [archiveOriginal, setArchiveOriginal] = useState(true);
  
  // Load cloned document data if in clone mode
  useEffect(() => {
    const loadCloneData = async () => {
      if (mode === 'clone' && tokenFromUrl) {
        try {
          // Fetch the document data using the token
          const response = await apiService.documents.getByToken(tokenFromUrl);
          if (response.sourceDocument) {
            setIsClone(true);
            setCloneToken(tokenFromUrl);
            setNewDocName(response.sourceDocument.name);
            setNewDocContent(response.sourceDocument.content);
          } else {
            alert('Invalid or expired clone token');
            router.push('/know/search');
          }
        } catch (err) {
          console.error('Failed to load clone data:', err);
          alert('Failed to load clone data');
          router.push('/know/search');
        } finally {
          setIsLoading(false);
        }
      } else if (mode === 'clone' && !tokenFromUrl) {
        alert('Clone token not found. Please try cloning again.');
        router.push('/know/search');
      } else {
        setIsLoading(false);
      }
    };
    
    loadCloneData();
  }, [mode, tokenFromUrl, router]);

  const handleSaveDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocName.trim()) return;

    setIsCreating(true);
    try {
      let documentId: string;
      let documentName: string;
      
      if (isClone && cloneToken) {
        // Create document from clone token with edited content
        const response = await apiService.documents.createFromToken({
          token: cloneToken,
          name: newDocName,
          content: newDocContent,
          archiveOriginal: archiveOriginal
        });
        
        documentId = response.document?.id || '';
        documentName = response.document?.name || newDocName;
      } else {
        // Create a new document
        const response = await apiService.documents.create({
          name: newDocName,
          content: newDocContent || `# ${newDocName}\n\nStart writing your document here...`,
          contentType: 'text/markdown'
        });
        
        documentId = response.document?.id || '';
        documentName = response.document?.name || newDocName;
      }
      
      // Add the new document to open tabs using the context
      addDocument(documentId, documentName);
      
      // Navigate to the new document
      router.push(`/know/document/${documentId}`);
    } catch (error) {
      console.error('Failed to save document:', error);
      alert('Failed to save document. Please try again.');
    } finally {
      setIsCreating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="px-4 py-8">
        <div className="flex items-center justify-center py-20">
          <p className="text-gray-600 dark:text-gray-300">Loading cloned document...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-8">
      {/* Page Title */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {isClone ? 'Edit Cloned Document' : 'Compose New Document'}
        </h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          {isClone 
            ? 'Review and edit your cloned document before saving'
            : 'Start a new document in your knowledge base'}
        </p>
      </div>

      {/* Create Form */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
        <form onSubmit={handleSaveDocument} className="space-y-6">
          <div>
            <label htmlFor="docName" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Document Name
            </label>
            <input
              id="docName"
              type="text"
              value={newDocName}
              onChange={(e) => setNewDocName(e.target.value)}
              placeholder="Enter document name..."
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
              required
              disabled={isCreating}
            />
          </div>
          
          <div>
            <label htmlFor="docContent" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {isClone ? 'Document Content' : 'Content'}
            </label>
            <textarea
              id="docContent"
              value={newDocContent}
              onChange={(e) => setNewDocContent(e.target.value)}
              placeholder="Start writing your document content (Markdown supported)..."
              rows={12}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white font-mono text-sm"
              disabled={isCreating}
            />
          </div>
          
          {isClone && (
            <div className="flex items-center">
              <input
                id="archiveOriginal"
                type="checkbox"
                checked={archiveOriginal}
                onChange={(e) => setArchiveOriginal(e.target.checked)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                disabled={isCreating}
              />
              <label htmlFor="archiveOriginal" className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                Archive original document after saving clone
              </label>
            </div>
          )}
          
          <div className="flex gap-4 justify-end">
            <button
              type="button"
              onClick={() => router.push('/know/search')}
              disabled={isCreating}
              className={buttonStyles.tertiary.base}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isCreating || !newDocName.trim()}
              className={buttonStyles.primary.base}
            >
              {isCreating 
                ? (isClone ? 'Saving...' : 'Creating...') 
                : (isClone ? 'Save Cloned Document' : 'Create Document')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function ComposeDocumentPage() {
  return (
    <Suspense fallback={
      <div className="px-4 py-8">
        <div className="flex items-center justify-center py-20">
          <p className="text-gray-600 dark:text-gray-300">Loading...</p>
        </div>
      </div>
    }>
      <ComposeDocumentContent />
    </Suspense>
  );
}