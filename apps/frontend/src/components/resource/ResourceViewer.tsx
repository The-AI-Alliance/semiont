'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from '@/i18n/routing';
import { AnnotateView } from './AnnotateView';
import { BrowseView } from './BrowseView';
import { AnnotationPopup } from '@/components/AnnotationPopup';
import type { components } from '@semiont/api-client';
import { getExactText, getTextPositionSelector, isHighlight, isReference, getBodySource, getTargetSelector, isBodyResolved, getEntityTypes } from '@semiont/api-client';
import { useResourceAnnotations } from '@/contexts/ResourceAnnotationsContext';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { annotations } from '@/lib/api/annotations';
import { getResourceId } from '@/lib/resource-helpers';

type Annotation = components['schemas']['Annotation'];
type SemiontResource = components['schemas']['ResourceDescriptor'];

interface Props {
  resource: SemiontResource & { content: string };
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

export function ResourceViewer({
  resource,
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
    addAssessment,
    deleteAnnotation,
    convertHighlightToReference,
    convertReferenceToHighlight
  } = useResourceAnnotations();

  // API mutations
  const updateAnnotationBodyMutation = annotations.updateBody.useMutation();

  // Annotation popup state
  const [selectedText, setSelectedText] = useState<string>('');
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);
  const [annotationPosition, setAnnotationPosition] = useState<{ start: number; end: number } | null>(null);
  const [showAnnotationPopup, setShowAnnotationPopup] = useState(false);
  const [editingAnnotation, setEditingAnnotation] = useState<Annotation | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Handle text selection from SourceView - memoized
  const handleTextSelection = useCallback((exact: string, position: { start: number; end: number }) => {
    setSelectedText(exact);
    setAnnotationPosition(position);

    // Get mouse position for popup
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      setPopupPosition({ x: rect.left, y: rect.bottom + 10 });
    }

    setShowAnnotationPopup(true);
    setEditingAnnotation(null);
  }, []);
  
  // Handle annotation clicks - memoized
  const handleAnnotationClick = useCallback((annotation: Annotation, event?: React.MouseEvent) => {
    // If it's a resolved reference, navigate to it (in both curation and browse mode)
    if (isReference(annotation) && isBodyResolved(annotation.body)) {
      const bodySource = getBodySource(annotation.body);
      if (bodySource) {
        router.push(`/know/resource/${encodeURIComponent(bodySource)}`);
      }
      return;
    }

    // For other annotations in Annotate mode, show the popup
    if (curationMode) {
      setEditingAnnotation(annotation);
      const targetSelector = getTargetSelector(annotation.target);
      setSelectedText(getExactText(targetSelector));
      const posSelector = getTextPositionSelector(targetSelector);
      if (posSelector) {
        setAnnotationPosition({
          start: posSelector.start,
          end: posSelector.end
        });
      }

      // Set popup position based on click
      if (event) {
        setPopupPosition({ x: event.clientX, y: event.clientY + 10 });
      } else {
        // Fallback to center if no event
        setPopupPosition({ x: window.innerWidth / 2 - 200, y: window.innerHeight / 2 - 250 });
      }

      setShowAnnotationPopup(true);
    }
  }, [router, curationMode]);

  // Handle annotation right-clicks - memoized
  const handleAnnotationRightClick = useCallback((annotation: Annotation, x: number, y: number) => {
    setEditingAnnotation(annotation);
    const targetSelector = getTargetSelector(annotation.target);
    setSelectedText(getExactText(targetSelector));
    const posSelector = getTextPositionSelector(targetSelector);
    if (posSelector) {
      setAnnotationPosition({
        start: posSelector.start,
        end: posSelector.end
      });
    }
    setPopupPosition({ x, y: y + 10 });
    setShowAnnotationPopup(true);
  }, []);

  // Handle clicking 🔗 icon on resolved reference - show popup instead of navigating
  const handleResolvedReferenceWidgetClick = useCallback((documentId: string) => {
    const reference = references.find(r => getBodySource(r.body) === documentId);
    if (reference && isBodyResolved(reference.body)) {
      setEditingAnnotation(reference);
      const targetSelector = getTargetSelector(reference.target);
      setSelectedText(getExactText(targetSelector));
      const posSelector = getTextPositionSelector(targetSelector);
      if (posSelector) {
        setAnnotationPosition({
          start: posSelector.start,
          end: posSelector.end
        });
      }
      setPopupPosition({ x: window.innerWidth / 2 - 200, y: window.innerHeight / 2 - 250 });
      setShowAnnotationPopup(true);
    }
  }, [references]);
  
  // Handle creating highlights - memoized
  const handleCreateHighlight = useCallback(async () => {
    if (!annotationPosition || !selectedText) return;
    
    try {
      if (editingAnnotation) {
        if (isReference(editingAnnotation)) {
          // Convert reference to highlight
          await convertReferenceToHighlight(references, editingAnnotation.id);
        }
        // If already a highlight, do nothing
      } else {
        // Create new highlight
        await addHighlight(getResourceId(resource), selectedText, annotationPosition);
      }

      // Refetch annotations to update UI
      onRefetchAnnotations?.();

      // Close popup
      setShowAnnotationPopup(false);
      setSelectedText('');
      setAnnotationPosition(null);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to create highlight:', err);
    }
  }, [annotationPosition, selectedText, editingAnnotation, getResourceId(resource), addHighlight, convertReferenceToHighlight, references, onRefetchAnnotations]);
  
  // Handle creating references - memoized
  const handleCreateReference = useCallback(async (targetDocId?: string, entityType?: string, referenceType?: string) => {
    if (!annotationPosition || !selectedText) return;
    
    try {
      if (editingAnnotation) {
        if (isHighlight(editingAnnotation)) {
          // Convert highlight to reference
          await convertHighlightToReference(highlights, (editingAnnotation as Annotation).id, targetDocId, entityType, referenceType);
        } else {
          // Update existing reference
          await deleteAnnotation((editingAnnotation as Annotation).id, getResourceId(resource));
          await addReference(getResourceId(resource), selectedText, annotationPosition, targetDocId, entityType, referenceType);
        }
      } else {
        // Create new reference
        const newId = await addReference(getResourceId(resource), selectedText, annotationPosition, targetDocId, entityType, referenceType);
        console.log('[DocumentViewer] Created reference:', newId);
      }

      // Refetch annotations to update UI
      console.log('[DocumentViewer] Calling onRefetchAnnotations');
      onRefetchAnnotations?.();
      console.log('[DocumentViewer] onRefetchAnnotations called');

      // Close popup
      setShowAnnotationPopup(false);
      setSelectedText('');
      setAnnotationPosition(null);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to create reference:', err);
    }
  }, [annotationPosition, selectedText, editingAnnotation, getResourceId(resource), addReference, deleteAnnotation, convertHighlightToReference, highlights, onRefetchAnnotations]);

  // Handle creating assessments - memoized
  const handleCreateAssessment = useCallback(async () => {
    if (!annotationPosition || !selectedText) return;

    try {
      // Create new assessment
      await addAssessment(getResourceId(resource), selectedText, annotationPosition);

      // Refetch annotations to update UI
      onRefetchAnnotations?.();

      // Close popup
      setShowAnnotationPopup(false);
      setSelectedText('');
      setAnnotationPosition(null);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to create assessment:', err);
    }
  }, [annotationPosition, selectedText, getResourceId(resource), addAssessment, onRefetchAnnotations]);

  // Handle deleting annotations - memoized
  const handleDeleteAnnotation = useCallback(async (id: string) => {
    console.log('[DocumentViewer] handleDeleteAnnotation called with id:', id);
    try {
      await deleteAnnotation(id, getResourceId(resource));

      // Refetch annotations to update UI
      onRefetchAnnotations?.();

      setShowAnnotationPopup(false);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to delete annotation:', err);
    }
  }, [deleteAnnotation, onRefetchAnnotations]);

  // Quick action: Delete annotation from widget
  const handleDeleteAnnotationWidget = useCallback(async (annotation: Annotation) => {
    console.log('[DocumentViewer] Delete annotation from widget:', annotation);
    await handleDeleteAnnotation(annotation.id);
  }, [handleDeleteAnnotation]);

  // Quick action: Convert annotation from widget
  const handleConvertAnnotationWidget = useCallback(async (annotation: Annotation) => {
    console.log('[DocumentViewer] Convert annotation from widget:', annotation);
    try {
      if (isHighlight(annotation)) {
        // Convert highlight to reference (open dialog to get target)
        setEditingAnnotation(annotation);
        setShowAnnotationPopup(true);
      } else if (isReference(annotation)) {
        // Convert reference to highlight
        await convertReferenceToHighlight(references, (annotation as Annotation).id);
        onRefetchAnnotations?.();
      }
    } catch (err) {
      console.error('Failed to convert annotation:', err);
    }
  }, [convertReferenceToHighlight, references, onRefetchAnnotations]);

  // Close popup - memoized
  const handleClosePopup = useCallback(() => {
    setShowAnnotationPopup(false);
    setSelectedText('');
    setAnnotationPosition(null);
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
        const preAnnotationRange = window.document.createRange();
        preAnnotationRange.selectNodeContents(container);
        preAnnotationRange.setEnd(range.startContainer, range.startOffset);

        const start = preAnnotationRange.toString().length;
        const end = start + text.length;

        const position = { start, end };

        // Directly create highlight
        addHighlight(getResourceId(resource), text, position);

        // Clear annotation to remove sparkle animation
        selection.removeAllRanges();
      }
    }
  }, [curationMode, getResourceId(resource), addHighlight]);

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
        const preAnnotationRange = window.document.createRange();
        preAnnotationRange.selectNodeContents(container);
        preAnnotationRange.setEnd(range.startContainer, range.startOffset);

        const start = preAnnotationRange.toString().length;
        const end = start + text.length;

        const position = { start, end };

        // Set state to show the AnnotationPopup
        setSelectedText(text);
        setAnnotationPosition(position);
        setPopupPosition({ x: rect.left, y: rect.bottom + 10 });
        setShowAnnotationPopup(true);
        setEditingAnnotation(null);

        // Clear annotation to remove sparkle animation
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
      description: 'Create highlight from annotation'
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
      description: 'Create reference from annotation'
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
        resource.archived ? (
          <AnnotateView
            content={resource.content}
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
            content={resource.content}
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
          content={resource.content}
          highlights={highlights}
          references={references}
          onAnnotationClick={handleAnnotationClick}
          {...(onWikiLinkClick && { onWikiLinkClick })}
        />
      )}
      
      
      {/* Unified Annotation Popup */}
      <AnnotationPopup
        isOpen={showAnnotationPopup}
        onClose={handleClosePopup}
        position={popupPosition}
        selection={selectedText && annotationPosition ? {
          exact: selectedText,
          start: annotationPosition.start,
          end: annotationPosition.end
        } : null}
        {...(editingAnnotation && {
          annotation: editingAnnotation
        })}
        onCreateHighlight={handleCreateHighlight}
        onCreateReference={handleCreateReference}
        onCreateAssessment={handleCreateAssessment}
        onUpdateAnnotation={async (updates) => {
          if (editingAnnotation) {
            // Handle body updates
            if (updates.body !== undefined) {
              // Handle converting between annotation types or linking references
              if (Array.isArray(updates.body)) {
                // Converting to stub reference (empty body array)
                if (isBodyResolved(editingAnnotation.body)) {
                  // Unlink document - convert linked reference to stub
                  await deleteAnnotation(editingAnnotation.id, getResourceId(resource));
                  const entityTypes = getEntityTypes(editingAnnotation);
                  await addReference(getResourceId(resource), selectedText, annotationPosition!, undefined, entityTypes[0]);
                }
              } else if (updates.body.type === 'SpecificResource') {
                if (updates.body.source) {
                  // Resolve reference to a document
                  await updateAnnotationBodyMutation.mutateAsync({
                    id: editingAnnotation.id,
                    data: {
                      documentId: getResourceId(resource),
                      operations: [{
                        op: 'add',
                        item: {
                          type: 'SpecificResource',
                          source: updates.body.source,
                          purpose: 'linking'
                        }
                      }]
                    }
                  });
                }
              }
            }

            // Handle motivation changes (converting between highlight and reference)
            if (updates.motivation) {
              if (updates.motivation === 'linking' && isHighlight(editingAnnotation)) {
                // Convert highlight to reference
                await convertHighlightToReference(highlights, editingAnnotation.id);
              } else if (updates.motivation === 'highlighting' && isReference(editingAnnotation)) {
                // Convert reference to highlight
                await convertReferenceToHighlight(references, editingAnnotation.id);
              }
            }

            setShowAnnotationPopup(false);
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
            setShowAnnotationPopup(false);
            setEditingAnnotation(null);
          }
        }}
      />
    </div>
  );
}