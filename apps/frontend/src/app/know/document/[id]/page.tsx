"use client";

import React, { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { apiService, api } from '@/lib/api-client';
import { AnnotationRenderer } from '@/components/AnnotationRenderer';
import { SelectionPopup } from '@/components/SelectionPopup';
import { annotationStyles } from '@/lib/annotation-styles';
import type { Document, Selection } from '@/lib/api-client';
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

  const [document, setDocument] = useState<Document | null>(null);
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
  const [isEditingTags, setIsEditingTags] = useState(false);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [tagSearchQuery, setTagSearchQuery] = useState('');
  const { data: entityTypesData, isLoading: entityTypesLoading, error: entityTypesError } = api.entityTypes.list.useQuery();
  
  // Store the document ID in localStorage when viewing
  useEffect(() => {
    if (documentId && typeof window !== 'undefined') {
      localStorage.setItem('lastViewedDocumentId', documentId);
    }
  }, [documentId]);

  // Handle click outside for dropdowns
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.tag-dropdown-container')) {
        setShowTagDropdown(false);
      }
    };

    if (showTagDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showTagDropdown]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Escape key to close popups
      if (e.key === 'Escape') {
        if (showSelectionPopup) {
          setShowSelectionPopup(false);
          setEditingAnnotation(null);
          setSelectedText('');
          setSelectionPosition(null);
        }
        if (showTagDropdown) {
          setShowTagDropdown(false);
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
  }, [documentId, showSelectionPopup, showTagDropdown]);

  // Load document and its selections
  useEffect(() => {
    if (status === 'loading') return;
    if (!session?.backendToken) {
      router.push('/auth/signin');
      return;
    }

    loadDocument();
    loadSelections();
  }, [documentId, session, status]);

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

  const handleCreateHighlight = async () => {
    if (!selectionPosition) return;

    try {
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
    if (!selectionPosition) return;

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
      const response = await apiService.selections.create({
        documentId,
        text: selectedText,
        position: selectionPosition,
        type: 'reference'
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

  const handleEditAnnotation = async (
    id: string, 
    type: 'highlight' | 'reference',
    targetDocumentId?: string,
    referenceType?: string,
    entityType?: string
  ) => {
    if (type === 'highlight') {
      // For highlights, we just delete and recreate
      await apiService.selections.delete(id);
      await loadSelections();
    } else if (type === 'reference' && targetDocumentId && referenceType) {
      // For references, update the reference
      await apiService.selections.update(id, {
        referencedDocumentId: targetDocumentId,
        referenceType
      });
      
      // If updating entity types for a new document
      if (entityType && !targetDocumentId.startsWith('existing-')) {
        const selection = references.find(r => r.id === id);
        if (selection?.referencedDocumentId) {
          await apiService.documents.update(selection.referencedDocumentId, {
            entityTypes: [entityType]
          });
        }
      }
      
      await loadSelections();
    }
    
    setEditingAnnotation(null);
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
    setSelectedText(annotation.text);
    setSelectionPosition({ start: annotation.start, end: annotation.end });
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
    setSelectedText(annotation.text);
    setSelectionPosition({ start: annotation.start, end: annotation.end });
    setShowSelectionPopup(true);
  };

  const handleAddTag = (tag: string) => {
    if (!documentEntityTypes.includes(tag)) {
      const newTags = [...documentEntityTypes, tag];
      setDocumentEntityTypes(newTags);
      updateDocumentTags(newTags);
    }
    setShowTagDropdown(false);
    setTagSearchQuery('');
  };

  const handleRemoveTag = (tagToRemove: string) => {
    const newTags = documentEntityTypes.filter(tag => tag !== tagToRemove);
    setDocumentEntityTypes(newTags);
    updateDocumentTags(newTags);
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

  const filteredEntityTypes = entityTypesData?.entityTypes.filter(type => 
    type.toLowerCase().includes(tagSearchQuery.toLowerCase()) &&
    !documentEntityTypes.includes(type)
  ) || [];

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
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
              {document.name}
            </h2>
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Last updated: {new Date(document.updatedAt).toLocaleDateString()}
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
          onTextSelect={handleTextSelection}
          onHighlightClick={(highlight) => {
            handleAnnotationClick(highlight);
          }}
          onReferenceClick={(reference) => {
            handleAnnotationClick(reference);
          }}
          onAnnotationRightClick={(annotation, x, y) => {
            handleAnnotationRightClick(annotation, { clientX: x, clientY: y, preventDefault: () => {} } as React.MouseEvent);
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
            onDelete={editingAnnotation ? async () => {
              await handleDeleteAnnotation(editingAnnotation.id);
              setShowSelectionPopup(false);
              setEditingAnnotation(null);
            } : undefined}
          />
        )}
        </div>

        {/* Document Tags sidebar */}
        <div className="w-64">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Document Tags</h3>
            <button
              onClick={() => setIsEditingTags(!isEditingTags)}
              className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              {isEditingTags ? 'Done' : 'Edit'}
            </button>
          </div>
          
          <div className="space-y-2">
            {/* Display existing tags */}
            <div className="flex flex-wrap gap-2">
              {documentEntityTypes.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
                >
                  {tag}
                  {isEditingTags && (
                    <button
                      onClick={() => handleRemoveTag(tag)}
                      className="ml-1 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200"
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
            
            {/* Add tag input */}
            {isEditingTags && (
              <div className="relative tag-dropdown-container">
                <input
                  type="text"
                  placeholder="Add tag..."
                  value={tagSearchQuery}
                  onChange={(e) => {
                    setTagSearchQuery(e.target.value);
                    setShowTagDropdown(true);
                  }}
                  onFocus={() => setShowTagDropdown(true)}
                  className="w-full px-2 py-1 text-xs border rounded bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                
                {showTagDropdown && filteredEntityTypes.length > 0 && (
                  <div className="absolute z-10 w-full mt-1 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md shadow-lg max-h-40 overflow-y-auto">
                    {filteredEntityTypes.map(type => (
                      <button
                        key={type}
                        onClick={() => {
                          handleAddTag(type);
                          setShowTagDropdown(false);
                          setTagSearchQuery('');
                        }}
                        className="w-full px-2 py-1 text-xs text-left hover:bg-gray-100 dark:hover:bg-gray-600"
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        
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
      </div>
    </div>
  </div>
  );
}