'use client';

import { useRef, useEffect, useCallback, lazy, Suspense } from 'react';
import type { components } from '@semiont/api-client';
import { getTextPositionSelector, getTextQuoteSelector, getTargetSelector, getMimeCategory, isPdfMimeType, resourceUri as toResourceUri } from '@semiont/api-client';
import { ANNOTATORS } from '../../lib/annotation-registry';
import { SvgDrawingCanvas } from '../image-annotation/SvgDrawingCanvas';
import { useResourceAnnotations } from '../../contexts/ResourceAnnotationsContext';
import { findTextWithContext } from '@semiont/api-client';

// Lazy load PDF component to avoid SSR issues with browser PDF.js loading
const PdfAnnotationCanvas = lazy(() => import('../pdf-annotation/PdfAnnotationCanvas.client').then(mod => ({ default: mod.PdfAnnotationCanvas })));

type Annotation = components['schemas']['Annotation'];

import { CodeMirrorRenderer } from '../CodeMirrorRenderer';
import type { TextSegment } from '../CodeMirrorRenderer';
import type { EditorView } from '@codemirror/view';
import { useEventBus } from '../../contexts/EventBusContext';
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
  getTargetDocumentName?: (documentId: string) => string | undefined;
  generatingReferenceId?: string | null;
  showLineNumbers?: boolean;
  annotateMode: boolean;
}

/**
 * Extract prefix and suffix context for TextQuoteSelector
 * Extracts up to 32 characters before and after the selected text
 */
function extractContext(content: string, start: number, end: number): { prefix?: string; suffix?: string } {
  const CONTEXT_LENGTH = 32;
  const result: { prefix?: string; suffix?: string } = {};

  // Extract prefix (up to CONTEXT_LENGTH chars before start)
  if (start > 0) {
    result.prefix = content.substring(Math.max(0, start - CONTEXT_LENGTH), start);
  }

  // Extract suffix (up to CONTEXT_LENGTH chars after end)
  if (end < content.length) {
    result.suffix = content.substring(end, Math.min(content.length, end + CONTEXT_LENGTH));
  }

  return result;
}

// Segment text with annotations - uses fuzzy anchoring when available!
function segmentTextWithAnnotations(content: string, annotations: Annotation[]): TextSegment[] {
  if (!content) {
    return [{ exact: '', start: 0, end: 0 }];
  }

  const normalizedAnnotations = annotations
    .map(ann => {
      const targetSelector = getTargetSelector(ann.target);
      const posSelector = getTextPositionSelector(targetSelector);
      const quoteSelector = targetSelector ? getTextQuoteSelector(targetSelector) : null;

      // Try fuzzy anchoring if TextQuoteSelector with context is available
      let position;
      if (quoteSelector && (quoteSelector.prefix || quoteSelector.suffix)) {
        // Use fuzzy anchoring when prefix/suffix context is available
        // This helps when content changes or same text appears multiple times
        position = findTextWithContext(
          content,
          quoteSelector.exact,
          quoteSelector.prefix,
          quoteSelector.suffix
        );
      }

      // Fallback to TextPositionSelector or fuzzy position
      const start = position?.start ?? posSelector?.start ?? 0;
      const end = position?.end ?? posSelector?.end ?? 0;

      return {
        annotation: ann,
        start,
        end
      };
    })
    .filter(a => a.start >= 0 && a.end <= content.length && a.start < a.end)
    .sort((a, b) => a.start - b.start);

  if (normalizedAnnotations.length === 0) {
    return [{ exact: content, start: 0, end: content.length }];
  }

  const segments: TextSegment[] = [];
  let position = 0;

  for (const { annotation, start, end } of normalizedAnnotations) {
    if (start < position) continue; // Skip overlapping annotations

    // Add text before annotation
    if (start > position) {
      segments.push({
        exact: content.slice(position, start),
        start: position,
        end: start
      });
    }

    // Add annotated segment
    segments.push({
      exact: content.slice(start, end),
      annotation,
      start,
      end
    });

    position = end;
  }

  // Add remaining text
  if (position < content.length) {
    segments.push({
      exact: content.slice(position),
      start: position,
      end: content.length
    });
  }

  return segments;
}

