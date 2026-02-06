'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
// useRouter removed - using window.location for navigation
import { useTranslations } from '../../contexts/TranslationContext';
import { AnnotateView, type SelectionMotivation, type ClickAction, type ShapeType } from './AnnotateView';
import { BrowseView } from './BrowseView';
import { PopupContainer } from '../annotation-popups/SharedPopupElements';
import { JsonLdView } from '../annotation-popups/JsonLdView';
import type { components, Selector } from '@semiont/api-client';
import { getExactText, getTargetSelector, resourceUri, isHighlight, isAssessment, isReference, isComment, isTag, getBodySource } from '@semiont/api-client';
import { useResourceAnnotations } from '../../contexts/ResourceAnnotationsContext';
import type { Annotator } from '../../lib/annotation-registry';
import type { AnnotationsCollection } from '../../types/annotation-props';
import { getSelectorType, getSelectedShapeForSelectorType, saveSelectedShapeForSelectorType } from '../../lib/media-shapes';

type Annotation = components['schemas']['Annotation'];
type SemiontResource = components['schemas']['ResourceDescriptor'];
type Motivation = components['schemas']['Motivation'];

// Unified pending annotation type - all human-created annotations flow through this
interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

interface Props {
  resource: SemiontResource & { content: string };
  annotations: AnnotationsCollection;
  onRefetchAnnotations?: () => void;
  annotateMode: boolean;
  onAnnotateModeToggle: () => void;
  generatingReferenceId?: string | null;
  onAnnotationHover?: (annotationId: string | null) => void;
  onCommentHover?: (commentId: string | null) => void;
  hoveredAnnotationId?: string | null;
  hoveredCommentId?: string | null;
  scrollToAnnotationId?: string | null;
  showLineNumbers?: boolean;
  onAnnotationRequested?: (pending: PendingAnnotation) => void;
  onCommentCreationRequested?: (selection: { exact: string; start: number; end: number; svgSelector?: string; fragmentSelector?: string; conformsTo?: string }) => void;
  onTagCreationRequested?: (selection: { exact: string; start: number; end: number; svgSelector?: string; fragmentSelector?: string; conformsTo?: string }) => void;
  onAssessmentCreationRequested?: (selection: { exact: string; start: number; end: number; svgSelector?: string; fragmentSelector?: string; conformsTo?: string }) => void;
  onReferenceCreationRequested?: (selection: {
    exact: string;
    start: number;
    end: number;
    prefix?: string;
    suffix?: string;
    svgSelector?: string;
    fragmentSelector?: string;
    conformsTo?: string;
  }) => void;
  onCommentClick?: (commentId: string) => void;
  onReferenceClick?: (referenceId: string) => void;
  onHighlightClick?: (highlightId: string) => void;
  onAssessmentClick?: (assessmentId: string) => void;
  onTagClick?: (tagId: string) => void;
  annotators: Record<string, Annotator>;
}

