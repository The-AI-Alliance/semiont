'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from '@/i18n/routing';
import { AnnotateView } from './AnnotateView';
import { BrowseView } from './BrowseView';
import { AnnotationPopup } from '@/components/AnnotationPopup';
import type { components, ResourceUri, AnnotationUri } from '@semiont/api-client';
import { getExactText, getTextPositionSelector, isHighlight, isReference, getBodySource, getTargetSelector, isBodyResolved, getEntityTypes, extractResourceId, resourceUri, annotationUri } from '@semiont/api-client';
import { useResourceAnnotations } from '@/contexts/ResourceAnnotationsContext';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { annotations } from '@/lib/api/annotations';
import { getResourceId } from '@/lib/resource-helpers';
import { getAnnotationTypeMetadata } from '@/lib/annotation-registry';

type Annotation = components['schemas']['Annotation'];
type SemiontResource = components['schemas']['ResourceDescriptor'];

interface Props {
  resource: SemiontResource & { content: string };
  highlights: Annotation[];
  references: Annotation[];
  assessments: Annotation[];
  comments: Annotation[];
  onRefetchAnnotations?: () => void;
  onWikiLinkClick?: (pageName: string) => void;
  curationMode?: boolean;
  onGenerateDocument?: (referenceId: AnnotationUri, options: { title: string; prompt?: string }) => void;
  generatingReferenceId?: string | null;
  onAnnotationHover?: (annotationId: string | null) => void;
  onCommentHover?: (commentId: string | null) => void;
  hoveredAnnotationId?: string | null;
  hoveredCommentId?: string | null;
  scrollToAnnotationId?: string | null;
  showLineNumbers?: boolean;
  onCommentCreationRequested?: (selection: { exact: string; start: number; end: number }) => void;
  onCommentClick?: (commentId: string) => void;
}

