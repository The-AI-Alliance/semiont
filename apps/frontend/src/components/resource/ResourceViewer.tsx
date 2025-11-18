'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import { AnnotateView, type SelectionMotivation, type ClickMotivation, type ShapeType } from './AnnotateView';
import { BrowseView } from './BrowseView';
import { QuickReferencePopup } from '@/components/annotation-popups/QuickReferencePopup';
import { PopupContainer } from '@/components/annotation-popups/SharedPopupElements';
import { JsonLdView } from '@/components/annotation-popups/JsonLdView';
import type { components, ResourceUri } from '@semiont/api-client';
import { getExactText, getTargetSelector, resourceUri, isHighlight, isAssessment, isReference, isComment, getBodySource } from '@semiont/api-client';
import { useResourceAnnotations } from '@/contexts/ResourceAnnotationsContext';
import { getAnnotationTypeMetadata } from '@/lib/annotation-registry';
import type { AnnotationsCollection } from '@/types/annotation-props';

type Annotation = components['schemas']['Annotation'];
type SemiontResource = components['schemas']['ResourceDescriptor'];

interface Props {
  resource: SemiontResource & { content: string };
  annotations: AnnotationsCollection;
  onRefetchAnnotations?: () => void;
  curationMode?: boolean;
  generatingReferenceId?: string | null;
  onAnnotationHover?: (annotationId: string | null) => void;
  onCommentHover?: (commentId: string | null) => void;
  hoveredAnnotationId?: string | null;
  hoveredCommentId?: string | null;
  scrollToAnnotationId?: string | null;
  showLineNumbers?: boolean;
  onCommentCreationRequested?: (selection: { exact: string; start: number; end: number }) => void;
  onCommentClick?: (commentId: string) => void;
  onReferenceClick?: (referenceId: string) => void;
}