export function AnnotateView({
  content,
  mimeType = 'text/plain',
  resourceUri,
  annotations,
  uiState,
  onUIStateChange,
  enableWidgets = false,
  getTargetDocumentName,
  generatingReferenceId,
  showLineNumbers = false,
  annotateMode
}: Props) {
  const { newAnnotationIds } = useResourceAnnotations();
  const containerRef = useRef<HTMLDivElement>(null);
  const eventBus = useEventBus();

  const category = getMimeCategory(mimeType);

  const { highlights, references, assessments, comments, tags } = annotations;

  const allAnnotations = [...highlights, ...references, ...assessments, ...comments, ...tags];
  const segments = segmentTextWithAnnotations(content, allAnnotations);

  // Extract UI state
  const { selectedMotivation, selectedClick, selectedShape, hoveredAnnotationId, hoveredCommentId, scrollToAnnotationId } = uiState;

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
    console.log('[AnnotateView] annotation:hover received:', annotationId);
    onUIStateChangeRef.current?.({ hoveredAnnotationId: annotationId });
  }, []);

  // Subscribe to toolbar events and annotation hover
  useEventSubscriptions({
    'toolbar:selection-changed': handleToolbarSelectionChanged,
    'toolbar:click-changed': handleToolbarClickChanged,
    'toolbar:shape-changed': handleToolbarShapeChanged,
    'annotation:hover': handleAnnotationHover,
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
      // (those components handle their own annotation:requested events)
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
      if (!view || !view.posAtDOM) {
        // Fallback: try to find text in source (won't work for duplicates)
        const start = content.indexOf(text);
        if (start === -1) {
          return;
        }
        const end = start + text.length;

        // Extract context for TextQuoteSelector
        const context = extractContext(content, start, end);

        // Unified flow: all text annotations use BOTH TextPositionSelector and TextQuoteSelector
        if (selectedMotivation) {
          eventBus.emit('annotation:requested', {
            selector: [
              {
                type: 'TextPositionSelector',
                start,
                end
              },
              {
                type: 'TextQuoteSelector',
                exact: text,
                ...(context.prefix && { prefix: context.prefix }),
                ...(context.suffix && { suffix: context.suffix })
              }
            ],
            motivation: selectedMotivation
          });

          // Clear selection after creating annotation
          selection.removeAllRanges();
          return;
        }
        return;
      }

      // CodeMirror's posAtDOM gives us the position in the document from a DOM node/offset
      const start = view.posAtDOM(range.startContainer, range.startOffset);
      const end = start + text.length;

      if (start >= 0) {
        // Extract context for TextQuoteSelector
        const context = extractContext(content, start, end);

        // Unified flow: all text annotations use BOTH TextPositionSelector and TextQuoteSelector
        if (selectedMotivation) {
          eventBus.emit('annotation:requested', {
            selector: [
              {
                type: 'TextPositionSelector',
                start,
                end
              },
              {
                type: 'TextQuoteSelector',
                exact: text,
                ...(context.prefix && { prefix: context.prefix }),
                ...(context.suffix && { suffix: context.suffix })
              }
            ],
            motivation: selectedMotivation
          });

          // Clear selection after creating annotation
          selection.removeAllRanges();
          return;
        }
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
            {...(hoveredCommentId !== undefined && { hoveredCommentId })}
            {...(scrollToAnnotationId !== undefined && { scrollToAnnotationId })}
            sourceView={true}
            showLineNumbers={showLineNumbers}
            enableWidgets={enableWidgets}
            eventBus={eventBus}
            {...(getTargetDocumentName && { getTargetDocumentName })}
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
              {resourceUri && (
                <Suspense fallback={<div className="semiont-annotate-view__loading">Loading PDF viewer...</div>}>
                  <PdfAnnotationCanvas
                    resourceUri={toResourceUri(resourceUri)}
                    existingAnnotations={allAnnotations}
                    drawingMode={selectedMotivation ? selectedShape : null}
                    selectedMotivation={selectedMotivation}
                    eventBus={eventBus}
                    hoveredAnnotationId={hoveredCommentId || hoveredAnnotationId || null}
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
            {resourceUri && (
              <SvgDrawingCanvas
                resourceUri={toResourceUri(resourceUri)}
                existingAnnotations={allAnnotations}
                drawingMode={selectedMotivation ? selectedShape : null}
                selectedMotivation={selectedMotivation}
                eventBus={eventBus}
                hoveredAnnotationId={hoveredCommentId || hoveredAnnotationId || null}
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
                href={resourceUri}
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