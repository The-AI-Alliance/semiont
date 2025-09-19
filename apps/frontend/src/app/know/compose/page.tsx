"use client";

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiService } from '@/lib/api-client';
import { buttonStyles } from '@/lib/button-styles';
import { useOpenDocuments } from '@/contexts/OpenDocumentsContext';
import { useToast } from '@/components/Toast';

function ComposeDocumentContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const [hasGenerated, setHasGenerated] = useState(false);
  
  // Generate dummy AI content
  const generateContent = async (documentName: string, entityTypes: string[], referenceType?: string) => {
    setIsGenerating(true);
    
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Generate dummy content based on the document name and entity types
    const entityTypesList = entityTypes.length > 0 
      ? `\n\n## Entity Types\n${entityTypes.map(type => `- ${type}`).join('\n')}` 
      : '';
    
    const referenceInfo = referenceType 
      ? `\n\n## Reference Type\nThis document ${referenceType} the source document.` 
      : '';
    
    const content = `# ${documentName}

## Overview
This document provides comprehensive information about ${documentName}. It has been generated based on the reference context and entity types provided.

## Description
${documentName} represents a key concept in the knowledge base. This document serves as a definitive reference for understanding its various aspects and relationships with other concepts.${entityTypesList}${referenceInfo}

## Key Points
- Primary characteristic of ${documentName}
- Relationship to other concepts in the knowledge base
- Important implications and applications
- Historical context and development

## Details
### Background
The concept of ${documentName} has evolved significantly over time. Understanding its origins helps in grasping its current relevance and future potential.

### Current Understanding
In the current context, ${documentName} is understood to encompass several important aspects:
1. First major aspect
2. Second major aspect
3. Third major aspect

### Applications
${documentName} finds applications in various domains:
- Domain 1: Description of application
- Domain 2: Description of application
- Domain 3: Description of application

## Related Concepts
- Related concept 1
- Related concept 2
- Related concept 3

## Conclusion
This document provides a foundation for understanding ${documentName}. As knowledge evolves, this document will be updated to reflect new insights and connections.

---
*This content was generated automatically based on the reference context. Please review and edit as needed.*`;
    
    setNewDocContent(content);
    setIsGenerating(false);
    setHasGenerated(true);
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
        
        // Generate content if requested and not already generated
        if (shouldGenerate && !hasGenerated) {
          await generateContent(nameFromUrl, entityTypes, referenceTypeFromUrl || undefined);
          showSuccess('Content generated! You can now edit it before saving.');
        }
        
        setIsLoading(false);
        return;
      }
      
      // Handle clone mode
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
            showError('Invalid or expired clone token');
            router.push('/know/discover');
          }
        } catch (err) {
          console.error('Failed to load clone data:', err);
          showError('Failed to load clone data. Please try again.');
          router.push('/know/discover');
        } finally {
          setIsLoading(false);
        }
      } else if (mode === 'clone' && !tokenFromUrl) {
        showError('Clone token not found. Please try cloning again.');
        router.push('/know/discover');
      } else {
        setIsLoading(false);
      }
    };
    
    loadInitialData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tokenFromUrl, referenceId, sourceDocumentId, nameFromUrl, entityTypesFromUrl, referenceTypeFromUrl, shouldGenerate, hasGenerated]);

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
        // Note: entityTypes would need to be stored separately since the API doesn't accept them here
        // The backend would need to be updated to support entity types on document creation
        const response = await apiService.documents.create({
          name: newDocName,
          content: newDocContent || `# ${newDocName}\n\nStart writing your document here...`,
          contentType: 'text/markdown'
        });
        
        documentId = response.document?.id || '';
        documentName = response.document?.name || newDocName;
        
        // If this is a reference completion, update the reference to point to the new document
        if (isReferenceCompletion && referenceId && documentId) {
          try {
            await apiService.selections.resolveToDocument({
              selectionId: referenceId,
              targetDocumentId: documentId,
              referenceType: referenceTypeFromUrl || 'mentions' // Use the reference type from the original reference creation
            });
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
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          {isClone 
            ? 'Review and edit your cloned document before saving'
            : isReferenceCompletion
            ? shouldGenerate ? 'AI-generated content has been created for your reference' : 'Create a document to complete the reference you started'
            : 'Start a new document in your knowledge base'}
        </p>
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
          
          {/* Entity Types Selection for reference completion */}
          {isReferenceCompletion && selectedEntityTypes.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Entity Types
              </label>
              <div className="flex flex-wrap gap-2">
                {selectedEntityTypes.map((type) => (
                  <span
                    key={type}
                    className="px-3 py-1 rounded-full text-sm bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700"
                  >
                    {type}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                These entity types were selected when creating the reference
              </p>
            </div>
          )}
          
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