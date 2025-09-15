'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AnnotateView } from './AnnotateView';
import { BrowseView } from './BrowseView';
import { SelectionPopup } from '@/components/SelectionPopup';
import { useDocumentAnnotations } from '@/contexts/DocumentAnnotationsContext';
import type { Document as SemiontDocument } from '@/lib/api-client';

interface Props {
  document: SemiontDocument;
  onWikiLinkClick?: (pageName: string) => void;
}

export function DocumentViewer({ document, onWikiLinkClick }: Props) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'annotate' | 'browse'>('browse');
  const {
    highlights,
    references,
    loadAnnotations,
    addHighlight,
    addReference,
    deleteAnnotation,
    convertHighlightToReference,
    convertReferenceToHighlight
  } = useDocumentAnnotations();
  
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
  
  // Load annotations when document changes
  useEffect(() => {
    if (document.id) {
      loadAnnotations(document.id);
    }
  }, [document.id, loadAnnotations]);
  
  // Handle text selection from SourceView - memoized
  const handleTextSelection = useCallback((text: string, position: { start: number; end: number }) => {
    setSelectedText(text);
    setSelectionPosition(position);
    setShowSelectionPopup(true);
  }, []);
  
  // Handle annotation clicks - memoized
  const handleAnnotationClick = useCallback((annotation: any) => {
    // If it's a reference with a target document, navigate to it
    if (annotation.type === 'reference' && annotation.referencedDocumentId) {
      router.push(`/know/document/${annotation.referencedDocumentId}`);
      return;
    }
    
    // If it's a reference WITHOUT a target document (stub), offer to create it
    if (annotation.type === 'reference' && !annotation.referencedDocumentId) {
      // Note: If a custom name was provided when creating the reference, 
      // it's not stored in the reference, so we use the selected text
      const documentName = annotation.selectionData?.text || 'New Document';
      const confirmed = confirm(
        `This reference points to a document that hasn't been created yet.\n\n` +
        `Would you like to create a document for "${documentName}" now?\n\n` +
        `You can change the name in the composer.\n\n` +
        `Click OK to go to the document composer, or Cancel to stay here.`
      );
      
      if (confirmed) {
        // Navigate to compose page with the reference data
        const params = new URLSearchParams({
          name: documentName,
          referenceId: annotation.id,
          sourceDocumentId: document.id
        });
        if (annotation.entityType) {
          params.append('entityTypes', annotation.entityType);
        }
        if (annotation.referenceType) {
          params.append('referenceType', annotation.referenceType);
        }
        router.push(`/know/compose?${params.toString()}`);
      }
      return;
    }
    
    // Otherwise, show the editing popup (for highlights or editing existing references)
    setEditingAnnotation({
      id: annotation.id,
      type: annotation.type,
      referencedDocumentId: annotation.referencedDocumentId,
      referenceType: annotation.referenceType,
      entityType: annotation.entityType
    });
    setSelectedText(annotation.selectionData?.text || '');
    if (annotation.selectionData) {
      setSelectionPosition({ 
        start: annotation.selectionData.offset, 
        end: annotation.selectionData.offset + annotation.selectionData.length 
      });
    }
    setShowSelectionPopup(true);
  }, [router, document.id]);
  
  // Handle annotation right-clicks - memoized
  const handleAnnotationRightClick = useCallback((annotation: any) => {
    setEditingAnnotation({
      id: annotation.id,
      type: annotation.type,
      referencedDocumentId: annotation.referencedDocumentId,
      referenceType: annotation.referenceType,
      entityType: annotation.entityType
    });
    setSelectedText(annotation.selectionData?.text || '');
    if (annotation.selectionData) {
      setSelectionPosition({ 
        start: annotation.selectionData.offset, 
        end: annotation.selectionData.offset + annotation.selectionData.length 
      });
    }
    setShowSelectionPopup(true);
  }, []);
  
  // Handle creating highlights - memoized
  const handleCreateHighlight = useCallback(async () => {
    if (!selectionPosition || !selectedText) return;
    
    try {
      if (editingAnnotation) {
        if (editingAnnotation.type === 'reference') {
          // Convert reference to highlight
          await convertReferenceToHighlight(editingAnnotation.id);
        }
        // If already a highlight, do nothing
      } else {
        // Create new highlight
        await addHighlight(document.id, selectedText, selectionPosition);
      }
      
      // Close popup
      setShowSelectionPopup(false);
      setSelectedText('');
      setSelectionPosition(null);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to create highlight:', err);
    }
  }, [selectionPosition, selectedText, editingAnnotation, document.id, addHighlight, convertReferenceToHighlight]);
  
  // Handle creating references - memoized
  const handleCreateReference = useCallback(async (targetDocId?: string, entityType?: string, referenceType?: string) => {
    if (!selectionPosition || !selectedText) return;
    
    try {
      if (editingAnnotation) {
        if (editingAnnotation.type === 'highlight') {
          // Convert highlight to reference
          await convertHighlightToReference(editingAnnotation.id, targetDocId, entityType, referenceType);
        } else {
          // Update existing reference
          await deleteAnnotation(editingAnnotation.id);
          await addReference(document.id, selectedText, selectionPosition, targetDocId, entityType, referenceType);
        }
      } else {
        // Create new reference
        await addReference(document.id, selectedText, selectionPosition, targetDocId, entityType, referenceType);
      }
      
      // Close popup
      setShowSelectionPopup(false);
      setSelectedText('');
      setSelectionPosition(null);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to create reference:', err);
    }
  }, [selectionPosition, selectedText, editingAnnotation, document.id, addReference, deleteAnnotation, convertHighlightToReference]);
  
  // Handle deleting annotations - memoized
  const handleDeleteAnnotation = useCallback(async (id: string) => {
    try {
      await deleteAnnotation(id);
      setShowSelectionPopup(false);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to delete annotation:', err);
    }
  }, [deleteAnnotation]);
  
  // Close popup - memoized
  const handleClosePopup = useCallback(() => {
    setShowSelectionPopup(false);
    setSelectedText('');
    setSelectionPosition(null);
    setEditingAnnotation(null);
  }, []);
  
  return (
    <div>
      {/* Tab buttons */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 mb-4">
        <button
          onClick={() => setActiveTab('browse')}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'browse'
              ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
        >
          Browse
        </button>
        <button
          onClick={() => setActiveTab('annotate')}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'annotate'
              ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
        >
          Annotate
        </button>
      </div>
      
      {/* Tab content */}
      {activeTab === 'annotate' ? (
        document.archived ? (
          <AnnotateView
            content={document.content}
            highlights={highlights}
            references={references}
            onAnnotationClick={handleAnnotationClick}
          />
        ) : (
          <AnnotateView
            content={document.content}
            highlights={highlights}
            references={references}
            onTextSelect={handleTextSelection}
            onAnnotationClick={handleAnnotationClick}
            onAnnotationRightClick={handleAnnotationRightClick}
          />
        )
      ) : (
        <BrowseView
          content={document.content}
          highlights={highlights}
          references={references}
          onAnnotationClick={handleAnnotationClick}
          {...(onWikiLinkClick && { onWikiLinkClick })}
        />
      )}
      
      {/* Selection popup */}
      {showSelectionPopup && selectedText && (
        editingAnnotation ? (
          <SelectionPopup
            selectedText={selectedText}
            sourceDocumentId={document.id}
            onCreateHighlight={handleCreateHighlight}
            onCreateReference={handleCreateReference}
            onClose={handleClosePopup}
            isEditMode={true}
            existingAnnotation={editingAnnotation}
            onDelete={handleDeleteAnnotation}
          />
        ) : (
          <SelectionPopup
            selectedText={selectedText}
            sourceDocumentId={document.id}
            onCreateHighlight={handleCreateHighlight}
            onCreateReference={handleCreateReference}
            onClose={handleClosePopup}
            isEditMode={false}
          />
        )
      )}
    </div>
  );
}