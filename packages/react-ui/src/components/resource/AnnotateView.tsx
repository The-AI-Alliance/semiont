'use client';

import { useRef, useEffect, useCallback, lazy, Suspense } from 'react';
import { capabilitiesOf } from '@semiont/core';
import { ANNOTATORS } from '../../lib/annotation-registry';
import { segmentTextWithAnnotations } from '../../lib/text-segmentation';
import { buildTextSelectors, fallbackTextPosition } from '../../lib/text-selection-handler';
import { SvgDrawingCanvas } from '../image-annotation/SvgDrawingCanvas';

// Lazy load PDF component to avoid SSR issues with browser PDF.js loading
const PdfAnnotationCanvas = lazy(() => import('../pdf-annotation/PdfAnnotationCanvas.client').then(mod => ({ default: mod.PdfAnnotationCanvas })));

import { CodeMirrorRenderer } from '../CodeMirrorRenderer';
import type { EditorView } from '@codemirror/view';
import type { SemiontSession } from '@semiont/sdk';
import { useSessionEventSubscriptions } from '../../hooks/useSessionEventSubscriptions';

// Type augmentation for custom DOM properties
interface EnrichedHTMLElement extends HTMLElement {
  __cmView?: EditorView;
}
import { AnnotateToolbar, type SelectionMotivation, type ClickAction, type ShapeType } from '../annotation/AnnotateToolbar';
import type { AnnotationsCollection, AnnotationUIState } from '../../types/annotation-props';

// Re-export for convenience
export type { SelectionMotivation, ClickAction, ShapeType };

interface Props {
  content: string;
  mimeType?: string;
  resourceUri?: string;
  annotations: AnnotationsCollection;
  uiState: AnnotationUIState;
  onUIStateChange?: (state: Partial<AnnotationUIState>) => void;
  editable?: boolean;
  enableWidgets?: boolean;
  getTargetResourceName?: (resourceId: string) => string | undefined;
  generatingReferenceId?: string | null;
  showLineNumbers?: boolean;
  hoverDelayMs?: number;
  annotateMode: boolean;
  /** Session for the shown resource — its client emits mark:* / mark.request; its bus feeds toolbar + beckon events. */
  session: SemiontSession | null;
  /** Recently-created annotation ids to sparkle (host-provided; was ResourceAnnotationsContext). */
  newAnnotationIds?: Set<string>;
  /** The bar's Mode control reports the chosen mode here (the owner applies it). */
  onModeChange?: (mode: boolean) => void;
}

/**
 * View component for annotating resources with text selection and drawing
 *
 * @emits mark:requested - User requested to create annotation. Payload: { selector: Selector | Selector[], motivation: SelectionMotivation }
 * @subscribes beckon:hover - Annotation hovered. Payload: { annotationId: string | null }
 */
