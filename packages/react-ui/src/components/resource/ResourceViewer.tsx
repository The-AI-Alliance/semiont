'use client';

import React, { useState, useCallback, useRef, useMemo } from 'react';
import { useTranslations } from '../../contexts/TranslationContext';
import { AnnotateView, type SelectionMotivation, type ClickAction, type ShapeType } from './AnnotateView';
import { BrowseView, type ReferenceHover } from './BrowseView';
import { PopupContainer } from '../annotation-popups/SharedPopupElements';
import { JsonLdView } from '../annotation-popups/JsonLdView';
import type { Annotation, AnnotationId, ResourceDescriptor as SemiontResource, components, EventMap } from '@semiont/core';
import { getExactText, getTargetSelector, isHighlight, isAssessment, isReference, isComment, isTag, getBodySource } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { useSessionEventSubscriptions } from '../../hooks/useSessionEventSubscriptions';
import { ANNOTATORS } from '../../lib/annotation-registry';
import type { AnnotationsCollection } from '../../types/annotation-props';

/**
 * ResourceViewer - Display and interact with resource content and annotations
 *
 * This component uses event-driven architecture for real-time updates:
 * - Subscribes to make-meaning events (mark:added, mark:removed, mark:body-updated)
 * - Automatically invalidates cache when annotations change
 * - No manual refetch needed - events handle cache invalidation
 *
 * Bring-your-own-session: the `session` (SemiontSession) and the host's
 * navigation / panel callbacks come in as props — no SemiontProvider required.
 * Every event it subscribes to is session-scoped (mark:*, browse:click) and
 * reaches it via `session.subscribe`. Translations fall back to built-in English
 * when no TranslationProvider is mounted; caching flows through `session.client.browse.*`.
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
  /** Session for the shown resource — its client mutates/invalidates, its bus feeds annotation events. */
  session: SemiontSession | null;
  /** Host-owned navigation: a resolved reference was followed. Omit for a view with no follow behavior. */
  onOpenResource?: (resourceId: string) => void;
  /** Host-owned panel control (annotation clicks open a panel). Omit for hosts without side panels. */
  onOpenPanel?: (event: EventMap['panel:open']) => void;
  /** A content link in the rendered content was clicked — the viewer preventDefaults and delegates; it never navigates on its own. */
  onLinkClick?: (link: { href: string; event: React.MouseEvent }) => void;
  /** A resolved reference span is hovered (after dwell + referent descriptor resolve); `null` on leave. Host renders its own preview. */
  onReferenceHover?: (hover: ReferenceHover | null) => void;
  /** Inline display variant: auto-height, no inner scroll, no pane chrome (browse path). Default: fill-the-pane. */
  inline?: boolean;
  /** Recently-created annotation ids to sparkle (threaded to the browse/annotate subtree). */
  newAnnotationIds?: Set<string>;
  generatingReferenceId?: string | null;
  showLineNumbers?: boolean;
  hoverDelayMs?: number;
  hoveredAnnotationId?: string | null;
  /**
   * Toolbar preferences as controlled props (TOOLBAR-PREFS-AS-PROPS). Supply a value
   * to own that pref: the instance renders it and reports intents via the callback —
   * it never self-mutates, never persists, never listens to other instances. Omit for
   * a plain uncontrolled default (false / 'detail' / 'linking' / 'rectangle').
   * Hosts wanting the shared+persisted Browser UX compose `useToolbarPrefs()`.
   */
  annotateMode?: boolean;
  onAnnotateModeChange?: (mode: boolean) => void;
  clickAction?: ClickAction;
  onClickActionChange?: (action: ClickAction) => void;
  selectionMotivation?: SelectionMotivation | null;
  onSelectionMotivationChange?: (motivation: SelectionMotivation | null) => void;
  shape?: ShapeType;
  onShapeChange?: (shape: ShapeType) => void;
}

/**
 * @emits mark:delete - User requested to delete annotation. Payload: { annotationId: string }
 * @emits panel:open - Request to open panel with annotation. Payload: { panel: string, scrollToAnnotationId?: string, motivation?: Motivation }
 *
 * @subscribes mark:added - New annotation was added. Payload: { annotation: Annotation }
 * @subscribes mark:removed - Annotation was removed. Payload: { annotationId: string }
 * @subscribes mark:body-updated - Annotation was updated. Payload: { annotation: Annotation }
 * @subscribes browse:click - User clicked on annotation. Payload: { annotationId: string }
 */
