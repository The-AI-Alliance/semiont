'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from '../../contexts/TranslationContext';
import { AnnotateView, type SelectionMotivation, type ClickAction, type ShapeType } from './AnnotateView';
import { BrowseView } from './BrowseView';
import { PopupContainer } from '../annotation-popups/SharedPopupElements';
import { JsonLdView } from '../annotation-popups/JsonLdView';
import type { components } from '@semiont/api-client';
import { getExactText, getTargetSelector, resourceUri, isHighlight, isAssessment, isReference, isComment, isTag, getBodySource } from '@semiont/api-client';
import { useEventBus } from '../../contexts/EventBusContext';
import { useEventSubscriptions } from '../../contexts/useEventSubscription';
import { useCacheManager } from '../../contexts/CacheContext';
import { useObservableExternalNavigation } from '../../hooks/useObservableNavigation';
import { ANNOTATORS } from '../../lib/annotation-registry';
import type { AnnotationsCollection } from '../../types/annotation-props';
import { getSelectorType, getSelectedShapeForSelectorType, saveSelectedShapeForSelectorType } from '../../lib/media-shapes';

type Annotation = components['schemas']['Annotation'];
type SemiontResource = components['schemas']['ResourceDescriptor'];

/**
 * ResourceViewer - Display and interact with resource content and annotations
 *
 * This component uses event-driven architecture for real-time updates:
 * - Subscribes to make-meaning events (annotation:added, annotation:removed, annotation:updated)
 * - Automatically invalidates cache when annotations change
 * - No manual refetch needed - events handle cache invalidation
 *
 * Requirements:
 * - Must be wrapped in MakeMeaningEventBusProvider (provides event bus)
 * - Must be wrapped in CacheContext (provides cache manager)
 *
 * Event flow:
 *   make-meaning → EventLog → SSE → EventBus → ResourceViewer → Cache invalidation
 *
 * Phase 2 complete: Event-based cache invalidation replaces manual refetch
 * Phase 3 complete: Fully event-driven - all user interactions use unified event bus
 */
interface Props {
  resource: SemiontResource & { content: string };
  annotations: AnnotationsCollection;
  generatingReferenceId?: string | null;
  showLineNumbers?: boolean;
}

