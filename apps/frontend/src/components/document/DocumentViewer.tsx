'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AnnotateView } from './AnnotateView';
import { BrowseView } from './BrowseView';
import { AnnotationPopup } from '@/components/AnnotationPopup';
import { useDocumentAnnotations } from '@/contexts/DocumentAnnotationsContext';
import type { Document as SemiontDocument } from '@/lib/api-client';

interface Props {
  document: SemiontDocument;
  onWikiLinkClick?: (pageName: string) => void;
  curationMode?: boolean;
  onGenerateDocument?: (referenceId: string, options: { title: string; prompt?: string }) => void;
}

export function DocumentViewer({ document, onWikiLinkClick, curationMode = false, onGenerateDocument }: Props) {
  const router = useRouter();
  
  // Use prop directly instead of internal state
  const activeView = curationMode ? 'annotate' : 'browse';
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
    resolvedDocumentName?: string;
  } | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  
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

    // Get mouse position for popup
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      setPopupPosition({ x: rect.left, y: rect.bottom + 10 });
    }

    setShowSelectionPopup(true);
    setEditingAnnotation(null);
  }, []);
  
  // Handle annotation clicks - memoized
  const handleAnnotationClick = useCallback((annotation: any, event?: React.MouseEvent) => {
    // If it's a reference with a target document, navigate to it
    if (annotation.type === 'reference' && annotation.referencedDocumentId) {
      router.push(`/know/document/${annotation.referencedDocumentId}`);
      return;
    }

    // For any other case in curation mode, show the unified popup
    if (curationMode) {
      setEditingAnnotation({
        id: annotation.id,
        type: annotation.type,
        referencedDocumentId: annotation.referencedDocumentId || annotation.resolvedDocumentId,
        referenceType: annotation.referenceType,
        entityType: annotation.entityType,
        resolvedDocumentName: annotation.referencedDocumentName
      });
      setSelectedText(annotation.selectionData?.text || '');
      if (annotation.selectionData) {
        setSelectionPosition({
          start: annotation.selectionData.offset,
          end: annotation.selectionData.offset + annotation.selectionData.length
        });
      }

      // Set popup position based on click
      if (event) {
        setPopupPosition({ x: event.clientX, y: event.clientY + 10 });
      } else {
        // Fallback to center if no event
        setPopupPosition({ x: window.innerWidth / 2 - 200, y: window.innerHeight / 2 - 250 });
      }

      setShowSelectionPopup(true);
    }
  }, [router, curationMode]);

  // Handle annotation right-clicks - memoized
  const handleAnnotationRightClick = useCallback((annotation: any, x: number, y: number) => {
    setEditingAnnotation({
      id: annotation.id,
      type: annotation.type,
      referencedDocumentId: annotation.referencedDocumentId || annotation.resolvedDocumentId,
      referenceType: annotation.referenceType,
      entityType: annotation.entityType,
      resolvedDocumentName: annotation.referencedDocumentName
    });
    setSelectedText(annotation.selectionData?.text || '');
    if (annotation.selectionData) {
      setSelectionPosition({
        start: annotation.selectionData.offset,
        end: annotation.selectionData.offset + annotation.selectionData.length
      });
    }
    setPopupPosition({ x, y: y + 10 });
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
      {/* Content */}
      {activeView === 'annotate' ? (
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
      
      
      {/* Unified Annotation Popup */}
      <AnnotationPopup
        isOpen={showSelectionPopup}
        onClose={handleClosePopup}
        position={popupPosition}
        selection={selectedText && selectionPosition ? {
          text: selectedText,
          start: selectionPosition.start,
          end: selectionPosition.end
        } : null}
        {...(editingAnnotation && {
          annotation: {
            id: editingAnnotation.id,
            type: editingAnnotation.type,
            ...(editingAnnotation.entityType && { entityType: editingAnnotation.entityType }),
            ...(editingAnnotation.referenceType && { referenceType: editingAnnotation.referenceType }),
            ...(editingAnnotation.referencedDocumentId && { resolvedDocumentId: editingAnnotation.referencedDocumentId }),
            ...(editingAnnotation.resolvedDocumentName && { resolvedDocumentName: editingAnnotation.resolvedDocumentName }),
            provisional: !editingAnnotation.referencedDocumentId
          }
        })}
        onCreateHighlight={handleCreateHighlight}
        onCreateReference={handleCreateReference}
        onUpdateAnnotation={async (updates) => {
          if (editingAnnotation) {
            // Handle updates to existing annotation
            if (updates.type === 'highlight') {
              await convertReferenceToHighlight(editingAnnotation.id);
            } else if (updates.resolvedDocumentId === null) {
              // Unlink document
              await deleteAnnotation(editingAnnotation.id);
              await addReference(document.id, selectedText, selectionPosition!, undefined, editingAnnotation.entityType, editingAnnotation.referenceType);
            }
            setShowSelectionPopup(false);
            setEditingAnnotation(null);
          }
        }}
        onDeleteAnnotation={() => editingAnnotation && handleDeleteAnnotation(editingAnnotation.id)}
        onGenerateDocument={(title, prompt) => {
          if (editingAnnotation && onGenerateDocument) {
            onGenerateDocument(editingAnnotation.id, {
              title,
              ...(prompt && { prompt })
            });
            setShowSelectionPopup(false);
            setEditingAnnotation(null);
          }
        }}
      />
    </div>
  );
}