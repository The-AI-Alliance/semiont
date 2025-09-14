'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { SourceView } from './SourceView';
import { PreviewView } from './PreviewView';
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
  
  // Handle text selection from SourceView
  const handleTextSelection = (text: string, position: { start: number; end: number }) => {
    setSelectedText(text);
    setSelectionPosition(position);
    setShowSelectionPopup(true);
  };
  
  // Handle annotation clicks
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
    setSelectedText(annotation.selectionData?.text || '');
    if (annotation.selectionData) {
      setSelectionPosition({ 
        start: annotation.selectionData.offset, 
        end: annotation.selectionData.offset + annotation.selectionData.length 
      });
    }
    setShowSelectionPopup(true);
  };
  
  // Handle annotation right-clicks
  const handleAnnotationRightClick = (annotation: any, x: number, y: number) => {
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
  };
  
  // Handle creating highlights
  const handleCreateHighlight = async () => {
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
      alert('Failed to create highlight');
    }
  };
  
  // Handle creating references
  const handleCreateReference = async (targetDocId?: string, entityType?: string, referenceType?: string) => {
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
      alert('Failed to create reference');
    }
  };
  
  // Handle deleting annotations
  const handleDeleteAnnotation = async (id: string) => {
    try {
      await deleteAnnotation(id);
      setShowSelectionPopup(false);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to delete annotation:', err);
    }
  };
  
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
        <SourceView
          content={document.content}
          highlights={highlights}
          references={references}
          {...(!document.archived && { onTextSelect: handleTextSelection })}
          onAnnotationClick={handleAnnotationClick}
          {...(!document.archived && { onAnnotationRightClick: handleAnnotationRightClick })}
        />
      ) : (
        <PreviewView
          content={document.content}
          highlights={highlights}
          references={references}
          onAnnotationClick={handleAnnotationClick}
          {...(onWikiLinkClick && { onWikiLinkClick })}
        />
      )}
      
      {/* Selection popup */}
      {showSelectionPopup && selectedText && (
        <SelectionPopup
          selectedText={selectedText}
          sourceDocumentId={document.id}
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
            }
          })}
        />
      )}
    </div>
  );
}