export function ResourceViewer({
  resource,
  annotations,
  generatingReferenceId,
  showLineNumbers = false
}: Props) {
  const t = useTranslations('ResourceViewer');
  const documentViewerRef = useRef<HTMLDivElement>(null);

  // Get unified event bus for emitting UI events
  const eventBus = useEventBus();

  // Get observable navigation for event-driven routing
  const navigate = useObservableExternalNavigation();

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

  // Annotate mode state - persisted in localStorage
  const [annotateMode, setAnnotateMode] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('annotateMode') === 'true';
    }
    return false;
  });

  // Persist annotateMode to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('annotateMode', annotateMode.toString());
    }
  }, [annotateMode]);

  // Event handlers (extracted to avoid inline arrow functions)
  const handleViewModeToggle = useCallback(() => {
    setAnnotateMode(prev => !prev);
  }, []);

  // Subscribe to view mode toggle events
  useEventSubscriptions({
    'view:mode-toggled': handleViewModeToggle,
  });

  // Determine active view based on annotate mode
  const activeView = annotateMode ? 'annotate' : 'browse';

  // Event-based cache invalidation - subscribe to make-meaning events
  // This replaces manual onRefetchAnnotations calls with automatic updates
  const cacheManager = useCacheManager();

  const handleAnnotationAdded = useCallback(() => {
    if (cacheManager) {
      cacheManager.invalidateAnnotations(rUri);
    }
  }, [cacheManager, rUri]);

  const handleAnnotationRemoved = useCallback(() => {
    if (cacheManager) {
      cacheManager.invalidateAnnotations(rUri);
    }
  }, [cacheManager, rUri]);

  const handleAnnotationUpdated = useCallback(() => {
    if (cacheManager) {
      cacheManager.invalidateAnnotations(rUri);
    }
  }, [cacheManager, rUri]);

  useEventSubscriptions({
    'annotation:added': handleAnnotationAdded,
    'annotation:removed': handleAnnotationRemoved,
    'annotation:updated': handleAnnotationUpdated,
  });

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

  // Toolbar event handlers (extracted to avoid inline arrow functions)
  const handleToolbarSelectionChanged = useCallback(({ motivation }: { motivation: string | null }) => {
    setSelectedMotivation(motivation as SelectionMotivation | null);
  }, []);

  const handleToolbarClickChanged = useCallback(({ action }: { action: string }) => {
    setSelectedClick(action as ClickAction);
  }, []);

  const handleToolbarShapeChanged = useCallback(({ shape }: { shape: string }) => {
    setSelectedShape(shape as ShapeType);
  }, []);

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

  // Internal UI state for hover, focus, and scroll
  const [hoveredAnnotationId, _setHoveredAnnotationId] = useState<string | null>(null);
  const [hoveredCommentId, _setHoveredCommentId] = useState<string | null>(null);
  const [scrollToAnnotationId, setScrollToAnnotationId] = useState<string | null>(null);
  const [_focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(null);

  // Focus annotation helper
  const focusAnnotation = useCallback((annotationId: string) => {
    setFocusedAnnotationId(annotationId);
    setScrollToAnnotationId(annotationId);

    // Clear focus after 3 seconds
    setTimeout(() => setFocusedAnnotationId(null), 3000);
  }, []);

  // Calculate centered position for JSON-LD modal
  const getJsonLdModalPosition = () => {
    if (typeof window === 'undefined') return { x: 0, y: 0 };

    const popupWidth = 800;
    const popupHeight = 700;

    return {
      x: Math.max(0, (window.innerWidth - popupWidth) / 2),
      y: Math.max(0, (window.innerHeight - popupHeight) / 2),
    };
  };

  // Handle deleting annotations - emit event instead of direct call
  const handleDeleteAnnotation = useCallback((id: string) => {
    eventBus.emit('annotation:delete', { annotationId: id });
  }, []); // eventBus is stable

  // Handle annotation clicks - memoized
  const handleAnnotationClick = useCallback((annotation: Annotation, event?: React.MouseEvent) => {
    const metadata = Object.values(ANNOTATORS).find(a => a.matchesAnnotation(annotation));

    // If annotation has a side panel, only open it when Detail mode is active
    // For delete/jsonld/follow modes, let those handlers below process it
    if (metadata?.hasSidePanel) {
      if (selectedClick === 'detail') {
        // Focus annotation (sets internal focus and scroll state, plus calls parent callback for backward compat)
        focusAnnotation(annotation.id);
        return;
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
        // Navigate to the linked resource - emits 'navigation:external-navigate' event
        const resourceId = bodySource.split('/resources/')[1];
        if (resourceId) {
          navigate(`/know/resource/${resourceId}`, { resourceId });
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
  }, [annotateMode, selectedClick, focusAnnotation]);

  // Annotation click coordinator - handles panel opening and scrolling
  const handleAnnotationClickEvent = useCallback(({ annotationId, motivation }: {
    annotationId: string;
    motivation: components['schemas']['Motivation'];
  }) => {
    // Find the annotation metadata
    const metadata = Object.values(ANNOTATORS).find(a => a.matchesAnnotation({ motivation } as Annotation));

    if (!metadata?.hasSidePanel) {
      // Annotation doesn't have a side panel - let handleAnnotationClick handle it
      const allAnnotations = [...highlights, ...references, ...assessments, ...comments, ...tags];
      const annotation = allAnnotations.find(a => a.id === annotationId);
      if (annotation) {
        handleAnnotationClick(annotation);
      }
      return;
    }

    if (selectedClick !== 'detail') {
      // Only open panels in detail mode - for other modes, let handleAnnotationClick handle it
      const allAnnotations = [...highlights, ...references, ...assessments, ...comments, ...tags];
      const annotation = allAnnotations.find(a => a.id === annotationId);
      if (annotation) {
        handleAnnotationClick(annotation);
      }
      return;
    }

    // All annotations open the unified annotations panel
    // The panel internally switches tabs based on the motivation → tab mapping in UnifiedAnnotationsPanel
    eventBus.emit('panel:open', { panel: 'annotations', scrollToAnnotationId: annotationId, motivation });
  }, [highlights, references, assessments, comments, tags, handleAnnotationClick, selectedClick]);

  // Subscribe to toolbar and annotation events
  useEventSubscriptions({
    'toolbar:selection-changed': handleToolbarSelectionChanged,
    'toolbar:click-changed': handleToolbarClickChanged,
    'toolbar:shape-changed': handleToolbarShapeChanged,
    'annotation:click': handleAnnotationClickEvent,
  });

  // Prepare props for child components
  // Note: These objects are created inline - React's reconciliation handles re-renders efficiently
  const annotationsCollection = { highlights, references, assessments, comments, tags };

  const uiState = {
    selectedMotivation,
    selectedClick,
    selectedShape,
    hoveredAnnotationId,
    scrollToAnnotationId
  };

  return (
    <div ref={documentViewerRef} className="semiont-resource-viewer">
      {/* Content */}
      {activeView === 'annotate' ? (
        <AnnotateView
          content={resource.content}
          mimeType={mimeType}
          resourceUri={resource['@id']}
          annotations={annotationsCollection}
          uiState={uiState}
          onUIStateChange={(updates) => {
            if ('selectedMotivation' in updates) setSelectedMotivation(updates.selectedMotivation!);
            if ('selectedClick' in updates) setSelectedClick(updates.selectedClick!);
            if ('selectedShape' in updates) setSelectedShape(updates.selectedShape!);
          }}
          enableWidgets={true}
          getTargetDocumentName={useCallback((documentId: string) => {
            const referencedResource = references.find((a: Annotation) => getBodySource(a.body) === documentId);
            return referencedResource ? getExactText(getTargetSelector(referencedResource.target)) : undefined;
          }, [references])}
          {...(generatingReferenceId !== undefined && { generatingReferenceId })}
          showLineNumbers={showLineNumbers}
          annotateMode={annotateMode}
        />
      ) : (
        <BrowseView
          content={resource.content}
          mimeType={mimeType}
          resourceUri={resource['@id']}
          annotations={annotationsCollection}
          hoveredCommentId={hoveredCommentId}
          selectedClick={selectedClick}
          annotateMode={annotateMode}
        />
      )}

      {/* JSON-LD View Modal */}
      {jsonLdAnnotation && (
        <PopupContainer
          isOpen={showJsonLdView}
          onClose={() => setShowJsonLdView(false)}
          position={getJsonLdModalPosition()}
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
        const metadata = Object.values(ANNOTATORS).find(a => a.matchesAnnotation(annotation));
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
                onClick={() => {
                  handleDeleteAnnotation(deleteConfirmation.annotation.id);
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