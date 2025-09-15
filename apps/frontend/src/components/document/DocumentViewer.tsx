'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AnnotateView } from './AnnotateView';
import { BrowseView } from './BrowseView';
import { SelectionPopup } from '@/components/SelectionPopup';
import { StubReferenceModal } from '@/components/StubReferenceModal';
import { useDocumentAnnotations } from '@/contexts/DocumentAnnotationsContext';
import type { Document as SemiontDocument } from '@/lib/api-client';

interface Props {
  document: SemiontDocument;
  onWikiLinkClick?: (pageName: string) => void;
  annotateMode?: boolean;
}

export function DocumentViewer({ document, onWikiLinkClick, annotateMode = false }: Props) {
  const router = useRouter();
  
  // Use prop directly instead of internal state
  const activeView = annotateMode ? 'annotate' : 'browse';
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
  const [stubReferenceModal, setStubReferenceModal] = useState<{
    isOpen: boolean;
    annotation: any;
  }>({ isOpen: false, annotation: null });
  
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
    
    // If it's a reference WITHOUT a target document (stub), show modal
    if (annotation.type === 'reference' && !annotation.referencedDocumentId) {
      setStubReferenceModal({ isOpen: true, annotation });
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
  
  // Handle stub reference modal confirmation
  const handleStubReferenceConfirm = useCallback(() => {
    const annotation = stubReferenceModal.annotation;
    if (!annotation) return;
    
    const documentName = annotation.selectionData?.text || 'New Document';
    const params = new URLSearchParams({
      name: documentName,
      referenceId: annotation.id,
      sourceDocumentId: document.id
    });
    if (annotation.entityType) {
      params.append('entityTypes', annotation.entityType);
    } else if (annotation.entityTypes) {
      params.append('entityTypes', annotation.entityTypes.join(','));
    }
    if (annotation.referenceType) {
      params.append('referenceType', annotation.referenceType);
    } else if (annotation.referenceTags && annotation.referenceTags.length > 0) {
      params.append('referenceType', annotation.referenceTags[0]);
    }
    router.push(`/know/compose?${params.toString()}`);
    setStubReferenceModal({ isOpen: false, annotation: null });
  }, [stubReferenceModal.annotation, document.id, router]);
  
  // Handle stub reference modal generate
  const handleStubReferenceGenerate = useCallback(() => {
    const annotation = stubReferenceModal.annotation;
    if (!annotation) return;
    
    const documentName = annotation.selectionData?.text || 'New Document';
    const params = new URLSearchParams({
      name: documentName,
      referenceId: annotation.id,
      sourceDocumentId: document.id,
      generate: 'true'  // Flag to indicate AI generation should be triggered
    });
    if (annotation.entityType) {
      params.append('entityTypes', annotation.entityType);
    } else if (annotation.entityTypes) {
      params.append('entityTypes', annotation.entityTypes.join(','));
    }
    if (annotation.referenceType) {
      params.append('referenceType', annotation.referenceType);
    } else if (annotation.referenceTags && annotation.referenceTags.length > 0) {
      params.append('referenceType', annotation.referenceTags[0]);
    }
    router.push(`/know/compose?${params.toString()}`);
    setStubReferenceModal({ isOpen: false, annotation: null });
  }, [stubReferenceModal.annotation, document.id, router]);
  
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
      
      {/* Stub Reference Modal */}
      <StubReferenceModal
        isOpen={stubReferenceModal.isOpen}
        documentName={stubReferenceModal.annotation?.selectionData?.text || 'New Document'}
        entityTypes={stubReferenceModal.annotation?.entityType ? [stubReferenceModal.annotation.entityType] : stubReferenceModal.annotation?.entityTypes}
        referenceType={stubReferenceModal.annotation?.referenceType || stubReferenceModal.annotation?.referenceTags?.[0]}
        onConfirm={handleStubReferenceConfirm}
        onGenerate={handleStubReferenceGenerate}
        onCancel={() => setStubReferenceModal({ isOpen: false, annotation: null })}
      />
    </div>
  );
}