export function ResourceViewer({
  resource,
  highlights,
  references,
  assessments,
  comments,
  onRefetchAnnotations,
  onWikiLinkClick,
  curationMode = false,
  onGenerateDocument,
  generatingReferenceId,
  onAnnotationHover,
  onCommentHover,
  hoveredAnnotationId,
  hoveredCommentId,
  scrollToAnnotationId,
  showLineNumbers = false,
  onCommentCreationRequested,
  onCommentClick
}: Props) {
  const router = useRouter();
  const documentViewerRef = useRef<HTMLDivElement>(null);

  // Extract resource ID once at the top - required for all annotation operations
  const resourceIdStr = getResourceId(resource);
  if (!resourceIdStr) {
    throw new Error('Cannot extract resource ID from resource');
  }
  const resourceIdStr = resourceIdStr;

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
    const metadata = getAnnotationTypeMetadata(annotation);

    // If annotation has a side panel, open it
    if (metadata?.hasSidePanel) {
      if (onCommentClick) {
        onCommentClick(annotation.id);
      }
    } else if (annotation.motivation === 'linking' && annotation.body && isBodyResolved(annotation.body)) {
      // If it's a resolved reference, navigate to it (in both curation and browse mode)
      const bodySource = getBodySource(annotation.body); // returns ResourceUri | null
      if (bodySource) {
        const shortId: string = extractResourceId(bodySource);
        router.push(`/know/resource/${encodeURIComponent(shortId)}`);
      }
    } else if (curationMode) {
      // For other annotations in Annotate mode, show the popup
      setEditingAnnotation(annotation);
      const targetSelector = annotation.target ? getTargetSelector(annotation.target) : undefined;
      setSelectedText(targetSelector ? getExactText(targetSelector) : '');
      const posSelector = targetSelector ? getTextPositionSelector(targetSelector) : undefined;
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
  }, [router, curationMode, onCommentClick]);

  // Handle annotation right-clicks - memoized
  const handleAnnotationRightClick = useCallback((annotation: Annotation, x: number, y: number) => {
    const metadata = getAnnotationTypeMetadata(annotation);

    // If annotation has a side panel, treat right-click same as left-click - open side panel
    if (metadata?.hasSidePanel) {
      if (onCommentClick) {
        onCommentClick(annotation.id);
      }
      return;
    }

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
  }, [onCommentClick]);

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
        await addHighlight(resourceIdStr, selectedText, annotationPosition);
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
  }, [annotationPosition, selectedText, editingAnnotation, resourceId, addHighlight, convertReferenceToHighlight, references, onRefetchAnnotations]);
  
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
          await deleteAnnotation((editingAnnotation as Annotation.id), resourceIdStr);
          await addReference(resourceIdStr, selectedText, annotationPosition, targetDocId, entityType, referenceType);
        }
      } else {
        // Create new reference
        const newId = await addReference(resourceIdStr, selectedText, annotationPosition, targetDocId, entityType, referenceType);
      }

      // Refetch annotations to update UI
      onRefetchAnnotations?.();

      // Close popup
      setShowAnnotationPopup(false);
      setSelectedText('');
      setAnnotationPosition(null);
      setEditingAnnotation(null);
    } catch (err) {
      console.error('Failed to create reference:', err);
    }
  }, [annotationPosition, selectedText, editingAnnotation, resourceId, addReference, deleteAnnotation, convertHighlightToReference, highlights, onRefetchAnnotations]);

  // Handle creating assessments - memoized
  const handleCreateAssessment = useCallback(async () => {
    if (!annotationPosition || !selectedText) return;

    try {
      // Create new assessment
      await addAssessment(resourceIdStr, selectedText, annotationPosition);

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
  }, [annotationPosition, selectedText, resourceId, addAssessment, onRefetchAnnotations]);

  const handleCreateComment = useCallback(() => {
    if (!annotationPosition || !selectedText) return;

    // Notify parent component to open Comments Panel with this selection
    if (onCommentCreationRequested) {
      onCommentCreationRequested({
        exact: selectedText,
        start: annotationPosition.start,
        end: annotationPosition.end
      });
    }

    // Close popup
    setShowAnnotationPopup(false);
    setSelectedText('');
    setAnnotationPosition(null);
    setEditingAnnotation(null);
  }, [annotationPosition, selectedText, onCommentCreationRequested]);

  // Handle deleting annotations - memoized
  const handleDeleteAnnotation = useCallback(async (id: string) => {
    try {
      await deleteAnnotation(id, resourceIdStr);

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
    await handleDeleteAnnotation(annotation.id);
  }, [handleDeleteAnnotation]);

  // Quick action: Convert annotation from widget
  const handleConvertAnnotationWidget = useCallback(async (annotation: Annotation) => {
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
        addHighlight(resourceIdStr, text, position);

        // Clear annotation to remove sparkle animation
        selection.removeAllRanges();
      }
    }
  }, [curationMode, resourceId, addHighlight]);

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
      handler: () => {
        handleQuickHighlight();
      },
      description: 'Create highlight from annotation'
    },
    {
      key: 'r',
      handler: () => {
        handleQuickReference();
      },
      description: 'Create reference from annotation'
    },
    {
      key: 'Delete',
      handler: () => {
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
            assessments={assessments}
            comments={comments}
            onAnnotationClick={handleAnnotationClick}
            {...(onAnnotationHover && { onAnnotationHover })}
            {...(onCommentHover && { onCommentHover })}
            {...(hoveredAnnotationId !== undefined && { hoveredAnnotationId })}
            {...(hoveredCommentId !== undefined && { hoveredCommentId })}
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
            assessments={assessments}
            comments={comments}
            onTextSelect={handleTextSelection}
            onAnnotationClick={handleAnnotationClick}
            onAnnotationRightClick={handleAnnotationRightClick}
            {...(onAnnotationHover && { onAnnotationHover })}
            {...(onCommentHover && { onCommentHover })}
            {...(hoveredAnnotationId !== undefined && { hoveredAnnotationId })}
            {...(hoveredCommentId !== undefined && { hoveredCommentId })}
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
          assessments={assessments}
          comments={comments}
          onAnnotationClick={handleAnnotationClick}
          {...(onCommentHover && { onCommentHover })}
          {...(hoveredCommentId !== undefined && { hoveredCommentId })}
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
        onCreateComment={handleCreateComment}
        onUpdateAnnotation={async (updates) => {
          if (editingAnnotation) {
            // Handle body updates
            if (updates.body !== undefined) {
              // Handle converting between annotation types or linking references
              if (Array.isArray(updates.body)) {
                // Converting to stub reference (empty body array)
                if (isBodyResolved(editingAnnotation.body)) {
                  // Unlink document - convert linked reference to stub
                  await deleteAnnotation(editingAnnotation.id, resourceIdStr);
                  const entityTypes = getEntityTypes(editingAnnotation);
                  await addReference(resourceIdStr, selectedText, annotationPosition!, undefined, entityTypes[0]);
                }
              } else if (updates.body.type === 'SpecificResource') {
                if (updates.body.source) {
                  // Resolve reference to a document
                  await updateAnnotationBodyMutation.mutateAsync({
                    id: editingAnnotation.id,
                    data: {
                      resourceId: resourceIdStr,
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
            onGenerateDocument(annotationUri(editingAnnotation.id), {
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