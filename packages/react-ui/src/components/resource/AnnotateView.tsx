'use client';

import { useRef, useEffect, useCallback, lazy, Suspense } from 'react';
import { getMimeCategory, isPdfMimeType } from '@semiont/api-client';
import { ANNOTATORS } from '../../lib/annotation-registry';
import { segmentTextWithAnnotations } from '../../lib/text-segmentation';
import { buildTextSelectors, fallbackTextPosition } from '../../lib/text-selection-handler';
import { SvgDrawingCanvas } from '../image-annotation/SvgDrawingCanvas';

import { useResourceAnnotations } from '../../contexts/ResourceAnnotationsContext';

// Lazy load PDF component to avoid SSR issues with browser PDF.js loading
const PdfAnnotationCanvas = lazy(() => import('../pdf-annotation/PdfAnnotationCanvas.client').then(mod => ({ default: mod.PdfAnnotationCanvas })));

import { CodeMirrorRenderer } from '../CodeMirrorRenderer';
import type { EditorView } from '@codemirror/view';
import { useSemiont } from '../../session/SemiontProvider';
import { useObservable } from '../../hooks/useObservable';
import { useEventSubscriptions } from '../../contexts/useEventSubscription';

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
}

/**
 * View component for annotating resources with text selection and drawing
 *
 * @emits mark:requested - User requested to create annotation. Payload: { selector: Selector | Selector[], motivation: SelectionMotivation }
 * @subscribes mark:selection-changed - Toolbar selection changed. Payload: { motivation: string | null }
 * @subscribes mark:click-changed - Toolbar click action changed. Payload: { action: string }
 * @subscribes mark:shape-changed - Toolbar shape changed. Payload: { shape: string }
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
  annotateMode
}: Props) {
  const { newAnnotationIds } = useResourceAnnotations();
  const containerRef = useRef<HTMLDivElement>(null);
  const session = useObservable(useSemiont().activeSession$);

  const category = getMimeCategory(mimeType);

  const { highlights, references, assessments, comments, tags } = annotations;

  const allAnnotations = [...highlights, ...references, ...assessments, ...comments, ...tags];
  const segments = segmentTextWithAnnotations(content, allAnnotations);

  // Extract UI state
  const { selectedMotivation, selectedClick, selectedShape, hoveredAnnotationId, scrollToAnnotationId } = uiState;

  // Store onUIStateChange in ref to avoid dependency issues
  const onUIStateChangeRef = useRef(onUIStateChange);
  onUIStateChangeRef.current = onUIStateChange;

  // Toolbar event handlers (extracted to avoid inline arrow functions)
  const handleToolbarSelectionChanged = useCallback(({ motivation }: { motivation: string | null }) => {
    onUIStateChangeRef.current?.({ selectedMotivation: motivation as SelectionMotivation | null });
  }, []);

  const handleToolbarClickChanged = useCallback(({ action }: { action: string }) => {
    onUIStateChangeRef.current?.({ selectedClick: action as ClickAction });
  }, []);

  const handleToolbarShapeChanged = useCallback(({ shape }: { shape: string }) => {
    onUIStateChangeRef.current?.({ selectedShape: shape as ShapeType });
  }, []);

  const handleAnnotationHover = useCallback(({ annotationId }: { annotationId: string | null }) => {
    onUIStateChangeRef.current?.({ hoveredAnnotationId: annotationId });
  }, []);

  // Subscribe to toolbar events and annotation hover
  useEventSubscriptions({
    'mark:selection-changed': handleToolbarSelectionChanged,
    'mark:click-changed': handleToolbarClickChanged,
    'mark:shape-changed': handleToolbarShapeChanged,
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

  // Route to appropriate viewer based on MIME type category
  switch (category) {
    case 'text':
      return (
        <div className="semiont-annotate-view" data-mime-type="text" ref={containerRef}>
          <AnnotateToolbar
            selectedMotivation={selectedMotivation}
            selectedClick={selectedClick}
            mediaType={mimeType}
            annotateMode={annotateMode}
            annotators={ANNOTATORS}
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

    case 'image':
      // MIME-specific viewer selection within spatial annotation category
      if (isPdfMimeType(mimeType)) {
        // Phase 2: PDF annotation support
        return (
          <div className="semiont-annotate-view" data-mime-type="pdf" ref={containerRef}>
            <AnnotateToolbar
              selectedMotivation={selectedMotivation}
              selectedClick={selectedClick}
              showShapeGroup={true}
              selectedShape={selectedShape}
              mediaType={mimeType}
              annotateMode={annotateMode}
              annotators={ANNOTATORS}
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
      }

      // PNG, JPEG, etc. - full annotation support
      return (
        <div className="semiont-annotate-view" data-mime-type="image" ref={containerRef}>
          <AnnotateToolbar
            selectedMotivation={selectedMotivation}
            selectedClick={selectedClick}
            showShapeGroup={true}
            selectedShape={selectedShape}
            mediaType={mimeType}
            annotateMode={annotateMode}
            annotators={ANNOTATORS}
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

    case 'unsupported':
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