export function ResourceViewer({
  resource,
  annotations,
  session,
  onOpenResource,
  onOpenPanel,
  onLinkClick,
  onReferenceHover,
  inline = false,
  newAnnotationIds,
  generatingReferenceId,
  showLineNumbers = false,
  hoverDelayMs,
  hoveredAnnotationId: hoveredAnnotationIdProp,
  annotateMode: annotateModeProp,
  onAnnotateModeChange,
  clickAction: clickActionProp,
  onClickActionChange,
  selectionMotivation: selectionMotivationProp,
  onSelectionMotivationChange,
  shape: shapeProp,
  onShapeChange,
}: Props) {
  const t = useTranslations('ResourceViewer');
  const documentViewerRef = useRef<HTMLDivElement>(null);

  const { highlights, references, assessments, comments, tags } = annotations;

  // Extract resource URI once at the top - required for all annotation operations
  // Resources have @id (canonical URI), not id
  if (!resource['@id']) {
    throw new Error('Resource has no @id');
  }
  const rUri = resource['@id'];

  // Helper to get MIME type from resource
  const getMimeType = (): string => {
    const reps = resource.representations;
    if (Array.isArray(reps) && reps.length > 0 && reps[0]) {
      return reps[0].mediaType;
    }
    return 'text/plain';
  };

  const mimeType = getMimeType();

  // Toolbar preferences (TOOLBAR-PREFS-AS-PROPS): controlled (prop supplied) or a
  // plain uncontrolled default. Preferences are state, not events — no localStorage
  // and no preference bus channels here; hosts wanting the shared+persisted Browser
  // UX compose useToolbarPrefs() (the policy layer) and pass the values down.
  const [internalAnnotateMode, setInternalAnnotateMode] = useState(false);
  const annotateMode = annotateModeProp ?? internalAnnotateMode;
  const changeAnnotateMode = useCallback((mode: boolean) => {
    if (annotateModeProp === undefined) setInternalAnnotateMode(mode);
    onAnnotateModeChange?.(mode);
  }, [annotateModeProp, onAnnotateModeChange]);

  // Determine active view based on annotate mode
  const activeView = annotateMode ? 'annotate' : 'browse';

  const semiont = session?.client;

  const handleAnnotateAdded = useCallback(() => {
    semiont?.browse.invalidateAnnotationList(rUri);
  }, [semiont, rUri]);

  const handleAnnotateRemoved = useCallback(() => {
    semiont?.browse.invalidateAnnotationList(rUri);
  }, [semiont, rUri]);

  const handleAnnotateBodyUpdated = useCallback(() => {
    semiont?.browse.invalidateAnnotationList(rUri);
  }, [semiont, rUri]);

  // Remaining toolbar preferences — same controlled/uncontrolled split as mode.
  const [internalSelectionMotivation, setInternalSelectionMotivation] = useState<SelectionMotivation | null>('linking');
  const selectedMotivation = selectionMotivationProp !== undefined ? selectionMotivationProp : internalSelectionMotivation;
  const changeSelectionMotivation = useCallback((motivation: SelectionMotivation | null) => {
    if (selectionMotivationProp === undefined) setInternalSelectionMotivation(motivation);
    onSelectionMotivationChange?.(motivation);
  }, [selectionMotivationProp, onSelectionMotivationChange]);

  const [internalClickAction, setInternalClickAction] = useState<ClickAction>('detail');
  const selectedClick = clickActionProp ?? internalClickAction;
  const changeClickAction = useCallback((action: ClickAction) => {
    if (clickActionProp === undefined) setInternalClickAction(action);
    onClickActionChange?.(action);
  }, [clickActionProp, onClickActionChange]);

  const [internalShape, setInternalShape] = useState<ShapeType>('rectangle');
  const selectedShape = shapeProp ?? internalShape;
  const changeShape = useCallback((shape: ShapeType) => {
    if (shapeProp === undefined) setInternalShape(shape);
    onShapeChange?.(shape);
  }, [shapeProp, onShapeChange]);

  // JSON-LD view state
  const [showJsonLdView, setShowJsonLdView] = useState(false);
  const [jsonLdAnnotation, setJsonLdAnnotation] = useState<Annotation | null>(null);

  // Delete confirmation state
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    annotation: Annotation;
    position: { x: number; y: number };
  } | null>(null);

  // Internal UI state for hover, focus, and scroll
  // Use prop value when provided (controlled by parent), otherwise null
  const hoveredAnnotationId = hoveredAnnotationIdProp ?? null;
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

  // Handle deleting annotations
  const handleDeleteAnnotation = useCallback((id: AnnotationId) => {
    session?.client.mark.delete(rUri, id);
  }, [session, rUri]);

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
        // bodySource is already a bare resource ID — the host owns navigation
        onOpenResource?.(bodySource);
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
  }, [annotateMode, selectedClick, focusAnnotation, onOpenResource]);

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

    // All annotations open the unified annotations panel — the host owns the panel.
    // The panel internally switches tabs based on the motivation → tab mapping in UnifiedAnnotationsPanel
    onOpenPanel?.({ panel: 'annotations', scrollToAnnotationId: annotationId, motivation });
  }, [highlights, references, assessments, comments, tags, handleAnnotationClick, selectedClick, onOpenPanel]);

  // Event subscriptions - Combined into single useEventSubscriptions call to prevent hook ordering issues
  // IMPORTANT: All event subscriptions MUST be in a single call to maintain consistent hook order between renders
  useSessionEventSubscriptions(session, {
    // Annotation cache invalidation
    'mark:added': handleAnnotateAdded,
    'mark:removed': handleAnnotateRemoved,
    'mark:body-updated': handleAnnotateBodyUpdated,

    // Annotation clicks
    'browse:click': handleAnnotationClickEvent,
  });

  // Prepare props for child components (memoized to prevent unnecessary re-renders of BrowseView/AnnotateView)
  const annotationsCollection = useMemo(
    () => ({ highlights, references, assessments, comments, tags }),
    [highlights, references, assessments, comments, tags]
  );

  const uiState = {
    selectedMotivation,
    selectedClick,
    selectedShape,
    hoveredAnnotationId,
    scrollToAnnotationId
  };

  // Define getTargetResourceName callback OUTSIDE the conditional
  // IMPORTANT: This must be defined before the return statement to avoid hook ordering violations
  const getTargetResourceName = useCallback((resourceId: string) => {
    const referencedResource = references.find((a: Annotation) => getBodySource(a.body) === resourceId);
    return referencedResource ? getExactText(getTargetSelector(referencedResource.target)) : undefined;
  }, [references]);

  return (
    <div ref={documentViewerRef} className={`semiont-resource-viewer${inline ? ' semiont-resource-viewer--inline' : ''}`}>
      {/* Content */}
      {activeView === 'annotate' ? (
        <AnnotateView
          content={resource.content}
          mimeType={mimeType}
          resourceUri={resource['@id']}
          annotations={annotationsCollection}
          uiState={uiState}
          onUIStateChange={(updates) => {
            if ('selectedMotivation' in updates) changeSelectionMotivation(updates.selectedMotivation ?? null);
            if ('selectedClick' in updates) changeClickAction(updates.selectedClick!);
            if ('selectedShape' in updates) changeShape(updates.selectedShape!);
          }}
          enableWidgets={true}
          getTargetResourceName={getTargetResourceName}
          {...(generatingReferenceId !== undefined && { generatingReferenceId })}
          showLineNumbers={showLineNumbers}
          hoverDelayMs={hoverDelayMs}
          annotateMode={annotateMode}
          onModeChange={changeAnnotateMode}
          session={session}
          newAnnotationIds={newAnnotationIds}
        />
      ) : (
        <BrowseView
          content={resource.content}
          mimeType={mimeType}
          resourceUri={resource['@id']}
          annotations={annotationsCollection}
          selectedClick={selectedClick}
          hoverDelayMs={hoverDelayMs}
          annotateMode={annotateMode}
          onModeChange={changeAnnotateMode}
          onClickActionChange={changeClickAction}
          session={session}
          newAnnotationIds={newAnnotationIds}
          onLinkClick={onLinkClick}
          onReferenceHover={onReferenceHover}
          inline={inline}
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