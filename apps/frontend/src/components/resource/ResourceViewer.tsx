'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from '@/i18n/routing';
import { AnnotateView, type AnnotationMotivation } from './AnnotateView';
import { BrowseView } from './BrowseView';
import { AnnotationPopup } from '@/components/AnnotationPopup';
import { QuickReferencePopup } from '@/components/annotation-popups/QuickReferencePopup';
import type { components, ResourceUri, AnnotationUri } from '@semiont/api-client';
import { getExactText, getTextPositionSelector, getBodySource, getTargetSelector, isBodyResolved, getEntityTypes, resourceUri, annotationUri, resourceAnnotationUri } from '@semiont/api-client';
import { useResourceAnnotations } from '@/contexts/ResourceAnnotationsContext';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useAnnotations } from '@/lib/api-hooks';
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

  // Extract resource URI once at the top - required for all annotation operations
  // Resources have @id (canonical URI), not id
  if (!resource['@id']) {
    throw new Error('Resource has no @id');
  }
  const rUri = resourceUri(resource['@id']);

  // Helper to get MIME type from resource
  const getMimeType = (): string => {
    const reps = resource.representations;
    if (Array.isArray(reps) && reps.length > 0 && reps[0]) {
      return reps[0].mediaType;
    }
    return 'text/plain';
  };

  const mimeType = getMimeType();

  // Use prop directly instead of internal state
  const activeView = curationMode ? 'annotate' : 'browse';
  const {
    addHighlight,
    addReference,
    addAssessment,
    deleteAnnotation
  } = useResourceAnnotations();

  // API mutations
  const annotationsAPI = useAnnotations();
  const updateAnnotationBodyMutation = annotationsAPI.updateBody.useMutation();

  // Annotation toolbar state
  const [selectedMotivation, setSelectedMotivation] = useState<AnnotationMotivation>('linking');

  // Quick reference popup state
  const [showQuickReferencePopup, setShowQuickReferencePopup] = useState(false);
  const [quickReferenceSelection, setQuickReferenceSelection] = useState<{
    exact: string;
    start: number;
    end: number;
  } | null>(null);
  const [quickReferencePosition, setQuickReferencePosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

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
        // Extract ID segment from full ResourceUri (format: http://host/resources/{id})
        const resourceIdSegment = bodySource.split('/').pop();
        if (resourceIdSegment) {
          router.push(`/know/resource/${resourceIdSegment}`);
        }
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
      // Create new highlight
      await addHighlight(rUri, selectedText, annotationPosition);

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
  }, [annotationPosition, selectedText, rUri, addHighlight, onRefetchAnnotations]);

  // Handle immediate highlight creation (no popup)
  const handleImmediateHighlight = useCallback(async (exact: string, position: { start: number; end: number }) => {
    try {
      await addHighlight(rUri, exact, position);
      onRefetchAnnotations?.();
    } catch (err) {
      console.error('Failed to create highlight:', err);
    }
  }, [rUri, addHighlight, onRefetchAnnotations]);
  
  // Handle creating references - memoized
  const handleCreateReference = useCallback(async (targetDocId?: string, entityType?: string, referenceType?: string) => {
    if (!annotationPosition || !selectedText) return;

    try {
      if (editingAnnotation) {
        // Update existing reference
        await deleteAnnotation((editingAnnotation as Annotation).id, rUri);
        await addReference(rUri, selectedText, annotationPosition, targetDocId, entityType, referenceType);
      } else {
        // Create new reference
        await addReference(rUri, selectedText, annotationPosition, targetDocId, entityType, referenceType);
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
  }, [annotationPosition, selectedText, editingAnnotation, rUri, addReference, deleteAnnotation, onRefetchAnnotations]);

  // Handle creating assessments - memoized
  const handleCreateAssessment = useCallback(async () => {
    if (!annotationPosition || !selectedText) return;

    try {
      // Create new assessment
      await addAssessment(rUri, selectedText, annotationPosition);

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
  }, [annotationPosition, selectedText, rUri, addAssessment, onRefetchAnnotations]);

  // Handle immediate assessment creation (no popup)
  const handleImmediateAssessment = useCallback(async (exact: string, position: { start: number; end: number }) => {
    try {
      await addAssessment(rUri, exact, position);
      onRefetchAnnotations?.();
    } catch (err) {
      console.error('Failed to create assessment:', err);
    }
  }, [rUri, addAssessment, onRefetchAnnotations]);

  // Handle immediate comment creation (opens Comment Panel)
  const handleImmediateComment = useCallback((exact: string, position: { start: number; end: number }) => {
    // Notify parent component to open Comments Panel with this selection
    if (onCommentCreationRequested) {
      onCommentCreationRequested({
        exact,
        start: position.start,
        end: position.end
      });
    }
  }, [onCommentCreationRequested]);

  // Handle immediate reference creation (opens Quick Reference popup)
  const handleImmediateReference = useCallback((exact: string, position: { start: number; end: number }, popupPosition: { x: number; y: number }) => {
    setQuickReferenceSelection({
      exact,
      start: position.start,
      end: position.end
    });
    setQuickReferencePosition(popupPosition);
    setShowQuickReferencePopup(true);
  }, []);

  // Handle quick reference creation from popup
  const handleQuickReferenceCreate = useCallback(async (entityType?: string) => {
    if (!quickReferenceSelection) return;

    try {
      await addReference(rUri, quickReferenceSelection.exact, quickReferenceSelection, undefined, entityType, undefined);
      onRefetchAnnotations?.();
      setShowQuickReferencePopup(false);
      setQuickReferenceSelection(null);
    } catch (err) {
      console.error('Failed to create reference:', err);
    }
  }, [quickReferenceSelection, rUri, addReference, onRefetchAnnotations]);

  // Close quick reference popup
  const handleCloseQuickReferencePopup = useCallback(() => {
    setShowQuickReferencePopup(false);
    setQuickReferenceSelection(null);
  }, []);

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
      await deleteAnnotation(id, rUri);

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
        addHighlight(rUri, text, position);

        // Clear annotation to remove sparkle animation
        selection.removeAllRanges();
      }
    }
  }, [curationMode, rUri, addHighlight]);

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
            mimeType={mimeType}
            resourceUri={resource['@id']}
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
            showLineNumbers={showLineNumbers}
            selectedMotivation={selectedMotivation}
            onMotivationChange={setSelectedMotivation}
            onCreateHighlight={handleImmediateHighlight}
            onCreateAssessment={handleImmediateAssessment}
            onCreateComment={handleImmediateComment}
            onCreateReference={handleImmediateReference}
          />
        ) : (
          <AnnotateView
            content={resource.content}
            mimeType={mimeType}
            resourceUri={resource['@id']}
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
            showLineNumbers={showLineNumbers}
            selectedMotivation={selectedMotivation}
            onMotivationChange={setSelectedMotivation}
            onCreateHighlight={handleImmediateHighlight}
            onCreateAssessment={handleImmediateAssessment}
            onCreateComment={handleImmediateComment}
            onCreateReference={handleImmediateReference}
          />
        )
      ) : (
        <BrowseView
          content={resource.content}
          mimeType={mimeType}
          resourceUri={resource['@id']}
          highlights={highlights}
          references={references}
          assessments={assessments}
          comments={comments}
          onAnnotationClick={handleAnnotationClick}
          {...(onCommentHover && { onCommentHover })}
          {...(hoveredCommentId !== undefined && { hoveredCommentId })}
        />
      )}
      
      
      {/* Unified Annotation Popup - only for existing annotations */}
      {editingAnnotation && (
        <AnnotationPopup
          isOpen={showAnnotationPopup}
          onClose={handleClosePopup}
          position={popupPosition}
          selection={selectedText && annotationPosition ? {
            exact: selectedText,
            start: annotationPosition.start,
            end: annotationPosition.end
          } : null}
          annotation={editingAnnotation}
          onUpdateAnnotation={async (updates) => {
          if (editingAnnotation) {
            // Handle body updates
            if (updates.body !== undefined) {
              // Handle converting between annotation types or linking references
              if (Array.isArray(updates.body)) {
                // Converting to stub reference (empty body array)
                if (isBodyResolved(editingAnnotation.body)) {
                  // Unlink document - convert linked reference to stub
                  await deleteAnnotation(editingAnnotation.id, rUri);
                  const entityTypes = getEntityTypes(editingAnnotation);
                  await addReference(rUri, selectedText, annotationPosition!, undefined, entityTypes[0]);
                }
              } else if (updates.body.type === 'SpecificResource') {
                if (updates.body.source) {
                  // Resolve reference to a document
                  await updateAnnotationBodyMutation.mutateAsync({
                    annotationUri: resourceAnnotationUri(`${rUri}/annotations/${editingAnnotation.id}`),
                    data: {
                      resourceId: rUri,
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
      )}

      {/* Quick Reference Popup */}
      {quickReferenceSelection && (
        <QuickReferencePopup
          isOpen={showQuickReferencePopup}
          onClose={handleCloseQuickReferencePopup}
          position={quickReferencePosition}
          selection={quickReferenceSelection}
          onCreateReference={handleQuickReferenceCreate}
        />
      )}
    </div>
  );
}