export function ResourceViewer({
  resource,
  annotations,
  onRefetchAnnotations,
  curationMode = false,
  generatingReferenceId,
  onAnnotationHover,
  onCommentHover,
  hoveredAnnotationId,
  hoveredCommentId,
  scrollToAnnotationId,
  showLineNumbers = false,
  onCommentCreationRequested,
  onCommentClick,
  onReferenceClick
}: Props) {
  const router = useRouter();
  const t = useTranslations('ResourceViewer');
  const documentViewerRef = useRef<HTMLDivElement>(null);

  const { highlights, references, assessments, comments } = annotations;

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
    deleteAnnotation,
    createAnnotation
  } = useResourceAnnotations();

  // Annotation toolbar state - persisted in localStorage
  const [selectedSelection, setSelectedSelection] = useState<SelectionMotivation | null>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('semiont-toolbar-selection');
      if (stored === 'null') return null;
      if (stored && ['linking', 'highlighting', 'assessing', 'commenting'].includes(stored)) {
        return stored as SelectionMotivation;
      }
    }
    return 'linking';
  });

  const [selectedClick, setSelectedClick] = useState<ClickMotivation>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('semiont-toolbar-click');
      if (stored && ['detail', 'follow', 'jsonld', 'deleting'].includes(stored)) {
        return stored as ClickMotivation;
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
    if (selectedSelection === null) {
      localStorage.setItem('semiont-toolbar-selection', 'null');
    } else {
      localStorage.setItem('semiont-toolbar-selection', selectedSelection);
    }
  }, [selectedSelection]);

  useEffect(() => {
    localStorage.setItem('semiont-toolbar-click', selectedClick);
  }, [selectedClick]);

  useEffect(() => {
    localStorage.setItem('semiont-toolbar-shape', selectedShape);
  }, [selectedShape]);

  // Quick reference popup state
  const [showQuickReferencePopup, setShowQuickReferencePopup] = useState(false);
  const [quickReferenceSelection, setQuickReferenceSelection] = useState<{
    exact: string;
    start: number;
    end: number;
    prefix?: string;
    suffix?: string;
    svgSelector?: string;
  } | null>(null);
  const [quickReferencePosition, setQuickReferencePosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

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
    const metadata = getAnnotationTypeMetadata(annotation);

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
      }
      // Don't return early for delete/jsonld/follow modes - let them be handled below
      if (selectedClick !== 'deleting' && selectedClick !== 'jsonld' && selectedClick !== 'follow') {
        return;
      }
    }

    // Check if this is a highlight, assessment, comment, or reference
    const isSimpleAnnotation = isHighlight(annotation) || isAssessment(annotation) || isComment(annotation) || isReference(annotation);

    // Handle follow mode - navigate to resolved references only (works in both Browse and Annotate modes)
    if (selectedClick === 'follow' && isReference(annotation)) {
      const bodySource = getBodySource(annotation.body);
      if (bodySource) {
        // Navigate to the linked resource
        const resourceId = bodySource.split('/resources/')[1];
        if (resourceId) {
          router.push(`/know/resource/${encodeURIComponent(resourceId)}`);
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

    // Only handle annotation clicks in curation mode with toolbar modes
    if (!curationMode) return;

    // Handle delete mode for all annotation types
    if (selectedClick === 'deleting' && isSimpleAnnotation) {
      // Show confirmation dialog
      const position = event
        ? { x: event.clientX, y: event.clientY + 10 }
        : { x: window.innerWidth / 2 - 150, y: window.innerHeight / 2 - 75 };

      setDeleteConfirmation({ annotation, position });
      return;
    }
  }, [router, curationMode, onCommentClick, onReferenceClick, selectedClick, handleDeleteAnnotation]);

  // Unified annotation creation handler - works for both text and images
  const handleAnnotationCreate = useCallback(async (params: import('@/types/annotation-props').CreateAnnotationParams) => {
    const { motivation, selector, position } = params;

    try {
      switch (motivation) {
        case 'highlighting':
        case 'assessing':
          // Create highlight/assessment immediately
          if (selector.type === 'TextQuoteSelector' && selector.exact) {
            // Text annotations use specialized helpers
            if (motivation === 'highlighting') {
              await addHighlight(
                rUri,
                selector.exact,
                { start: selector.start || 0, end: selector.end || 0 },
                {
                  ...(selector.prefix && { prefix: selector.prefix }),
                  ...(selector.suffix && { suffix: selector.suffix })
                }
              );
            } else {
              await addAssessment(
                rUri,
                selector.exact,
                { start: selector.start || 0, end: selector.end || 0 },
                {
                  ...(selector.prefix && { prefix: selector.prefix }),
                  ...(selector.suffix && { suffix: selector.suffix })
                }
              );
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

        case 'linking':
          // Show Quick Reference popup FIRST (works for both text and images)
          if (selector.type === 'TextQuoteSelector' && selector.exact) {
            const selection: typeof quickReferenceSelection = {
              exact: selector.exact,
              start: selector.start || 0,
              end: selector.end || 0,
            };
            if (selector.prefix) selection.prefix = selector.prefix;
            if (selector.suffix) selection.suffix = selector.suffix;

            setQuickReferenceSelection(selection);
            setQuickReferencePosition(position || { x: 0, y: 0 });
            setShowQuickReferencePopup(true);
          } else if (selector.type === 'SvgSelector' && selector.value) {
            // For SVG annotations, show popup at shape center
            const selection: typeof quickReferenceSelection = {
              exact: '',  // Images don't have exact text
              start: 0,
              end: 0,
              svgSelector: selector.value
            };

            setQuickReferenceSelection(selection);
            setQuickReferencePosition(position || { x: window.innerWidth / 2, y: window.innerHeight / 2 });
            setShowQuickReferencePopup(true);
          }
          break;
      }
    } catch (err) {
      console.error('Failed to create annotation:', err);
    }
  }, [rUri, addHighlight, addAssessment, createAnnotation, onRefetchAnnotations, onCommentCreationRequested, onCommentClick]);

  // Handle quick reference creation from popup
  const handleQuickReferenceCreate = useCallback(async (entityType?: string) => {
    if (!quickReferenceSelection) return;

    // Extract context from selection
    const context: { prefix?: string; suffix?: string } | undefined =
      (quickReferenceSelection.prefix || quickReferenceSelection.suffix)
        ? {
            ...(quickReferenceSelection.prefix && { prefix: quickReferenceSelection.prefix }),
            ...(quickReferenceSelection.suffix && { suffix: quickReferenceSelection.suffix }),
          }
        : undefined;

    try {
      await addReference(
        rUri,
        quickReferenceSelection.exact,
        { start: quickReferenceSelection.start, end: quickReferenceSelection.end },
        undefined,
        entityType,
        undefined,
        context
      );
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

  // Quick action: Delete annotation from widget
  const handleDeleteAnnotationWidget = useCallback(async (annotation: Annotation) => {
    await handleDeleteAnnotation(annotation.id);
  }, [handleDeleteAnnotation]);

  return (
    <div ref={documentViewerRef} className="h-full">
      {/* Content */}
      {activeView === 'annotate' ? (
        resource.archived ? (
          <AnnotateView
            content={resource.content}
            mimeType={mimeType}
            resourceUri={resource['@id']}
            annotations={{ highlights, references, assessments, comments }}
            handlers={{
              onClick: handleAnnotationClick,
              ...(onAnnotationHover && { onHover: onAnnotationHover }),
              ...(onCommentHover && { onCommentHover })
            }}
            creationHandler={{
              onCreate: handleAnnotationCreate
            }}
            panelHandlers={{
              ...(onCommentClick && { onCommentClick }),
              ...(onReferenceClick && { onReferenceClick })
            }}
            uiState={{
              selectedSelection,
              selectedClick,
              selectedShape,
              ...(hoveredAnnotationId !== undefined && { hoveredAnnotationId }),
              ...(hoveredCommentId !== undefined && { hoveredCommentId }),
              ...(scrollToAnnotationId !== undefined && { scrollToAnnotationId })
            }}
            onUIStateChange={(updates) => {
              if ('selectedSelection' in updates) setSelectedSelection(updates.selectedSelection!);
              if ('selectedClick' in updates) setSelectedClick(updates.selectedClick!);
              if ('selectedShape' in updates) setSelectedShape(updates.selectedShape!);
            }}
            enableWidgets={true}
            onEntityTypeClick={(entityType) => {
              router.push(`/know?entityType=${encodeURIComponent(entityType)}`);
            }}
            onUnresolvedReferenceClick={handleAnnotationClick}
            getTargetDocumentName={(documentId) => {
              return undefined;
            }}
            {...(generatingReferenceId !== undefined && { generatingReferenceId })}
            onDeleteAnnotation={handleDeleteAnnotationWidget}
            showLineNumbers={showLineNumbers}
          />
        ) : (
          <AnnotateView
            content={resource.content}
            mimeType={mimeType}
            resourceUri={resource['@id']}
            annotations={{ highlights, references, assessments, comments }}
            handlers={{
              onClick: handleAnnotationClick,
              ...(onAnnotationHover && { onHover: onAnnotationHover }),
              ...(onCommentHover && { onCommentHover })
            }}
            creationHandler={{
              onCreate: handleAnnotationCreate
            }}
            panelHandlers={{
              ...(onCommentClick && { onCommentClick }),
              ...(onReferenceClick && { onReferenceClick })
            }}
            uiState={{
              selectedSelection,
              selectedClick,
              selectedShape,
              ...(hoveredAnnotationId !== undefined && { hoveredAnnotationId }),
              ...(hoveredCommentId !== undefined && { hoveredCommentId }),
              ...(scrollToAnnotationId !== undefined && { scrollToAnnotationId })
            }}
            onUIStateChange={(updates) => {
              if ('selectedSelection' in updates) setSelectedSelection(updates.selectedSelection!);
              if ('selectedClick' in updates) setSelectedClick(updates.selectedClick!);
              if ('selectedShape' in updates) setSelectedShape(updates.selectedShape!);
            }}
            enableWidgets={true}
            onEntityTypeClick={(entityType) => {
              router.push(`/know?entityType=${encodeURIComponent(entityType)}`);
            }}
            onUnresolvedReferenceClick={handleAnnotationClick}
            getTargetDocumentName={(documentId) => {
              return undefined;
            }}
            {...(generatingReferenceId !== undefined && { generatingReferenceId })}
            onDeleteAnnotation={handleDeleteAnnotationWidget}
            showLineNumbers={showLineNumbers}
          />
        )
      ) : (
        <BrowseView
          content={resource.content}
          mimeType={mimeType}
          resourceUri={resource['@id']}
          annotations={{ highlights, references, assessments, comments }}
          handlers={{
            onClick: handleAnnotationClick,
            ...(onCommentHover && { onCommentHover })
          }}
          {...(hoveredCommentId !== undefined && { hoveredCommentId })}
          selectedClick={selectedClick}
          onClickChange={setSelectedClick}
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
        const metadata = getAnnotationTypeMetadata(annotation);
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