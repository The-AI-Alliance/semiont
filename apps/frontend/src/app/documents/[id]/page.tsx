"use client";

import React, { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { apiService, api } from '@/lib/api-client';
import { AnnotationRenderer } from '@/components/AnnotationRenderer';
import { SelectionPopup } from '@/components/SelectionPopup';
import { PageLayout } from '@/components/PageLayout';
import { annotationStyles } from '@/lib/annotation-styles';
import type { Document, Selection } from '@/lib/api-client';
import { 
  mapBackendToFrontendSelection, 
  type HighlightsApiResponse, 
  type ReferencesApiResponse,
  type SelectionsApiResponse
} from '@/lib/api-types';

export default function DocumentPage() {
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
  
  // Debug logging
  useEffect(() => {
    console.log('Entity types data:', entityTypesData);
    console.log('Entity types loading:', entityTypesLoading);
    console.log('Entity types error:', entityTypesError);
  }, [entityTypesData, entityTypesLoading, entityTypesError]);

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
      
      console.log('Loaded references with proper types:', mappedReferences);
      setReferences(mappedReferences);
    } catch (err) {
      console.error('Failed to load selections:', err);
    }
  };

  const handleTextSelection = (text: string, position: { start: number; end: number }) => {
    setSelectedText(text);
    setSelectionPosition(position);
    setShowSelectionPopup(true);
  };
  
  // Entity type tag management functions
  const handleAddEntityType = async (entityType: string) => {
    if (documentEntityTypes.includes(entityType)) return;
    
    const newEntityTypes = [...documentEntityTypes, entityType];
    setDocumentEntityTypes(newEntityTypes);
    
    try {
      await apiService.documents.update(documentId, {
        entityTypes: newEntityTypes
      });
    } catch (err) {
      console.error('Failed to update entity types:', err);
      // Revert on error
      setDocumentEntityTypes(documentEntityTypes);
    }
  };
  
  const handleRemoveEntityType = async (entityType: string) => {
    const newEntityTypes = documentEntityTypes.filter(t => t !== entityType);
    setDocumentEntityTypes(newEntityTypes);
    
    try {
      await apiService.documents.update(documentId, {
        entityTypes: newEntityTypes
      });
    } catch (err) {
      console.error('Failed to update entity types:', err);
      // Revert on error
      setDocumentEntityTypes(documentEntityTypes);
    }
  };
  
  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showTagDropdown) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.entity-type-dropdown')) {
        setShowTagDropdown(false);
      }
    };
    
    window.document.addEventListener('click', handleClickOutside);
    return () => window.document.removeEventListener('click', handleClickOutside);
  }, [showTagDropdown]);
  
  // Handle keyboard shortcuts for quick actions
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
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
        }
      }
    };
    
    window.document.addEventListener('keydown', handleKeyDown);
    return () => window.document.removeEventListener('keydown', handleKeyDown);
  }, [documentId]);

  const handleWikiLinkClick = async (pageName: string) => {
    // Search for a document with this name
    try {
      const response = await apiService.documents.search(pageName, 1);
      if (response.documents.length > 0 && response.documents[0]) {
        router.push(`/documents/${response.documents[0].id}`);
      } else {
        // Optionally create a new document or show a "not found" message
        if (confirm(`Document "${pageName}" not found. Would you like to create it?`)) {
          const newDoc = await apiService.documents.create({
            name: pageName,
            content: `# ${pageName}\n\nThis page was created from a wiki link.`,
            contentType: 'text/markdown'
          });
          router.push(`/documents/${newDoc.document.id}`);
        }
      }
    } catch (err) {
      console.error('Failed to navigate to wiki link:', err);
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
      
      // For existing references being updated, we might need to delete and recreate
      // if the target document is changing
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
      console.log('Created selection with ID:', selectionId);

      // If we have a target document, resolve to it
      if (targetDocId) {
        console.log('Resolving to existing document:', targetDocId, 'with selection:', selectionId);
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
        // entityType may be a comma-separated list
        const entityTypes = entityType.split(',').map(t => t.trim()).filter(t => t);
        console.log('Creating new entity document with types:', entityTypes);
        const newDocResponse = await apiService.documents.create({
          name: selectedText,
          content: `# ${selectedText}\n\nThis is an entity${entityTypes.length > 1 ? ' with types' : ' of type'}: ${entityTypes.join(', ')}`,
          contentType: 'text/markdown'
        });
        
        // Now resolve the selection to this new document
        if (newDocResponse.document?.id) {
          console.log('Resolving to new entity document:', newDocResponse.document.id);
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

  if (loading) {
    return (
      <PageLayout>
        <div className="flex items-center justify-center py-20">
          <p className="text-gray-600 dark:text-gray-300">Loading document...</p>
        </div>
      </PageLayout>
    );
  }

  if (error || !document) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-20">
          <p className="text-red-600 dark:text-red-400 mb-4">{error || 'Document not found'}</p>
          <button
            onClick={() => router.push('/')}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-offset-gray-900 transition-colors"
          >
            Go Home
          </button>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout className="bg-gray-50 dark:bg-gray-900">
      {/* Document Header */}
      <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
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
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex gap-6">
          {/* Document Content - Left Side */}
          <div className="flex-1">
            {/* Document Content */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
              <AnnotationRenderer
                content={document.content}
                contentType="markdown"
                highlights={highlights}
                references={references}
                onWikiLinkClick={handleWikiLinkClick}
                onTextSelect={handleTextSelection}
                onHighlightClick={(highlight) => {
                  // Do nothing on regular click
                }}
                onReferenceClick={(reference) => {
                  // Navigate to referenced document if available
                  if (reference.referencedDocumentId) {
                    router.push(`/documents/${reference.referencedDocumentId}`);
                  } else {
                    console.log('Reference clicked:', reference);
                  }
                }}
                onAnnotationRightClick={(annotation, x, y) => {
                  if (annotation.type === 'highlight' || annotation.type === 'reference') {
                    // Set up the editing annotation data
                    const annData = annotation.type === 'highlight' 
                      ? highlights.find(h => h.id === annotation.id)
                      : references.find(r => r.id === annotation.id);
                    
                    if (annData) {
                      setSelectedText(annData.text || annData.selectionData.text);
                      setSelectionPosition({
                        start: annData.selectionData.offset,
                        end: annData.selectionData.offset + annData.selectionData.length
                      });
                      const editAnn: typeof editingAnnotation = {
                        id: annotation.id,
                        type: annotation.type
                      };
                      if (annotation.referencedDocumentId) {
                        editAnn.referencedDocumentId = annotation.referencedDocumentId;
                      }
                      if ((annotation as any).referenceType) {
                        editAnn.referenceType = (annotation as any).referenceType;
                      }
                      if ((annotation as any).entityType) {
                        editAnn.entityType = (annotation as any).entityType;
                      }
                      setEditingAnnotation(editAnn);
                      setShowSelectionPopup(true);
                    }
                  }
                }}
              />
            </div>

            {/* Annotation Legend & Tips */}
            <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
          {(highlights.length > 0 || references.length > 0) && (
            <>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Annotations</h3>
              <div className="flex gap-4 text-xs mb-3">
              {highlights.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className={`inline-block w-4 h-4 ${annotationStyles.highlight.className}`}></span>
                  <span className="text-gray-600 dark:text-gray-400">{highlights.length} Highlight{highlights.length !== 1 ? 's' : ''}</span>
                </div>
              )}
              {references.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className={`inline-block w-4 h-4 ${annotationStyles.documentReference.className}`}></span>
                  <span className="text-gray-600 dark:text-gray-400">{references.length} Reference{references.length !== 1 ? 's' : ''}</span>
                </div>
              )}
            </div>
            </>
          )}
        </div>
          </div>

          {/* Document Tags Sidebar - Right Side */}
          <div className="w-64 flex-shrink-0">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-4 sticky top-1/2 transform -translate-y-1/2">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Document Tags</h3>
                <button
                  onClick={() => setIsEditingTags(!isEditingTags)}
                  className="text-xs px-2 py-1 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
                >
                  {isEditingTags ? 'Done' : 'Edit'}
                </button>
              </div>
              
              <div className="space-y-2">
                {/* Display current tags */}
                {documentEntityTypes.map(entityType => (
                  <div
                    key={entityType}
                    className="flex items-center justify-between px-3 py-1.5 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 rounded-lg text-sm"
                  >
                    <span className="truncate">{entityType}</span>
                    {isEditingTags && (
                      <button
                        onClick={() => handleRemoveEntityType(entityType)}
                        className="ml-2 text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 flex-shrink-0"
                        title="Remove tag"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                
                {/* Add new tag button and dropdown */}
                {isEditingTags && (
                  <div className="relative entity-type-dropdown">
                    <button
                      onClick={() => setShowTagDropdown(!showTagDropdown)}
                      className="w-full px-3 py-1.5 border border-dashed border-gray-400 dark:border-gray-600 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                    >
                      + Add type
                    </button>
                    
                    {/* Dropdown menu */}
                    {showTagDropdown && (
                      <div className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1">
                        {/* Search input */}
                        <div className="px-3 py-2">
                          <input
                            type="text"
                            placeholder="Search types..."
                            value={tagSearchQuery}
                            onChange={(e) => setTagSearchQuery(e.target.value)}
                            className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                            autoFocus
                          />
                        </div>
                        
                        <div className="max-h-48 overflow-y-auto">
                          {/* Show loading state */}
                          {Boolean(entityTypesLoading) && (
                            <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                              Loading entity types...
                            </div>
                          )}
                          
                          {/* Show error state */}
                          {Boolean(entityTypesError) && (
                            <div className="px-3 py-2 text-sm text-red-500 dark:text-red-400">
                              Failed to load entity types
                            </div>
                          )}
                          
                          {/* Show available types */}
                          {!entityTypesLoading && !entityTypesError && entityTypesData?.entityTypes && (
                            <>
                              {entityTypesData.entityTypes
                                .filter(type => !documentEntityTypes.includes(type))
                                .filter(type => 
                                  tagSearchQuery === '' || 
                                  type.toLowerCase().includes(tagSearchQuery.toLowerCase())
                                )
                                .map(type => (
                                  <button
                                    key={type}
                                    onClick={() => {
                                      handleAddEntityType(type);
                                      setShowTagDropdown(false);
                                      setTagSearchQuery('');
                                    }}
                                    className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                                  >
                                    {type}
                                  </button>
                                ))}
                              
                              {/* Show message if no types match filter */}
                              {entityTypesData.entityTypes
                                .filter(type => !documentEntityTypes.includes(type))
                                .filter(type => 
                                  tagSearchQuery === '' || 
                                  type.toLowerCase().includes(tagSearchQuery.toLowerCase())
                                ).length === 0 && (
                                <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                                  {tagSearchQuery ? 'No matching types' : 'All types already added'}
                                </div>
                              )}
                            </>
                          )}
                          
                          {/* Show if no data at all */}
                          {!entityTypesLoading && !entityTypesError && !entityTypesData?.entityTypes && (
                            <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                              No entity types available
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                
                {/* Show placeholder if no tags */}
                {documentEntityTypes.length === 0 && !isEditingTags && (
                  <span className="text-sm text-gray-500 dark:text-gray-400 italic">
                    No entity types assigned
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Selection Popup */}
      {showSelectionPopup && (
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
          onDelete={async (annotationId) => {
            try {
              await apiService.selections.delete(annotationId);
              await loadSelections();
              setShowSelectionPopup(false);
              setEditingAnnotation(null);
            } catch (err) {
              console.error('Failed to delete annotation:', err);
              alert('Failed to delete annotation');
            }
          }}
        />
      )}
    </PageLayout>
  );
}