export function AnnotateView({
  content,
  mimeType = 'text/plain',
  resourceUri,
  annotations,
  uiState,
  onUIStateChange,
  enableWidgets = false,
  getTargetResourceName,
  generatingReferenceId,
  showLineNumbers = false,
  hoverDelayMs = 150,
  annotateMode,
  session,
  newAnnotationIds,
  onModeChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const render = capabilitiesOf(mimeType)?.render ?? 'none';

  const { highlights, references, assessments, comments, tags } = annotations;

  const allAnnotations = [...highlights, ...references, ...assessments, ...comments, ...tags];
  const segments = segmentTextWithAnnotations(content, allAnnotations);

  // Extract UI state
  const { selectedMotivation, selectedClick, selectedShape, hoveredAnnotationId, scrollToAnnotationId } = uiState;

  // Store onUIStateChange in ref to avoid dependency issues
  const onUIStateChangeRef = useRef(onUIStateChange);
  onUIStateChangeRef.current = onUIStateChange;

  // Toolbar callbacks: the presentational bar reports chosen values; route them up
  // through the existing onUIStateChange path (the owner applies them).
  const handleToolbarSelectionChange = useCallback((motivation: SelectionMotivation | null) => {
    onUIStateChangeRef.current?.({ selectedMotivation: motivation });
  }, []);

  const handleToolbarClickActionChange = useCallback((action: ClickAction) => {
    onUIStateChangeRef.current?.({ selectedClick: action });
  }, []);

  const handleToolbarShapeChange = useCallback((shape: ShapeType) => {
    onUIStateChangeRef.current?.({ selectedShape: shape });
  }, []);

  const handleAnnotationHover = useCallback(({ annotationId }: { annotationId: string | null }) => {
    onUIStateChangeRef.current?.({ hoveredAnnotationId: annotationId });
  }, []);

  // Annotation hover (session-scoped). Toolbar preference changes flow through
  // props/callbacks, not the bus (TOOLBAR-PREFS-AS-PROPS).
  useSessionEventSubscriptions(session, {
    'beckon:hover': handleAnnotationHover,
  });

  // Handle text annotation with sparkle or immediate creation
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let clickedOnAnnotation = false;

    const handleMouseDown = (e: MouseEvent) => {
      // Check if mousedown was on an existing annotation
      const target = e.target as Element;
      clickedOnAnnotation = !!target.closest('[data-annotation-id]');

      if (!target.closest('[data-annotation-ui]')) {
        // Removed unused selection state
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      // Skip if the mouseUp came from PDF or image canvas
      // (those components handle their own mark:requested events)
      const target = e.target as Element;
      if (target.closest('.semiont-pdf-annotation-canvas') ||
          target.closest('.semiont-svg-drawing-canvas')) {
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString()) {
        clickedOnAnnotation = false;
        return;
      }

      // If mousedown was on an existing annotation, don't trigger creation
      // The annotation's click handler will take care of it
      if (clickedOnAnnotation) {
        clickedOnAnnotation = false;
        return;
      }
      clickedOnAnnotation = false;

      const range = selection.getRangeAt(0);
      const text = selection.toString();

      // Get the CodeMirror EditorView instance stored on the CodeMirror container
      const cmContainer = container.querySelector('.codemirror-renderer');
      const view = (cmContainer as EnrichedHTMLElement | null)?.__cmView;

      let start: number;
      let end: number;

      if (!view || !view.posAtDOM) {
        // Fallback: try to find text in source (won't work for duplicates)
        const pos = fallbackTextPosition(content, text);
        if (!pos) return;
        start = pos.start;
        end = pos.end;
      } else {
        // CodeMirror's posAtDOM gives us the position in the document from a DOM node/offset
        start = view.posAtDOM(range.startContainer, range.startOffset);
        end = start + text.length;
      }

      if (start >= 0 && selectedMotivation) {
        const selectors = buildTextSelectors(content, text, start, end);
        if (!selectors) return;

        session?.client.mark.request(selectors, selectedMotivation);

        // Clear selection after creating annotation
        selection.removeAllRanges();
      }
    };

    container.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('mousedown', handleMouseDown);

    return () => {
      container.removeEventListener('mouseup', handleMouseUp);
      container.removeEventListener('mousedown', handleMouseDown);
    };
  }, [selectedMotivation, content]);

  // Route to the annotation viewer for this media type's render mode.
  switch (render) {
    case 'text':
      return (
        <div className="semiont-annotate-view" data-mime-type="text" ref={containerRef}>
          <AnnotateToolbar
            selectedMotivation={selectedMotivation}
            selectedClick={selectedClick}
            mediaType={mimeType}
            annotateMode={annotateMode}
            annotators={ANNOTATORS}
            parts={['clickAction', 'mode', 'selection']}
            onModeChange={onModeChange}
            onClickActionChange={handleToolbarClickActionChange}
            onSelectionChange={handleToolbarSelectionChange}
          />
          <div className="semiont-annotate-view__content">
            <CodeMirrorRenderer
            content={content}
            segments={segments}
            editable={false}
            newAnnotationIds={newAnnotationIds}
            {...(hoveredAnnotationId !== undefined && { hoveredAnnotationId })}
            {...(scrollToAnnotationId !== undefined && { scrollToAnnotationId })}
            sourceView={true}
            showLineNumbers={showLineNumbers}
            hoverDelayMs={hoverDelayMs}
            enableWidgets={enableWidgets}
            session={session}
            {...(getTargetResourceName && { getTargetResourceName })}
            {...(generatingReferenceId !== undefined && { generatingReferenceId })}
          />

          </div>
        </div>
      );

    case 'pdf':
      // PDF annotation support (spatial, FragmentSelector)
      return (
        <div className="semiont-annotate-view" data-mime-type="pdf" ref={containerRef}>
          <AnnotateToolbar
            selectedMotivation={selectedMotivation}
            selectedClick={selectedClick}
            selectedShape={selectedShape}
            mediaType={mimeType}
            annotateMode={annotateMode}
            annotators={ANNOTATORS}
            onModeChange={onModeChange}
            onClickActionChange={handleToolbarClickActionChange}
            onSelectionChange={handleToolbarSelectionChange}
            onShapeChange={handleToolbarShapeChange}
          />
          <div className="semiont-annotate-view__content">
            {content && (
              <Suspense fallback={<div className="semiont-annotate-view__loading">Loading PDF viewer...</div>}>
                <PdfAnnotationCanvas
                  pdfUrl={content}
                  existingAnnotations={allAnnotations}
                  drawingMode={selectedMotivation ? selectedShape : null}
                  selectedMotivation={selectedMotivation}
                  session={session}
                  hoveredAnnotationId={hoveredAnnotationId || null}
                  hoverDelayMs={hoverDelayMs}
                />
              </Suspense>
            )}
          </div>
        </div>
      );

    case 'image':
      // PNG, JPEG, etc. - full annotation support
      return (
        <div className="semiont-annotate-view" data-mime-type="image" ref={containerRef}>
          <AnnotateToolbar
            selectedMotivation={selectedMotivation}
            selectedClick={selectedClick}
            selectedShape={selectedShape}
            mediaType={mimeType}
            annotateMode={annotateMode}
            annotators={ANNOTATORS}
            onModeChange={onModeChange}
            onClickActionChange={handleToolbarClickActionChange}
            onSelectionChange={handleToolbarSelectionChange}
            onShapeChange={handleToolbarShapeChange}
          />
          <div className="semiont-annotate-view__content">
            {content && (
              <SvgDrawingCanvas
                imageUrl={content}
                existingAnnotations={allAnnotations}
                drawingMode={selectedMotivation ? selectedShape : null}
                selectedMotivation={selectedMotivation}
                session={session}
                hoveredAnnotationId={hoveredAnnotationId || null}
                hoverDelayMs={hoverDelayMs}
              />
            )}
          </div>
        </div>
      );

    case 'none':
    default:
      return (
        <div ref={containerRef} className="semiont-annotate-view semiont-annotate-view--unsupported" data-mime-type="unsupported">
          <div className="semiont-annotate-view__empty">
            <p className="semiont-annotate-view__empty-message">
              Annotation not supported for {mimeType}
            </p>
            {resourceUri && (
              <a
                href={`/api/resources/${resourceUri}`}
                download
                className="semiont-button semiont-button--primary"
              >
                Download File
              </a>
            )}
          </div>
        </div>
      );
  }
}