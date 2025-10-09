'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { AnnotateView } from './AnnotateView';
import { BrowseView } from './BrowseView';
import { AnnotationPopup } from '@/components/AnnotationPopup';
import type { Annotation } from '@semiont/core-types';
import { useDocumentAnnotations } from '@/contexts/DocumentAnnotationsContext';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import type { Document as SemiontDocument } from '@/lib/api-client';
import { api } from '@/lib/api-client';

interface Props {
  document: SemiontDocument & { content: string };
  highlights: Annotation[];
  references: Annotation[];
  onRefetchAnnotations?: () => void;
  onWikiLinkClick?: (pageName: string) => void;
  curationMode?: boolean;
  onGenerateDocument?: (referenceId: string, options: { title: string; prompt?: string }) => void;
  generatingReferenceId?: string | null;
  onAnnotationHover?: (annotationId: string | null) => void;
  hoveredAnnotationId?: string | null;
  scrollToAnnotationId?: string | null;
  showLineNumbers?: boolean;
}

export function DocumentViewer({
  document,
  highlights,
  references,
  onRefetchAnnotations,
  onWikiLinkClick,
  curationMode = false,
  onGenerateDocument,
  generatingReferenceId,
  onAnnotationHover,
  hoveredAnnotationId,
  scrollToAnnotationId,
  showLineNumbers = false
}: Props) {
  const router = useRouter();
  const documentViewerRef = useRef<HTMLDivElement>(null);

  // Use prop directly instead of internal state
  const activeView = curationMode ? 'annotate' : 'browse';
  const {
    addHighlight,
    addReference,
    deleteAnnotation,
    convertHighlightToReference,
    convertReferenceToHighlight
  } = useDocumentAnnotations();

  // API mutations
  const resolveReferenceMutation = api.annotations.resolve.useMutation();

  // Selection popup state
  const [selectedText, setSelectedText] = useState<string>('');
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);
  const [selectionPosition, setSelectionPosition] = useState<{ start: number; end: number } | null>(null);
  const [showSelectionPopup, setShowSelectionPopup] = useState(false);
  const [editingAnnotation, setEditingAnnotation] = useState<Annotation | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Handle text selection from SourceView - memoized
  const handleTextSelection = useCallback((exact: string, position: { start: number; end: number }) => {
    setSelectedText(exact);
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
    // If it's a resolved reference, navigate to it (in both curation and browse mode)
    if (annotation.body.type === 'reference' && annotation.body.referencedDocumentId) {
      router.push(`/know/document/${encodeURIComponent(annotation.body.referencedDocumentId)}`);
      return;
    }

    // For other annotations in Annotate mode, show the popup
    if (curationMode) {
      setEditingAnnotation({
        ...annotation,  // Include all required fields (documentId, text, selector, entityTypes, etc.)
        resolvedDocumentName: annotation.referencedDocumentName
      });
      setSelectedText(annotation.target.selector.exact);
      if (annotation.target.selector) {
        setSelectionPosition({
          start: annotation.target.selector.offset,
          end: annotation.target.selector.offset + annotation.target.selector.length
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
      ...annotation,  // Include all required fields
      resolvedDocumentName: annotation.referencedDocumentName
    });
    setSelectedText(annotation.target.selector?.target.selector.exact || '');
    if (annotation.target.selector) {
      setSelectionPosition({
        start: annotation.selector.offset,
        end: annotation.selector.offset + annotation.selector.length
      });
    }
    setPopupPosition({ x, y: y + 10 });
    setShowSelectionPopup(true);
  }, []);

  // Handle clicking 🔗 icon on resolved reference - show popup instead of navigating
  const handleResolvedReferenceWidgetClick = useCallback((documentId: string) => {
    const reference = references.find(r => r.body.referencedDocumentId === documentId);
    if (reference && reference.body.type) {
      setEditingAnnotation({
        ...reference,  // Include all fields from reference (documentId, text, selector, etc.)
        resolvedDocumentName: 'Document'
      });
      setSelectedText(reference.target.selector.exact || '');
      if (reference.target.selector) {
        setSelectionPosition({
          start: reference.target.selector.offset,
          end: reference.target.selector.offset + reference.target.selector.length
        });
      }
      setPopupPosition({ x: window.innerWidth / 2 - 200, y: window.innerHeight / 2 - 250 });
      setShowSelectionPopup(true);
    }
  }, [references]);
  
  // Handle creating highlights - memoized
  const handleCreateHighlight = useCallback(async () => {
    if (!selectionPosition || !selectedText) return;
    
    try {
      if (editingAnnotation) {
        if (editingAnnotation.body.type === 'reference') {
          // Convert reference to highlight
          await convertReferenceToHighlight(references, editingAnnotation.id);
        }
        // If already a highlight, do nothing
      } else {
        // Create new highlight
        await addHighlight(document.id, selectedText, selectionPosition);
      }

      // Refetch annotations to update UI
      onRefetchAnnotations?.();

      // Close popup
      setShowSelectionPopup(false);
      setSelectedText('');
      setSelectionPosition(null);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to create highlight:', err);
    }
  }, [selectionPosition, selectedText, editingAnnotation, document.id, addHighlight, convertReferenceToHighlight, references, onRefetchAnnotations]);
  
  // Handle creating references - memoized
  const handleCreateReference = useCallback(async (targetDocId?: string, entityType?: string, referenceType?: string) => {
    if (!selectionPosition || !selectedText) return;
    
    try {
      if (editingAnnotation) {
        if (editingAnnotation.body.type === 'highlight') {
          // Convert highlight to reference
          await convertHighlightToReference(highlights, editingAnnotation.id, targetDocId, entityType, referenceType);
        } else {
          // Update existing reference
          await deleteAnnotation(editingAnnotation.id, document.id);
          await addReference(document.id, selectedText, selectionPosition, targetDocId, entityType, referenceType);
        }
      } else {
        // Create new reference
        const newId = await addReference(document.id, selectedText, selectionPosition, targetDocId, entityType, referenceType);
        console.log('[DocumentViewer] Created reference:', newId);
      }

      // Refetch annotations to update UI
      console.log('[DocumentViewer] Calling onRefetchAnnotations');
      onRefetchAnnotations?.();
      console.log('[DocumentViewer] onRefetchAnnotations called');

      // Close popup
      setShowSelectionPopup(false);
      setSelectedText('');
      setSelectionPosition(null);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to create reference:', err);
    }
  }, [selectionPosition, selectedText, editingAnnotation, document.id, addReference, deleteAnnotation, convertHighlightToReference, highlights, onRefetchAnnotations]);
  
  // Handle deleting annotations - memoized
  const handleDeleteAnnotation = useCallback(async (id: string) => {
    console.log('[DocumentViewer] handleDeleteAnnotation called with id:', id);
    try {
      await deleteAnnotation(id, document.id);

      // Refetch annotations to update UI
      onRefetchAnnotations?.();

      setShowSelectionPopup(false);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to delete annotation:', err);
    }
  }, [deleteAnnotation, onRefetchAnnotations]);

  // Quick action: Delete annotation from widget
  const handleDeleteAnnotationWidget = useCallback(async (annotation: any) => {
    console.log('[DocumentViewer] Delete annotation from widget:', annotation);
    await handleDeleteAnnotation(annotation.id);
  }, [handleDeleteAnnotation]);

  // Quick action: Convert annotation from widget
  const handleConvertAnnotationWidget = useCallback(async (annotation: any) => {
    console.log('[DocumentViewer] Convert annotation from widget:', annotation);
    try {
      if (annotation.body.type === 'highlight') {
        // Convert highlight to reference (open dialog to get target)
        setEditingAnnotation({
          ...annotation,
          type: 'highlight'
        });
        setShowSelectionPopup(true);
      } else if (annotation.body.type === 'reference') {
        // Convert reference to highlight
        await convertReferenceToHighlight(references, annotation.id);
        onRefetchAnnotations?.();
      }
    } catch (err) {
      console.error('Failed to convert annotation:', err);
    }
  }, [convertReferenceToHighlight, references, onRefetchAnnotations]);

  // Close popup - memoized
  const handleClosePopup = useCallback(() => {
    setShowSelectionPopup(false);
    setSelectedText('');
    setSelectionPosition(null);
    setEditingAnnotation(null);
  }, []);

  // Handle keyboard shortcuts for annotations
  const handleQuickHighlight = useCallback(() => {
    if (!curationMode) return;

    // Check if there's selected text
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
      const text = selection.toString();
      const range = selection.getRangeAt(0);

      // Calculate position using the same method as AnnotateView
      const container = documentViewerRef.current;
      if (container) {
        const preSelectionRange = window.document.createRange();
        preSelectionRange.selectNodeContents(container);
        preSelectionRange.setEnd(range.startContainer, range.startOffset);

        const start = preSelectionRange.toString().length;
        const end = start + text.length;

        const position = { start, end };

        // Directly create highlight
        addHighlight(document.id, text, position);

        // Clear selection to remove sparkle animation
        selection.removeAllRanges();
      }
    }
  }, [curationMode, document.id, addHighlight]);

  const handleQuickReference = useCallback(() => {
    if (!curationMode) return;

    // Check if there's selected text
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
      const text = selection.toString();
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      // Calculate position using the same method as AnnotateView
      const container = documentViewerRef.current;
      if (container) {
        const preSelectionRange = window.document.createRange();
        preSelectionRange.selectNodeContents(container);
        preSelectionRange.setEnd(range.startContainer, range.startOffset);

        const start = preSelectionRange.toString().length;
        const end = start + text.length;

        const position = { start, end };

        // Set state to show the AnnotationPopup
        setSelectedText(text);
        setSelectionPosition(position);
        setPopupPosition({ x: rect.left, y: rect.bottom + 10 });
        setShowSelectionPopup(true);
        setEditingAnnotation(null);

        // Clear selection to remove sparkle animation
        selection.removeAllRanges();
      }
    }
  }, [curationMode]);

  const handleDeleteFocusedAnnotation = useCallback(() => {
    if (!curationMode || !focusedAnnotationId) return;

    // Find the annotation
    const annotation = [...highlights, ...references].find(a => a.id === focusedAnnotationId);
    if (annotation) {
      handleDeleteAnnotation(focusedAnnotationId);
      setFocusedAnnotationId(null);
    }
  }, [curationMode, focusedAnnotationId, highlights, references, handleDeleteAnnotation]);

  // Register keyboard shortcuts
  useKeyboardShortcuts([
    {
      key: 'h',
      handler: (e) => {
        // Don't trigger if user is typing
        const target = e.target as HTMLElement;
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.contentEditable === 'true'
        ) {
          return;
        }
        handleQuickHighlight();
      },
      description: 'Create highlight from selection'
    },
    {
      key: 'r',
      handler: (e) => {
        // Don't trigger if user is typing
        const target = e.target as HTMLElement;
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.contentEditable === 'true'
        ) {
          return;
        }
        handleQuickReference();
      },
      description: 'Create reference from selection'
    },
    {
      key: 'Delete',
      handler: (e) => {
        // Don't trigger if user is typing
        const target = e.target as HTMLElement;
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.contentEditable === 'true'
        ) {
          return;
        }
        handleDeleteFocusedAnnotation();
      },
      description: 'Delete focused annotation'
    }
  ]);
  
  return (
    <div ref={documentViewerRef} className="h-full">
      {/* Content */}
      {activeView === 'annotate' ? (
        document.archived ? (
          <AnnotateView
            content={document.content}
            highlights={highlights}
            references={references}
            onAnnotationClick={handleAnnotationClick}
            {...(onAnnotationHover && { onAnnotationHover })}
            {...(hoveredAnnotationId !== undefined && { hoveredAnnotationId })}
            {...(scrollToAnnotationId !== undefined && { scrollToAnnotationId })}
            enableWidgets={true}
            {...(onWikiLinkClick && { onWikiLinkClick })}
            onEntityTypeClick={(entityType) => {
              router.push(`/know?entityType=${encodeURIComponent(entityType)}`);
            }}
            onReferenceNavigate={handleResolvedReferenceWidgetClick}
            onUnresolvedReferenceClick={handleAnnotationClick}
            getTargetDocumentName={(documentId) => {
              // TODO: Add document cache lookup for better UX
              return undefined;
            }}
            {...(generatingReferenceId !== undefined && { generatingReferenceId })}
            onDeleteAnnotation={handleDeleteAnnotationWidget}
            onConvertAnnotation={handleConvertAnnotationWidget}
            showLineNumbers={showLineNumbers}
          />
        ) : (
          <AnnotateView
            content={document.content}
            highlights={highlights}
            references={references}
            onTextSelect={handleTextSelection}
            onAnnotationClick={handleAnnotationClick}
            onAnnotationRightClick={handleAnnotationRightClick}
            {...(onAnnotationHover && { onAnnotationHover })}
            {...(hoveredAnnotationId !== undefined && { hoveredAnnotationId })}
            {...(scrollToAnnotationId !== undefined && { scrollToAnnotationId })}
            enableWidgets={true}
            {...(onWikiLinkClick && { onWikiLinkClick })}
            onEntityTypeClick={(entityType) => {
              router.push(`/know?entityType=${encodeURIComponent(entityType)}`);
            }}
            onReferenceNavigate={handleResolvedReferenceWidgetClick}
            onUnresolvedReferenceClick={handleAnnotationClick}
            getTargetDocumentName={(documentId) => {
              // TODO: Add document cache lookup for better UX
              return undefined;
            }}
            {...(generatingReferenceId !== undefined && { generatingReferenceId })}
            onDeleteAnnotation={handleDeleteAnnotationWidget}
            onConvertAnnotation={handleConvertAnnotationWidget}
            showLineNumbers={showLineNumbers}
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
          exact: selectedText,
          start: selectionPosition.start,
          end: selectionPosition.end
        } : null}
        {...(editingAnnotation && {
          annotation: editingAnnotation
        })}
        onCreateHighlight={handleCreateHighlight}
        onCreateReference={handleCreateReference}
        onUpdateAnnotation={async (updates) => {
          if (editingAnnotation && updates.body) {
            // Handle updates to existing annotation
            if (updates.body.type === 'reference') {
              // Convert highlight to reference
              await convertHighlightToReference(highlights, editingAnnotation.id);
            } else if (updates.body.type === 'highlight') {
              // Convert reference to highlight
              await convertReferenceToHighlight(references, editingAnnotation.id);
            } else if (updates.body.referencedDocumentId === null) {
              // Unlink document
              await deleteAnnotation(editingAnnotation.id, document.id);
              await addReference(document.id, selectedText, selectionPosition!, undefined, editingAnnotation.body.entityTypes?.[0], editingAnnotation.body.referenceType);
            } else if (updates.body.referencedDocumentId) {
              // Resolve reference to a document (old-fashioned resolution via search)
              await resolveReferenceMutation.mutateAsync({
                id: editingAnnotation.id,
                documentId: updates.body.referencedDocumentId
              });
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