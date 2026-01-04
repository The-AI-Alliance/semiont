'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
// useRouter removed - using window.location for navigation
import { useTranslations } from '../../contexts/TranslationContext';
import { AnnotateView, type SelectionMotivation, type ClickAction, type ShapeType } from './AnnotateView';
import { BrowseView } from './BrowseView';
import { PopupContainer } from '../annotation-popups/SharedPopupElements';
import { JsonLdView } from '../annotation-popups/JsonLdView';
import type { components, ResourceUri } from '@semiont/api-client';
import { getExactText, getTargetSelector, resourceUri, isHighlight, isAssessment, isReference, isComment, isTag, getBodySource } from '@semiont/api-client';
import { useResourceAnnotations } from '../../contexts/ResourceAnnotationsContext';
import { getAnnotator } from '../../lib/annotation-registry';
import type { AnnotationsCollection } from '../../types/annotation-props';

type Annotation = components['schemas']['Annotation'];
type SemiontResource = components['schemas']['ResourceDescriptor'];

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
  onCommentCreationRequested?: (selection: { exact: string; start: number; end: number }) => void;
  onTagCreationRequested?: (selection: { exact: string; start: number; end: number }) => void;
  onReferenceCreationRequested?: (selection: {
    exact: string;
    start: number;
    end: number;
    prefix?: string;
    suffix?: string;
    svgSelector?: string;
  }) => void;
  onCommentClick?: (commentId: string) => void;
  onReferenceClick?: (referenceId: string) => void;
  onHighlightClick?: (highlightId: string) => void;
  onAssessmentClick?: (assessmentId: string) => void;
  onTagClick?: (tagId: string) => void;
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
  onCommentCreationRequested,
  onTagCreationRequested,
  onReferenceCreationRequested,
  onCommentClick,
  onReferenceClick,
  onHighlightClick,
  onAssessmentClick,
  onTagClick
}: Props) {
  const t = useTranslations('ResourceViewer');
  const documentViewerRef = useRef<HTMLDivElement>(null);

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
    addHighlight,
    addReference,
    addAssessment,
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

  const [selectedShape, setSelectedShape] = useState<ShapeType>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('semiont-toolbar-shape');
      if (stored && ['rectangle', 'circle', 'polygon'].includes(stored)) {
        return stored as ShapeType;
      }
    }
    return 'rectangle';
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

  useEffect(() => {
    localStorage.setItem('semiont-toolbar-shape', selectedShape);
  }, [selectedShape]);

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
      onRefetchAnnotations?.();
    } catch (err) {
      console.error('Failed to delete annotation:', err);
    }
  }, [deleteAnnotation, rUri, onRefetchAnnotations]);

  // Handle annotation clicks - memoized
  const handleAnnotationClick = useCallback((annotation: Annotation, event?: React.MouseEvent) => {
    const metadata = getAnnotator(annotation);

    // If annotation has a side panel, only open it when Detail mode is active
    // For delete/jsonld/follow modes, let those handlers below process it
    if (metadata?.hasSidePanel) {
      if (selectedClick === 'detail') {
        // Route to appropriate panel based on annotation type
        if (isComment(annotation) && onCommentClick) {
          onCommentClick(annotation.id);
          return;
        }
        if (isReference(annotation) && onReferenceClick) {
          onReferenceClick(annotation.id);
          return;
        }
        if (isHighlight(annotation) && onHighlightClick) {
          onHighlightClick(annotation.id);
          return;
        }
        if (isAssessment(annotation) && onAssessmentClick) {
          onAssessmentClick(annotation.id);
          return;
        }
        if (isTag(annotation) && onTagClick) {
          onTagClick(annotation.id);
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
  }, [annotateMode, onCommentClick, onReferenceClick, onHighlightClick, onAssessmentClick, onTagClick, selectedClick, handleDeleteAnnotation]);

  // Unified annotation creation handler - works for both text and images
  const handleAnnotationCreate = useCallback(async (params: import('../../types/annotation-props').CreateAnnotationParams) => {
    const { motivation, selector, position } = params;

    try {
      switch (motivation) {
        case 'highlighting':
        case 'assessing':
          // Create highlight/assessment immediately
          if (selector.type === 'TextQuoteSelector' && selector.exact) {
            // Text annotations use specialized helpers
            let newAnnotationId: string | undefined;
            if (motivation === 'highlighting') {
              newAnnotationId = await addHighlight(
                rUri,
                selector.exact,
                { start: selector.start || 0, end: selector.end || 0 },
                {
                  ...(selector.prefix && { prefix: selector.prefix }),
                  ...(selector.suffix && { suffix: selector.suffix })
                }
              );
              // Focus the new highlight to trigger panel tab switch
              if (newAnnotationId && onHighlightClick) {
                onHighlightClick(newAnnotationId);
              }
            } else {
              newAnnotationId = await addAssessment(
                rUri,
                selector.exact,
                { start: selector.start || 0, end: selector.end || 0 },
                {
                  ...(selector.prefix && { prefix: selector.prefix }),
                  ...(selector.suffix && { suffix: selector.suffix })
                }
              );
              // Focus the new assessment to trigger panel tab switch
              if (newAnnotationId && onAssessmentClick) {
                onAssessmentClick(newAnnotationId);
              }
            }
            onRefetchAnnotations?.();
          } else if (selector.type === 'SvgSelector' && selector.value) {
            // Image annotations use generic createAnnotation
            await createAnnotation(
              rUri,
              motivation,
              { type: 'SvgSelector', value: selector.value },
              []
            );
            onRefetchAnnotations?.();
          }
          break;

        case 'commenting':
          if (selector.type === 'TextQuoteSelector' && selector.exact) {
            // Text: notify parent to open Comments Panel
            if (onCommentCreationRequested) {
              onCommentCreationRequested({
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
            if (annotation && onCommentClick) {
              onCommentClick(annotation.id);
            }
            onRefetchAnnotations?.();
          }
          break;

        case 'tagging':
          if (selector.type === 'TextQuoteSelector' && selector.exact) {
            // Text: notify parent to open Tags Panel
            if (onTagCreationRequested) {
              onTagCreationRequested({
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
            if (annotation && onTagClick) {
              onTagClick(annotation.id);
            }
            onRefetchAnnotations?.();
          }
          break;

        case 'linking':
          // Call onReferenceCreationRequested for both text and image selections
          if (onReferenceCreationRequested) {
            if (selector.type === 'TextQuoteSelector' && selector.exact) {
              const selection = {
                exact: selector.exact,
                start: selector.start || 0,
                end: selector.end || 0,
                ...(selector.prefix && { prefix: selector.prefix }),
                ...(selector.suffix && { suffix: selector.suffix })
              };
              onReferenceCreationRequested(selection);
            } else if (selector.type === 'SvgSelector' && selector.value) {
              const selection = {
                exact: '',  // Images don't have exact text
                start: 0,
                end: 0,
                svgSelector: selector.value
              };
              onReferenceCreationRequested(selection);
            }
          }
          break;
      }
    } catch (err) {
      console.error('Failed to create annotation:', err);
    }
  }, [rUri, addHighlight, addAssessment, createAnnotation, onRefetchAnnotations, onCommentCreationRequested, onTagCreationRequested, onReferenceCreationRequested, onCommentClick, onTagClick]);

  // Quick action: Delete annotation from widget
  const handleDeleteAnnotationWidget = useCallback(async (annotation: Annotation) => {
    await handleDeleteAnnotation(annotation.id);
  }, [handleDeleteAnnotation]);

  return (
    <div ref={documentViewerRef} className="h-full">
      {/* Content */}
      {activeView === 'annotate' ? (
        <AnnotateView
          content={resource.content}
          mimeType={mimeType}
          resourceUri={resource['@id']}
          annotations={{ highlights, references, assessments, comments, tags }}
          handlers={{
            onClick: handleAnnotationClick,
            ...(onAnnotationHover && { onHover: onAnnotationHover }),
            ...(onCommentHover && { onCommentHover })
          }}
          creationHandler={{
            onCreate: handleAnnotationCreate
          }}
          uiState={{
            selectedMotivation,
            selectedClick,
            selectedShape,
            ...(hoveredAnnotationId !== undefined && { hoveredAnnotationId }),
            ...(hoveredCommentId !== undefined && { hoveredCommentId }),
            ...(scrollToAnnotationId !== undefined && { scrollToAnnotationId })
          }}
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
        />
      ) : (
        <BrowseView
          content={resource.content}
          mimeType={mimeType}
          resourceUri={resource['@id']}
          annotations={{ highlights, references, assessments, comments, tags }}
          handlers={{
            onClick: handleAnnotationClick,
            ...(onCommentHover && { onCommentHover })
          }}
          {...(hoveredCommentId !== undefined && { hoveredCommentId })}
          selectedClick={selectedClick}
          onClickChange={setSelectedClick}
          annotateMode={annotateMode}
          onAnnotateModeToggle={onAnnotateModeToggle}
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
        const metadata = getAnnotator(annotation);
        const targetSelector = getTargetSelector(annotation.target);
        const selectedText = getExactText(targetSelector);
        const motivationEmoji = metadata?.iconEmoji || '📝';

        return (
          <PopupContainer
            isOpen={!!deleteConfirmation}
            onClose={() => setDeleteConfirmation(null)}
            position={deleteConfirmation.position}
          >
            <div className="flex flex-col gap-4 p-4 bg-white dark:bg-gray-800 rounded-lg shadow-lg min-w-[300px]">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{motivationEmoji}</span>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  {t('deleteConfirmationTitle')}
                </h3>
              </div>

              {selectedText && (
                <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg border-l-4 border-blue-500">
                  <p className="text-sm text-gray-700 dark:text-gray-300 italic">
                    "{selectedText.length > 100 ? selectedText.substring(0, 100) + '...' : selectedText}"
                  </p>
                </div>
              )}

              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('deleteConfirmationMessage')}
              </p>
              <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirmation(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                {t('deleteConfirmationCancel')}
              </button>
              <button
                onClick={async () => {
                  await handleDeleteAnnotation(deleteConfirmation.annotation.id);
                  setDeleteConfirmation(null);
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500"
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