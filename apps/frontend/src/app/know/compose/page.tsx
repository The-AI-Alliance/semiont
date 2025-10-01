"use client";

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { api } from '@/lib/api-client';
import { buttonStyles } from '@/lib/button-styles';
import { useOpenDocuments } from '@/contexts/OpenDocumentsContext';
import { useToast } from '@/components/Toast';

function ComposeDocumentContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const { addDocument } = useOpenDocuments();
  const { showError, showSuccess } = useToast();
  const mode = searchParams?.get('mode');
  const tokenFromUrl = searchParams?.get('token');
  
  // Reference completion parameters
  const referenceId = searchParams?.get('referenceId');
  const sourceDocumentId = searchParams?.get('sourceDocumentId');
  const nameFromUrl = searchParams?.get('name');
  const entityTypesFromUrl = searchParams?.get('entityTypes');
  const referenceTypeFromUrl = searchParams?.get('referenceType');
  const shouldGenerate = searchParams?.get('generate') === 'true';
  
  const [newDocName, setNewDocName] = useState('');
  const [newDocContent, setNewDocContent] = useState('');
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isClone, setIsClone] = useState(false);
  const [cloneToken, setCloneToken] = useState<string | null>(null);
  const [archiveOriginal, setArchiveOriginal] = useState(true);
  const [isReferenceCompletion, setIsReferenceCompletion] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  // Fetch available entity types
  const { data: entityTypesData } = api.entityTypes.list.useQuery();
  const availableEntityTypes = entityTypesData?.entityTypes || [];

  // Set up mutation hooks
  const generateDocMutation = api.selections.generateDocument.useMutation();
  const createDocMutation = api.documents.create.useMutation();
  const createFromTokenMutation = api.documents.createFromToken.useMutation();
  const resolveToDocMutation = api.selections.resolveToDocument.useMutation();

  // Query for clone mode - only run when we have a token
  const { data: cloneData } = api.documents.getByToken.useQuery(
    tokenFromUrl || '',
    { enabled: mode === 'clone' && !!tokenFromUrl }
  );
  
  // Generate AI content using the backend inference service
  const generateContent = async (documentName: string, entityTypes: string[], referenceType?: string) => {
    setIsGenerating(true);

    try {
      // Check if we have a referenceId to generate from
      if (!referenceId) {
        throw new Error('Cannot generate content: No reference ID provided');
      }

      // Call the backend API to generate document content
      const requestData: { entityTypes?: string[]; prompt?: string } = {};
      if (entityTypes.length > 0) {
        requestData.entityTypes = entityTypes;
      }
      if (referenceType) {
        requestData.prompt = `Create a document that ${referenceType} the source document.`;
      }

      const response = await generateDocMutation.mutateAsync({
        referenceId,
        data: requestData
      });

      if (!response.document || !response.document.content) {
        throw new Error('No content returned from generation service');
      }

      // Use the generated content from the backend
      setNewDocContent(response.document.content);
      // Also update the name if the AI generated a better title
      if (response.document.name && response.document.name !== documentName) {
        setNewDocName(response.document.name);
      }
      showSuccess('Content generated using AI! You can now edit it before saving.');
    } catch (error: any) {
      console.error('Failed to generate content:', error);
      // Re-throw to let caller handle navigation
      throw error;
    } finally {
      setIsGenerating(false);
    }
  };
  
  // Load cloned document data if in clone mode or pre-fill reference completion data
  useEffect(() => {
    const loadInitialData = async () => {
      // Handle reference completion mode
      if (referenceId && sourceDocumentId && nameFromUrl) {
        setIsReferenceCompletion(true);
        setNewDocName(nameFromUrl);
        const entityTypes = entityTypesFromUrl ? entityTypesFromUrl.split(',') : [];
        if (entityTypes.length > 0) {
          setSelectedEntityTypes(entityTypes);
        }

        // Generate content if requested
        // Wait for session to be ready before attempting generation
        if (shouldGenerate && session?.backendToken) {
          try {
            // referenceTypeFromUrl can be null from searchParams, convert to undefined for API
            const referenceType = referenceTypeFromUrl ?? undefined;
            await generateContent(nameFromUrl, entityTypes, referenceType);
          } catch (error) {
            console.error('Failed to generate content:', error);
            showError('Failed to generate content. Returning to source document.');
            // Navigate back to the source document
            router.push(`/know/document/${sourceDocumentId}`);
            return;
          }
        }

        setIsLoading(false);
        return;
      }
      
      // Handle clone mode - data loaded via React Query
      if (mode === 'clone' && cloneData) {
        if (cloneData.sourceDocument) {
          setIsClone(true);
          setCloneToken(tokenFromUrl || null);
          setNewDocName(cloneData.sourceDocument.name);
          setNewDocContent(cloneData.sourceDocument.content);
        } else {
          showError('Invalid or expired clone token');
          router.push('/know/discover');
        }
        setIsLoading(false);
      } else if (mode === 'clone' && !tokenFromUrl) {
        showError('Clone token not found. Please try cloning again.');
        router.push('/know/discover');
      } else {
        setIsLoading(false);
      }
    };
    
    loadInitialData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tokenFromUrl, cloneData, referenceId, sourceDocumentId, nameFromUrl, entityTypesFromUrl, referenceTypeFromUrl, shouldGenerate, session?.backendToken]);

  const handleSaveDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocName.trim()) return;

    setIsCreating(true);
    try {
      let documentId: string;
      let documentName: string;
      
      if (isClone && cloneToken) {
        // Create document from clone token with edited content
        const response = await createFromTokenMutation.mutateAsync({
          token: cloneToken,
          name: newDocName,
          content: newDocContent,
          archiveOriginal: archiveOriginal
        });

        if (!response.document?.id) {
          throw new Error('No document ID returned from server');
        }
        documentId = response.document.id;
        documentName = response.document.name || newDocName;
      } else {
        // Create a new document with entity types
        const response = await createDocMutation.mutateAsync({
          name: newDocName,
          content: newDocContent,
          contentType: 'text/markdown',
          entityTypes: selectedEntityTypes
        });

        if (!response.document?.id) {
          throw new Error('No document ID returned from server');
        }
        documentId = response.document.id;
        documentName = response.document.name || newDocName;

        // If this is a reference completion, update the reference to point to the new document
        if (isReferenceCompletion && referenceId && documentId) {
          try {
            const resolveData: {
              selectionId: string;
              targetDocumentId: string;
              referenceType?: string;
            } = {
              selectionId: referenceId,
              targetDocumentId: documentId
            };
            if (referenceTypeFromUrl) {
              resolveData.referenceType = referenceTypeFromUrl;
            }
            await resolveToDocMutation.mutateAsync(resolveData);
            showSuccess('Reference successfully linked to the new document');
          } catch (error) {
            console.error('Failed to update reference:', error);
            // Don't fail the whole operation, just log the error
            showError('Document created but failed to update reference. You may need to manually link it.');
          }
        }
      }
      
      // Add the new document to open tabs using the context
      addDocument(documentId, documentName);
      
      // Navigate to the new document
      router.push(`/know/document/${documentId}`);
    } catch (error) {
      console.error('Failed to save document:', error);
      showError('Failed to save document. Please try again.');
    } finally {
      setIsCreating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="px-4 py-8">
        <div className="flex items-center justify-center py-20">
          <p className="text-gray-600 dark:text-gray-300">
            {isGenerating ? 'Generating content...' : 'Loading cloned document...'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-8">
      {/* Page Title */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {isClone ? 'Edit Cloned Document' : isReferenceCompletion ? 'Complete Reference' : 'Compose New Document'}
        </h1>
        {(isClone || isReferenceCompletion) && (
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            {isClone
              ? 'Review and edit your cloned document before saving'
              : shouldGenerate ? 'AI-generated content has been created for your reference' : 'Create a document to complete the reference you started'}
          </p>
        )}
        {isReferenceCompletion && (
          <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg">
            <p className="text-sm text-blue-700 dark:text-blue-300">
              This document will be linked to the reference you created.
              {shouldGenerate && ' The content below was generated automatically.'}
            </p>
          </div>
        )}
      </div>

      {/* Create Form */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
        <form onSubmit={handleSaveDocument} className="space-y-6">
          <div>
            <label htmlFor="docName" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Title
            </label>
            <input
              id="docName"
              type="text"
              value={newDocName}
              onChange={(e) => setNewDocName(e.target.value)}
              placeholder="Enter document title..."
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
              required
              disabled={isCreating}
            />
          </div>

          {/* Entity Types Selection */}
          {(!isReferenceCompletion || selectedEntityTypes.length === 0) && (
            <fieldset>
              <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Entity Types (Optional)
              </legend>
              <div
                className="flex flex-wrap gap-2 mb-2"
                role="group"
                aria-describedby="entity-types-description"
              >
                {availableEntityTypes.map((type: string) => {
                  const isSelected = selectedEntityTypes.includes(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => {
                        setSelectedEntityTypes(prev =>
                          prev.includes(type)
                            ? prev.filter(t => t !== type)
                            : [...prev, type]
                        );
                      }}
                      className={`px-3 py-1 rounded-full text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${
                        isSelected
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                      disabled={isCreating}
                      aria-pressed={isSelected}
                      aria-label={`${type} entity type, ${isSelected ? 'selected' : 'not selected'}`}
                    >
                      {type}
                    </button>
                  );
                })}
              </div>
              {selectedEntityTypes.length > 0 && (
                <div
                  className="sr-only"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {selectedEntityTypes.length} entity type{selectedEntityTypes.length !== 1 ? 's' : ''} selected: {selectedEntityTypes.join(', ')}
                </div>
              )}
            </fieldset>
          )}

          {/* Entity Types Display for reference completion */}
          {isReferenceCompletion && selectedEntityTypes.length > 0 && (
            <div role="region" aria-labelledby="selected-entity-types-label">
              <h3 id="selected-entity-types-label" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Entity Types
              </h3>
              <div className="flex flex-wrap gap-2" role="list">
                {selectedEntityTypes.map((type) => (
                  <span
                    key={type}
                    role="listitem"
                    className="px-3 py-1 rounded-full text-sm bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700"
                    aria-label={`Entity type: ${type}`}
                  >
                    {type}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" id="reference-entity-types-description">
                These entity types were selected when creating the reference
              </p>
            </div>
          )}

          {/* Content textarea */}
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
              onClick={() => router.push('/know/discover')}
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
                ? (isClone ? 'Saving...' : isReferenceCompletion ? 'Creating and Linking...' : 'Creating...') 
                : (isClone ? 'Save Cloned Document' : isReferenceCompletion ? 'Create & Link Document' : 'Create Document')}
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