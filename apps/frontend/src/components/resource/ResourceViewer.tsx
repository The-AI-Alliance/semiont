'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import { AnnotateView, type AnnotationMotivation } from './AnnotateView';
import { BrowseView } from './BrowseView';
import { QuickReferencePopup } from '@/components/annotation-popups/QuickReferencePopup';
import { PopupContainer } from '@/components/annotation-popups/SharedPopupElements';
import { JsonLdView } from '@/components/annotation-popups/JsonLdView';
import type { components, ResourceUri } from '@semiont/api-client';
import { getExactText, getTargetSelector, resourceUri, isHighlight, isAssessment, isReference, isComment } from '@semiont/api-client';
import { useResourceAnnotations } from '@/contexts/ResourceAnnotationsContext';
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
  highlights,
  references,
  assessments,
  comments,
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
    // For delete/jsonld modes, let those handlers below process it
    if (metadata?.hasSidePanel) {
      if (selectedMotivation === 'detail') {
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
      // Don't return early for delete/jsonld modes - let them be handled below
      if (selectedMotivation !== 'deleting' && selectedMotivation !== 'jsonld') {
        return;
      }
    }

    // Only handle annotation clicks in curation mode with toolbar modes
    if (!curationMode) return;

    // Check if this is a highlight, assessment, comment, or reference
    const isSimpleAnnotation = isHighlight(annotation) || isAssessment(annotation) || isComment(annotation) || isReference(annotation);

    // Handle delete mode for all annotation types
    if (selectedMotivation === 'deleting' && isSimpleAnnotation) {
      // Show confirmation dialog
      const position = event
        ? { x: event.clientX, y: event.clientY + 10 }
        : { x: window.innerWidth / 2 - 150, y: window.innerHeight / 2 - 75 };

      setDeleteConfirmation({ annotation, position });
      return;
    }

    // Handle JSON-LD mode for all annotation types
    if (selectedMotivation === 'jsonld' && isSimpleAnnotation) {
      setJsonLdAnnotation(annotation);
      setShowJsonLdView(true);
      return;
    }
  }, [router, curationMode, onCommentClick, onReferenceClick, selectedMotivation, handleDeleteAnnotation]);

  // Handle immediate highlight creation (no popup)
  const handleImmediateHighlight = useCallback(async (exact: string, position: { start: number; end: number }) => {
    try {
      await addHighlight(rUri, exact, position);
      onRefetchAnnotations?.();
    } catch (err) {
      console.error('Failed to create highlight:', err);
    }
  }, [rUri, addHighlight, onRefetchAnnotations]);

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