export function ResourceViewer({
  resource,
  annotations,
  onRefetchAnnotations,
  annotateMode,
  onAnnotateModeToggle,
  generatingReferenceId,
  onAnnotationHover,
  onCommentHover,
  hoveredAnnotationId,
  hoveredCommentId,
  scrollToAnnotationId,
  showLineNumbers = false,
  onAnnotationRequested,
  onCommentCreationRequested,
  onTagCreationRequested,
  onAssessmentCreationRequested,
  onReferenceCreationRequested,
  onCommentClick,
  onReferenceClick,
  onHighlightClick,
  onAssessmentClick,
  onTagClick,
  annotators
}: Props) {
  const t = useTranslations('ResourceViewer');
  const documentViewerRef = useRef<HTMLDivElement>(null);

  // Use refs for function props to prevent infinite rerenders
  const onRefetchAnnotationsRef = useRef(onRefetchAnnotations);
  const onCommentCreationRequestedRef = useRef(onCommentCreationRequested);
  const onTagCreationRequestedRef = useRef(onTagCreationRequested);
  const onReferenceCreationRequestedRef = useRef(onReferenceCreationRequested);
  const onCommentClickRef = useRef(onCommentClick);
  const onReferenceClickRef = useRef(onReferenceClick);
  const onHighlightClickRef = useRef(onHighlightClick);
  const onAssessmentClickRef = useRef(onAssessmentClick);
  const onTagClickRef = useRef(onTagClick);

  // Keep refs up to date
  useEffect(() => {
    onRefetchAnnotationsRef.current = onRefetchAnnotations;
    onCommentCreationRequestedRef.current = onCommentCreationRequested;
    onTagCreationRequestedRef.current = onTagCreationRequested;
    onReferenceCreationRequestedRef.current = onReferenceCreationRequested;
    onCommentClickRef.current = onCommentClick;
    onReferenceClickRef.current = onReferenceClick;
    onHighlightClickRef.current = onHighlightClick;
    onAssessmentClickRef.current = onAssessmentClick;
    onTagClickRef.current = onTagClick;
  });

  const { highlights, references, assessments, comments, tags } = annotations;

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
  const activeView = annotateMode ? 'annotate' : 'browse';
  const {
    deleteAnnotation,
    createAnnotation
  } = useResourceAnnotations();

  // Annotation toolbar state - persisted in localStorage
  const [selectedMotivation, setSelectedMotivation] = useState<SelectionMotivation | null>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('semiont-toolbar-selection');
      if (stored === 'null') return null;
      if (stored && ['linking', 'highlighting', 'assessing', 'commenting', 'tagging'].includes(stored)) {
        return stored as SelectionMotivation;
      }
    }
    return 'linking';
  });

  const [selectedClick, setSelectedClick] = useState<ClickAction>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('semiont-toolbar-click');
      if (stored && ['detail', 'follow', 'jsonld', 'deleting'].includes(stored)) {
        return stored as ClickAction;
      }
    }
    return 'detail';
  });

  // Get selector type for current media type
  const selectorType = getSelectorType(mimeType);

  // Get selected shape for this selector type
  const [selectedShape, setSelectedShape] = useState<ShapeType>(() => {
    return getSelectedShapeForSelectorType(selectorType);
  });

  // Persist toolbar state to localStorage
  useEffect(() => {
    if (selectedMotivation === null) {
      localStorage.setItem('semiont-toolbar-selection', 'null');
    } else {
      localStorage.setItem('semiont-toolbar-selection', selectedMotivation);
    }
  }, [selectedMotivation]);

  useEffect(() => {
    localStorage.setItem('semiont-toolbar-click', selectedClick);
  }, [selectedClick]);

  // Persist shape selection per selector type
  useEffect(() => {
    saveSelectedShapeForSelectorType(selectorType, selectedShape);
  }, [selectorType, selectedShape]);

  // Update selected shape when selector type changes (e.g., switching between PDF and image)
  useEffect(() => {
    const shapeForType = getSelectedShapeForSelectorType(selectorType);
    if (shapeForType !== selectedShape) {
      setSelectedShape(shapeForType);
    }
  }, [selectorType]);

  // JSON-LD view state
  const [showJsonLdView, setShowJsonLdView] = useState(false);
  const [jsonLdAnnotation, setJsonLdAnnotation] = useState<Annotation | null>(null);

  // Delete confirmation state
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    annotation: Annotation;
    position: { x: number; y: number };
  } | null>(null);

  // Calculate centered position for JSON-LD modal
  const jsonLdModalPosition = useMemo(() => {
    if (typeof window === 'undefined') return { x: 0, y: 0 };

    const popupWidth = 800;
    const popupHeight = 700;

    return {
      x: Math.max(0, (window.innerWidth - popupWidth) / 2),
      y: Math.max(0, (window.innerHeight - popupHeight) / 2),
    };
  }, []);

  // Handle deleting annotations - memoized
  const handleDeleteAnnotation = useCallback(async (id: string) => {
    try {
      await deleteAnnotation(id, rUri);
      onRefetchAnnotationsRef.current?.();
    } catch (err) {
      console.error('Failed to delete annotation:', err);
    }
  }, [deleteAnnotation, rUri]);

  // Handle annotation clicks - memoized
  const handleAnnotationClick = useCallback((annotation: Annotation, event?: React.MouseEvent) => {
    const metadata = Object.values(annotators).find(a => a.matchesAnnotation(annotation));

    // If annotation has a side panel, only open it when Detail mode is active
    // For delete/jsonld/follow modes, let those handlers below process it
    if (metadata?.hasSidePanel) {
      if (selectedClick === 'detail') {
        // Route to appropriate panel based on annotation type
        if (isComment(annotation) && onCommentClickRef.current) {
          onCommentClickRef.current(annotation.id);
          return;
        }
        if (isReference(annotation) && onReferenceClickRef.current) {
          onReferenceClickRef.current(annotation.id);
          return;
        }
        if (isHighlight(annotation) && onHighlightClickRef.current) {
          onHighlightClickRef.current(annotation.id);
          return;
        }
        if (isAssessment(annotation) && onAssessmentClickRef.current) {
          onAssessmentClickRef.current(annotation.id);
          return;
        }
        if (isTag(annotation) && onTagClickRef.current) {
          onTagClickRef.current(annotation.id);
          return;
        }
      }
      // Don't return early for delete/jsonld/follow modes - let them be handled below
      if (selectedClick !== 'deleting' && selectedClick !== 'jsonld' && selectedClick !== 'follow') {
        return;
      }
    }

    // Check if this is a highlight, assessment, comment, reference, or tag
    const isSimpleAnnotation = isHighlight(annotation) || isAssessment(annotation) || isComment(annotation) || isReference(annotation) || isTag(annotation);

    // Handle follow mode - navigate to resolved references only (works in both Browse and Annotate modes)
    if (selectedClick === 'follow' && isReference(annotation)) {
      const bodySource = getBodySource(annotation.body);
      if (bodySource) {
        // Navigate to the linked resource
        const resourceId = bodySource.split('/resources/')[1];
        if (resourceId) {
          window.location.href = `/know/resource/${resourceId}`;
        }
      }
      return;
    }

    // Handle JSON-LD mode for all annotation types (works in both Browse and Annotate modes)
    if (selectedClick === 'jsonld' && isSimpleAnnotation) {
      setJsonLdAnnotation(annotation);
      setShowJsonLdView(true);
      return;
    }

    // Only handle annotation clicks in annotate mode with toolbar modes
    if (!annotateMode) return;

    // Handle delete mode for all annotation types
    if (selectedClick === 'deleting' && isSimpleAnnotation) {
      // Show confirmation dialog
      const position = event
        ? { x: event.clientX, y: event.clientY + 10 }
        : { x: window.innerWidth / 2 - 150, y: window.innerHeight / 2 - 75 };

      setDeleteConfirmation({ annotation, position });
      return;
    }
  }, [annotateMode, selectedClick, handleDeleteAnnotation, annotators]);

  // Unified annotation creation handler - works for both text and images
  const handleAnnotationCreate = useCallback(async (params: import('../../types/annotation-props').UICreateAnnotationParams) => {
    const { motivation, selector } = params;

    try {
      switch (motivation) {
        case 'highlighting':
        case 'assessing':
          // Create highlight/assessment immediately using generic createAnnotation
          if (selector.type === 'TextQuoteSelector' && selector.exact) {
            // Build selectors array for text annotation
            const selectors: any[] = [
              {
                type: 'TextQuoteSelector',
                exact: selector.exact,
                ...(selector.prefix && { prefix: selector.prefix }),
                ...(selector.suffix && { suffix: selector.suffix })
              },
              {
                type: 'TextPositionSelector',
                start: selector.start || 0,
                end: selector.end || 0
              }
            ];

            const annotation = await createAnnotation(
              rUri,
              motivation,
              selectors,
              []
            );

            // Focus the new annotation to trigger panel tab switch
            if (annotation) {
              if (motivation === 'highlighting' && onHighlightClickRef.current) {
                onHighlightClickRef.current(annotation.id);
              } else if (motivation === 'assessing' && onAssessmentClickRef.current) {
                onAssessmentClickRef.current(annotation.id);
              }
            }
            onRefetchAnnotationsRef.current?.();
          } else if (selector.type === 'SvgSelector' && selector.value) {
            // Image annotations use generic createAnnotation
            await createAnnotation(
              rUri,
              motivation,
              { type: 'SvgSelector', value: selector.value },
              []
            );
            onRefetchAnnotationsRef.current?.();
          } else if (selector.type === 'FragmentSelector' && selector.value) {
            // PDF annotations use FragmentSelector
            await createAnnotation(
              rUri,
              motivation,
              {
                type: 'FragmentSelector',
                value: selector.value,
                ...(selector.conformsTo && { conformsTo: selector.conformsTo })
              },
              []
            );
            onRefetchAnnotationsRef.current?.();
          }
          break;

        case 'commenting':
          if (selector.type === 'TextQuoteSelector' && selector.exact) {
            // Text: notify parent to open Comments Panel
            if (onCommentCreationRequestedRef.current) {
              onCommentCreationRequestedRef.current({
                exact: selector.exact,
                start: selector.start || 0,
                end: selector.end || 0
              });
            }
          } else if (selector.type === 'SvgSelector' && selector.value) {
            // Image: create annotation, then open panel
            const annotation = await createAnnotation(
              rUri,
              motivation,
              { type: 'SvgSelector', value: selector.value },
              []
            );
            if (annotation && onCommentClickRef.current) {
              onCommentClickRef.current(annotation.id);
            }
            onRefetchAnnotationsRef.current?.();
          } else if (selector.type === 'FragmentSelector' && selector.value) {
            // PDF: create annotation, then open panel
            const annotation = await createAnnotation(
              rUri,
              motivation,
              {
                type: 'FragmentSelector',
                value: selector.value,
                ...(selector.conformsTo && { conformsTo: selector.conformsTo })
              },
              []
            );
            if (annotation && onCommentClickRef.current) {
              onCommentClickRef.current(annotation.id);
            }
            onRefetchAnnotationsRef.current?.();
          }
          break;

        case 'tagging':
          if (selector.type === 'TextQuoteSelector' && selector.exact) {
            // Text: notify parent to open Tags Panel
            if (onTagCreationRequestedRef.current) {
              onTagCreationRequestedRef.current({
                exact: selector.exact,
                start: selector.start || 0,
                end: selector.end || 0
              });
            }
          } else if (selector.type === 'SvgSelector' && selector.value) {
            // Image: create annotation, then open panel
            const annotation = await createAnnotation(
              rUri,
              motivation,
              { type: 'SvgSelector', value: selector.value },
              []
            );
            if (annotation && onTagClickRef.current) {
              onTagClickRef.current(annotation.id);
            }
            onRefetchAnnotationsRef.current?.();
          } else if (selector.type === 'FragmentSelector' && selector.value) {
            // PDF: create annotation, then open panel
            const annotation = await createAnnotation(
              rUri,
              motivation,
              {
                type: 'FragmentSelector',
                value: selector.value,
                ...(selector.conformsTo && { conformsTo: selector.conformsTo })
              },
              []
            );
            if (annotation && onTagClickRef.current) {
              onTagClickRef.current(annotation.id);
            }
            onRefetchAnnotationsRef.current?.();
          }
          break;

        case 'linking':
          // Call onReferenceCreationRequested for text, image, and PDF selections
          if (onReferenceCreationRequestedRef.current) {
            if (selector.type === 'TextQuoteSelector' && selector.exact) {
              const selection = {
                exact: selector.exact,
                start: selector.start || 0,
                end: selector.end || 0,
                ...(selector.prefix && { prefix: selector.prefix }),
                ...(selector.suffix && { suffix: selector.suffix })
              };
              onReferenceCreationRequestedRef.current(selection);
            } else if (selector.type === 'SvgSelector' && selector.value) {
              const selection = {
                exact: '',  // Images don't have exact text
                start: 0,
                end: 0,
                svgSelector: selector.value
              };
              onReferenceCreationRequestedRef.current(selection);
            } else if (selector.type === 'FragmentSelector' && selector.value) {
              const selection = {
                exact: '',  // PDFs don't have exact text
                start: 0,
                end: 0,
                fragmentSelector: selector.value,
                ...(selector.conformsTo && { conformsTo: selector.conformsTo })
              };
              onReferenceCreationRequestedRef.current(selection);
            }
          }
          break;
      }
    } catch (err) {
      console.error('Failed to create annotation:', err);
    }
  }, [rUri, createAnnotation]);

  // Quick action: Delete annotation from widget
  const handleDeleteAnnotationWidget = useCallback(async (annotation: Annotation) => {
    await handleDeleteAnnotation(annotation.id);
  }, [handleDeleteAnnotation]);

  // Memoize objects to prevent infinite re-renders
  const annotationsCollection = useMemo(
    () => ({ highlights, references, assessments, comments, tags }),
    [highlights, references, assessments, comments, tags]
  );

  const handlersForAnnotate = useMemo(
    () => ({
      onClick: handleAnnotationClick,
      ...(onAnnotationHover && { onHover: onAnnotationHover }),
      ...(onCommentHover && { onCommentHover })
    }),
    [handleAnnotationClick, onAnnotationHover, onCommentHover]
  );

  const handlersForBrowse = useMemo(
    () => ({
      onClick: handleAnnotationClick,
      ...(onCommentHover && { onCommentHover })
    }),
    [handleAnnotationClick, onCommentHover]
  );

  const creationHandler = useMemo(
    () => ({ onCreate: handleAnnotationCreate }),
    [handleAnnotationCreate]
  );

  const uiState = useMemo(
    () => ({
      selectedMotivation,
      selectedClick,
      selectedShape,
      ...(hoveredAnnotationId !== undefined && { hoveredAnnotationId }),
      ...(hoveredCommentId !== undefined && { hoveredCommentId }),
      ...(scrollToAnnotationId !== undefined && { scrollToAnnotationId })
    }),
    [selectedMotivation, selectedClick, selectedShape, hoveredAnnotationId, hoveredCommentId, scrollToAnnotationId]
  );

  return (
    <div ref={documentViewerRef} className="semiont-resource-viewer">
      {/* Content */}
      {activeView === 'annotate' ? (
        <AnnotateView
          content={resource.content}
          mimeType={mimeType}
          resourceUri={resource['@id']}
          annotations={annotationsCollection}
          handlers={handlersForAnnotate}
          creationHandler={creationHandler}
          uiState={uiState}
          onUIStateChange={(updates) => {
            if ('selectedMotivation' in updates) setSelectedMotivation(updates.selectedMotivation!);
            if ('selectedClick' in updates) setSelectedClick(updates.selectedClick!);
            if ('selectedShape' in updates) setSelectedShape(updates.selectedShape!);
          }}
          enableWidgets={true}
          onEntityTypeClick={(entityType) => {
            window.location.href = `/know?entityType=${encodeURIComponent(entityType)}`;
          }}
          onUnresolvedReferenceClick={handleAnnotationClick}
          {...(generatingReferenceId !== undefined && { generatingReferenceId })}
          onDeleteAnnotation={handleDeleteAnnotationWidget}
          showLineNumbers={showLineNumbers}
          annotateMode={annotateMode}
          onAnnotateModeToggle={onAnnotateModeToggle}
          {...(onAnnotationRequested && { onAnnotationRequested })}
          {...(onCommentCreationRequested && { onCommentCreationRequested })}
          {...(onTagCreationRequested && { onTagCreationRequested })}
          {...(onAssessmentCreationRequested && { onAssessmentCreationRequested })}
          {...(onReferenceCreationRequested && { onReferenceCreationRequested })}
          annotators={annotators}
        />
      ) : (
        <BrowseView
          content={resource.content}
          mimeType={mimeType}
          resourceUri={resource['@id']}
          annotations={annotationsCollection}
          handlers={handlersForBrowse}
          {...(hoveredCommentId !== undefined && { hoveredCommentId })}
          selectedClick={selectedClick}
          onClickChange={setSelectedClick}
          annotateMode={annotateMode}
          onAnnotateModeToggle={onAnnotateModeToggle}
          annotators={annotators}
        />
      )}

      {/* JSON-LD View Modal */}
      {jsonLdAnnotation && (
        <PopupContainer
          isOpen={showJsonLdView}
          onClose={() => setShowJsonLdView(false)}
          position={jsonLdModalPosition}
          wide={true}
        >
          <JsonLdView
            annotation={jsonLdAnnotation}
            onBack={() => {
              setShowJsonLdView(false);
              setJsonLdAnnotation(null);
            }}
          />
        </PopupContainer>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmation && (() => {
        const annotation = deleteConfirmation.annotation;
        const metadata = Object.values(annotators).find(a => a.matchesAnnotation(annotation));
        const targetSelector = getTargetSelector(annotation.target);
        const selectedText = getExactText(targetSelector);
        const motivationEmoji = metadata?.iconEmoji || '📝';

        return (
          <PopupContainer
            isOpen={!!deleteConfirmation}
            onClose={() => setDeleteConfirmation(null)}
            position={deleteConfirmation.position}
          >
            <div className="semiont-delete-confirmation">
              <div className="semiont-delete-confirmation__header">
                <span className="semiont-delete-confirmation__icon">{motivationEmoji}</span>
                <h3 className="semiont-delete-confirmation__title">
                  {t('deleteConfirmationTitle')}
                </h3>
              </div>

              {selectedText && (
                <div className="semiont-delete-confirmation__quote">
                  <p className="semiont-delete-confirmation__text">
                    "{selectedText.length > 100 ? selectedText.substring(0, 100) + '...' : selectedText}"
                  </p>
                </div>
              )}

              <p className="semiont-delete-confirmation__message">
                {t('deleteConfirmationMessage')}
              </p>
              <div className="semiont-delete-confirmation__actions">
              <button
                onClick={() => setDeleteConfirmation(null)}
                className="semiont-button semiont-button--secondary"
              >
                {t('deleteConfirmationCancel')}
              </button>
              <button
                onClick={async () => {
                  await handleDeleteAnnotation(deleteConfirmation.annotation.id);
                  setDeleteConfirmation(null);
                }}
                className="semiont-button semiont-button--danger"
              >
                {t('deleteConfirmationDelete')}
              </button>
            </div>
          </div>
        </PopupContainer>
        );
      })()}
    </div>
  );
}