"use client";

import React, { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { apiService } from '@/lib/api-client';
import { AnnotationRenderer } from '@/components/AnnotationRenderer';
import { SelectionPopup } from '@/components/SelectionPopup';
import { DocumentTags } from '@/components/DocumentTags';
import { buttonStyles } from '@/lib/button-styles';
import type { Document as SemiontDocument } from '@/lib/api-client';
import { 
  mapBackendToFrontendSelection, 
  type HighlightsApiResponse, 
  type ReferencesApiResponse,
  type SelectionsApiResponse
} from '@/lib/api-types';

export default function KnowledgeDocumentPage() {
  const params = useParams();
  const router = useRouter();
  const { data: session, status } = useSession();
  const documentId = params?.id as string;

  const [document, setDocument] = useState<SemiontDocument | null>(null);
  const [highlights, setHighlights] = useState<any[]>([]);
  const [references, setReferences] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Selection popup state
  const [selectedText, setSelectedText] = useState<string>('');
  const [selectionPosition, setSelectionPosition] = useState<{ start: number; end: number } | null>(null);
  const [showSelectionPopup, setShowSelectionPopup] = useState(false);
  const [editingAnnotation, setEditingAnnotation] = useState<{
    id: string;
    type: 'highlight' | 'reference';
    referencedDocumentId?: string;
    referenceType?: string;
    entityType?: string;
  } | null>(null);
  
  // Entity type management state
  const [documentEntityTypes, setDocumentEntityTypes] = useState<string[]>([]);
  
  // Store the document ID in localStorage when viewing
  useEffect(() => {
    if (documentId && typeof window !== 'undefined') {
      localStorage.setItem('lastViewedDocumentId', documentId);
    }
  }, [documentId]);


  // Handle keyboard shortcuts
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Escape key to close popups
      if (e.key === 'Escape') {
        if (showSelectionPopup) {
          setShowSelectionPopup(false);
          setEditingAnnotation(null);
          setSelectedText('');
          setSelectionPosition(null);
        }
      }

      // Ctrl+H or Cmd+H for quick highlight
      if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
        e.preventDefault();
        
        // Get current selection
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return;
        
        const text = selection.toString().trim();
        if (!text) return;
        
        // Get selection range
        const range = selection.getRangeAt(0);
        const container = window.document.querySelector('[data-markdown-container]');
        if (!container) return;
        
        // Calculate position
        const preSelectionRange = window.document.createRange();
        preSelectionRange.selectNodeContents(container);
        preSelectionRange.setEnd(range.startContainer, range.startOffset);
        
        const start = preSelectionRange.toString().length;
        const end = start + text.length;
        
        // Create highlight directly without popup
        try {
          await apiService.selections.saveAsHighlight({
            documentId,
            text,
            position: { start, end }
          });
          await loadSelections();
          
          // Clear the selection
          selection.removeAllRanges();
        } catch (err) {
          console.error('Failed to create highlight:', err);
          alert('Failed to create highlight. Please try again.');
        }
      }
    };
    
    window.document.addEventListener('keydown', handleKeyDown);
    return () => window.document.removeEventListener('keydown', handleKeyDown);
  }, [documentId, showSelectionPopup]);

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

  const loadSelections = async () => {
    try {
      // Load highlights with proper typing
      const highlightsResponse = await apiService.selections.getHighlights(documentId) as unknown as HighlightsApiResponse | SelectionsApiResponse;
      const highlightData = 'highlights' in highlightsResponse ? highlightsResponse.highlights : highlightsResponse.selections;
      const mappedHighlights = highlightData.map(mapBackendToFrontendSelection);
      setHighlights(mappedHighlights);

      // Load references with proper typing
      const referencesResponse = await apiService.selections.getReferences(documentId) as unknown as ReferencesApiResponse | SelectionsApiResponse;
      const referenceData = 'references' in referencesResponse ? referencesResponse.references : referencesResponse.selections;
      const mappedReferences = referenceData.map(mapBackendToFrontendSelection);
      setReferences(mappedReferences);
    } catch (err) {
      console.error('Failed to load selections:', err);
    }
  };

  // Load document and its selections
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
    loadSelections();
  }, [documentId, session, status, router]);

  const handleCreateHighlight = async () => {
    if (!selectionPosition) return;
    if (!session?.backendToken) return;

    try {
      // Ensure auth token is set
      const { LazyTypedAPIClient } = require('@/lib/api-client');
      LazyTypedAPIClient.getInstance().setAuthToken(session.backendToken);
      // If we're editing a reference, delete it first before creating highlight
      if (editingAnnotation && editingAnnotation.type === 'reference') {
        await apiService.selections.delete(editingAnnotation.id);
      }
      
      // Create new highlight (or keep existing one if already a highlight)
      if (!editingAnnotation || editingAnnotation.type === 'reference') {
        await apiService.selections.saveAsHighlight({
          documentId,
          text: selectedText,
          position: selectionPosition
        });
      }
      
      // Reload selections
      await loadSelections();
      
      // Close popup
      setShowSelectionPopup(false);
      setSelectedText('');
      setSelectionPosition(null);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to create/convert highlight:', err);
      alert('Failed to create/convert highlight');
    }
  };

  const handleCreateReference = async (targetDocId?: string, entityType?: string, referenceType?: string) => {
    if (!selectionPosition || !selectedText) return;


    try {
      // If we're editing a highlight, delete it first before creating reference
      if (editingAnnotation && editingAnnotation.type === 'highlight') {
        await apiService.selections.delete(editingAnnotation.id);
      }
      
      // For existing references being updated, delete and recreate
      if (editingAnnotation && editingAnnotation.type === 'reference') {
        await apiService.selections.delete(editingAnnotation.id);
      }
      
      // First create the selection - returns BackendSelection directly  
      // Don't pass type since it's not used by the backend
      const response = await apiService.selections.create({
        documentId,
        text: selectedText,
        position: selectionPosition
      });

      // The response is a BackendSelection object
      const backendSelection = response as unknown as import('@/lib/api-types').BackendSelection;
      
      if (!backendSelection.id) {
        console.error('Selection response missing ID:', backendSelection);
        throw new Error('Failed to get selection ID from response');
      }

      const selectionId = backendSelection.id;

      // If we have a target document, resolve to it
      if (targetDocId) {
        const resolveData: { selectionId: string; targetDocumentId: string; referenceType?: string } = {
          selectionId: selectionId,
          targetDocumentId: targetDocId
        };
        if (referenceType) {
          resolveData.referenceType = referenceType;
        }
        await apiService.selections.resolveToDocument(resolveData);
      } else if (entityType) {
        // Create a new document with the entity type(s)
        const entityTypes = entityType.split(',').map(t => t.trim()).filter(t => t);
        const newDocResponse = await apiService.documents.create({
          name: selectedText,
          content: `# ${selectedText}`,
          contentType: 'text/markdown'
        });
        
        // Set entity types on the new document
        if (newDocResponse.document?.id && entityTypes.length > 0) {
          await apiService.documents.update(newDocResponse.document.id, {
            entityTypes: entityTypes
          });
        }
        
        // Now resolve the selection to this new document
        if (newDocResponse.document?.id) {
          const resolveData: { selectionId: string; targetDocumentId: string; referenceType?: string } = {
            selectionId: selectionId,
            targetDocumentId: newDocResponse.document.id
          };
          if (referenceType) {
            resolveData.referenceType = referenceType;
          }
          await apiService.selections.resolveToDocument(resolveData);
        }
      }

      // Reload selections
      await loadSelections();
      
      // Close popup
      setShowSelectionPopup(false);
      setSelectedText('');
      setSelectionPosition(null);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to create reference - Full error:', err);
      if (err instanceof Error) {
        console.error('Error message:', err.message);
        console.error('Error stack:', err.stack);
      }
      alert(`Failed to create reference: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };


  const handleDeleteAnnotation = async (id: string) => {

    try {
      await apiService.selections.delete(id);
      await loadSelections();
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to delete annotation:', err);
    }
  };

  const handleWikiLinkClick = async (pageName: string) => {

    // Search for a document with this name
    try {
      const response = await apiService.documents.search(pageName, 1);
      if (response.documents.length > 0 && response.documents[0]) {
        router.push(`/know/document/${response.documents[0].id}`);
      } else {
        // Optionally create a new document or show a "not found" message
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
      alert(`Failed to navigate to wiki link: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const handleTextSelection = (text: string, position: { start: number; end: number }) => {
    setSelectedText(text);
    setSelectionPosition(position);
    setShowSelectionPopup(true);
  };

  const handleAnnotationClick = (annotation: any) => {
    // If it's a reference, navigate to the referenced document
    if (annotation.type === 'reference' && annotation.referencedDocumentId) {
      router.push(`/know/document/${annotation.referencedDocumentId}`);
      return;
    }
    
    // Otherwise, show the editing popup
    setEditingAnnotation({
      id: annotation.id,
      type: annotation.type,
      referencedDocumentId: annotation.referencedDocumentId,
      referenceType: annotation.referenceType,
      entityType: annotation.entityType
    });
    setSelectedText(annotation.text || '');
    // Use selectionData for position information
    if (annotation.selectionData) {
      setSelectionPosition({ 
        start: annotation.selectionData.offset, 
        end: annotation.selectionData.offset + annotation.selectionData.length 
      });
    }
    setShowSelectionPopup(true);
  };

  const handleAnnotationRightClick = (annotation: any, event: React.MouseEvent) => {
    event.preventDefault();
    // For right-click, always show the editing popup
    setEditingAnnotation({
      id: annotation.id,
      type: annotation.type,
      referencedDocumentId: annotation.referencedDocumentId,
      referenceType: annotation.referenceType,
      entityType: annotation.entityType
    });
    setSelectedText(annotation.text || '');
    // Use selectionData for position information
    if (annotation.selectionData) {
      setSelectionPosition({ 
        start: annotation.selectionData.offset, 
        end: annotation.selectionData.offset + annotation.selectionData.length 
      });
    }
    setShowSelectionPopup(true);
  };

  const updateDocumentTags = async (tags: string[]) => {

    try {
      await apiService.documents.update(documentId, {
        entityTypes: tags
      });
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
          <AnnotationRenderer
          content={document.content}
          contentType="markdown"
          highlights={highlights}
          references={references}
          onWikiLinkClick={handleWikiLinkClick}
          {...(!document.archived && { 
            onTextSelect: handleTextSelection,
            onAnnotationRightClick: (annotation, x, y) => {
              handleAnnotationRightClick(annotation, { clientX: x, clientY: y, preventDefault: () => {} } as React.MouseEvent);
            }
          })}
          onHighlightClick={(highlight) => {
            handleAnnotationClick(highlight);
          }}
          onReferenceClick={(reference) => {
            handleAnnotationClick(reference);
          }}
        />
        
        {showSelectionPopup && selectedText && (
          <SelectionPopup
            selectedText={selectedText}
            sourceDocumentId={documentId}
            onCreateHighlight={handleCreateHighlight}
            onCreateReference={handleCreateReference}
            onClose={() => {
              setShowSelectionPopup(false);
              setSelectedText('');
              setSelectionPosition(null);
              setEditingAnnotation(null);
            }}
            isEditMode={!!editingAnnotation}
            {...(editingAnnotation && { existingAnnotation: editingAnnotation })}
            {...(editingAnnotation && {
              onDelete: async (annotationId: string) => {
                await handleDeleteAnnotation(annotationId);
                setShowSelectionPopup(false);
                setEditingAnnotation(null);
              }
            })}
          />
        )}
        </div>

        {/* Document Tags sidebar */}
        <div className="w-64">
          <DocumentTags 
            documentId={documentId}
            initialTags={documentEntityTypes}
            onUpdate={async (tags) => {
              setDocumentEntityTypes(tags);
              await updateDocumentTags(tags);
            }}
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
                    // Pass the token via URL parameter
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