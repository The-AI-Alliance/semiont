'use client';

import { useRef, useCallback, useEffect, lazy, Suspense } from 'react';
import type { components, Selector } from '@semiont/api-client';
import { getTextPositionSelector, getTextQuoteSelector, getTargetSelector, getMimeCategory, isPdfMimeType, resourceUri as toResourceUri } from '@semiont/api-client';
import type { Annotator } from '../../lib/annotation-registry';
import { SvgDrawingCanvas } from '../image-annotation/SvgDrawingCanvas';
import { useResourceAnnotations } from '../../contexts/ResourceAnnotationsContext';
import { findTextWithContext } from '@semiont/api-client';

// Lazy load PDF component to avoid SSR issues with browser PDF.js loading
const PdfAnnotationCanvas = lazy(() => import('../pdf-annotation/PdfAnnotationCanvas.client').then(mod => ({ default: mod.PdfAnnotationCanvas })));

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];

// Unified pending annotation type - all human-created annotations flow through this
interface PendingAnnotation {
  selector: Selector | Selector[];
  motivation: Motivation;
}

import { CodeMirrorRenderer } from '../CodeMirrorRenderer';
import type { TextSegment } from '../CodeMirrorRenderer';
import type { EditorView } from '@codemirror/view';
import { useMakeMeaningEvents } from '../../contexts/MakeMeaningEventBusContext';

// Type augmentation for custom DOM properties
interface EnrichedHTMLElement extends HTMLElement {
  __cmView?: EditorView;
}
import { AnnotateToolbar, type SelectionMotivation, type ClickAction, type ShapeType } from '../annotation/AnnotateToolbar';
import type { AnnotationsCollection, AnnotationHandlers, AnnotationCreationHandler, AnnotationUIState } from '../../types/annotation-props';

// Re-export for convenience
export type { SelectionMotivation, ClickAction, ShapeType };

interface Props {
  content: string;
  mimeType?: string;
  resourceUri?: string;
  annotations: AnnotationsCollection;
  handlers?: AnnotationHandlers;
  creationHandler?: AnnotationCreationHandler;
  uiState: AnnotationUIState;
  onUIStateChange?: (state: Partial<AnnotationUIState>) => void;
  editable?: boolean;
  enableWidgets?: boolean;
  onEntityTypeClick?: (entityType: string) => void;
  onReferenceNavigate?: (documentId: string) => void;
  onUnresolvedReferenceClick?: (annotation: Annotation) => void;
  getTargetDocumentName?: (documentId: string) => string | undefined;
  generatingReferenceId?: string | null;
  onDeleteAnnotation?: (annotation: Annotation) => void;
  showLineNumbers?: boolean;
  annotateMode: boolean;
  onAnnotationRequested?: (pending: PendingAnnotation) => void;
  annotators: Record<string, Annotator>;
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
  handlers,
  creationHandler,
  uiState,
  onUIStateChange,
  enableWidgets = false,
  onEntityTypeClick,
  onReferenceNavigate,
  onUnresolvedReferenceClick,
  getTargetDocumentName,
  generatingReferenceId,
  onDeleteAnnotation,
  showLineNumbers = false,
  annotateMode,
  onAnnotationRequested,
  annotators
}: Props) {
  const { newAnnotationIds } = useResourceAnnotations();
  const containerRef = useRef<HTMLDivElement>(null);
  const eventBus = useMakeMeaningEvents();

  const category = getMimeCategory(mimeType);

  const { highlights, references, assessments, comments, tags } = annotations;

  const allAnnotations = [...highlights, ...references, ...assessments, ...comments, ...tags];
  const segments = segmentTextWithAnnotations(content, allAnnotations);

  // Extract individual handlers from grouped objects
  const onAnnotationClick = handlers?.onClick;
  const onAnnotationHover = handlers?.onHover;
  const onCommentHover = handlers?.onCommentHover;

  const onCreate = creationHandler?.onCreate;

  // Extract UI state
  const { selectedMotivation, selectedClick, selectedShape, hoveredAnnotationId, hoveredCommentId, scrollToAnnotationId } = uiState;

  console.log('[AnnotateView] Current UI state:', {
    selectedMotivation,
    selectedShape,
    selectedClick,
    annotateMode
  });

  // Subscribe to toolbar events
  useEffect(() => {
    const handleSelectionChange = ({ motivation }: { motivation: string | null }) => {
      console.log('[AnnotateView] toolbar:selection-changed event with:', motivation);
      onUIStateChange?.({ selectedMotivation: motivation as SelectionMotivation | null });
    };

    const handleClickChange = ({ action }: { action: string }) => {
      onUIStateChange?.({ selectedClick: action as ClickAction });
    };

    const handleShapeChange = ({ shape }: { shape: string }) => {
      onUIStateChange?.({ selectedShape: shape as ShapeType });
    };

    eventBus.on('toolbar:selection-changed', handleSelectionChange);
    eventBus.on('toolbar:click-changed', handleClickChange);
    eventBus.on('toolbar:shape-changed', handleShapeChange);

    return () => {
      eventBus.off('toolbar:selection-changed', handleSelectionChange);
      eventBus.off('toolbar:click-changed', handleClickChange);
      eventBus.off('toolbar:shape-changed', handleShapeChange);
    };
  }, [eventBus, onUIStateChange]);

  // Wrapper for annotation hover that routes based on registry metadata
  const handleAnnotationHover = useCallback((annotationId: string | null) => {
    if (annotationId) {
      const annotation = allAnnotations.find(a => a.id === annotationId);
      const metadata = annotation ? Object.values(annotators).find(a => a.matchesAnnotation(annotation!)) : null;

      // Route to side panel if annotation type has one
      if (metadata?.hasSidePanel) {
        // Clear the other hover state when switching
        if (onAnnotationHover) onAnnotationHover(null);
        if (onCommentHover) onCommentHover(annotationId);
        return;
      } else {
        // Clear the other hover state when switching
        if (onCommentHover) onCommentHover(null);
        if (onAnnotationHover) onAnnotationHover(annotationId);
        return;
      }
    }
    // Clear both when null
    if (onAnnotationHover) onAnnotationHover(null);
    if (onCommentHover) onCommentHover(null);
  }, [allAnnotations, onAnnotationHover, onCommentHover, annotators]);

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

    const handleMouseUp = (_e: MouseEvent) => {
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
        if (selectedMotivation && onAnnotationRequested) {
          onAnnotationRequested({
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
        if (selectedMotivation && onAnnotationRequested) {
          onAnnotationRequested({
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
  }, [selectedMotivation, onCreate, content]);

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
            annotators={annotators}
          />
          <div className="semiont-annotate-view__content">
            <CodeMirrorRenderer
            content={content}
            segments={segments}
            {...(onAnnotationClick && { onAnnotationClick })}
            onAnnotationHover={handleAnnotationHover}
            editable={false}
            newAnnotationIds={newAnnotationIds}
            {...(hoveredAnnotationId !== undefined && { hoveredAnnotationId })}
            {...(hoveredCommentId !== undefined && { hoveredCommentId })}
            {...(scrollToAnnotationId !== undefined && { scrollToAnnotationId })}
            sourceView={true}
            showLineNumbers={showLineNumbers}
            enableWidgets={enableWidgets}
            {...(onEntityTypeClick && { onEntityTypeClick })}
            {...(onReferenceNavigate && { onReferenceNavigate })}
            {...(onUnresolvedReferenceClick && { onUnresolvedReferenceClick })}
            {...(getTargetDocumentName && { getTargetDocumentName })}
            {...(generatingReferenceId !== undefined && { generatingReferenceId })}
            {...(onDeleteAnnotation && { onDeleteAnnotation })}
            annotators={annotators}
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
              annotators={annotators}
            />
            <div className="semiont-annotate-view__content">
              {resourceUri && (
                <Suspense fallback={<div className="semiont-annotate-view__loading">Loading PDF viewer...</div>}>
                  <PdfAnnotationCanvas
                    resourceUri={toResourceUri(resourceUri)}
                    existingAnnotations={allAnnotations}
                    drawingMode={selectedMotivation ? selectedShape : null}
                    selectedMotivation={selectedMotivation}
                    onAnnotationCreate={async (fragmentSelector) => {
                      if (!selectedMotivation) return;

                      // Unified flow: all annotations go through pending state
                      onAnnotationRequested?.({
                        selector: {
                          type: 'FragmentSelector',
                          conformsTo: 'http://tools.ietf.org/rfc/rfc3778',
                          value: fragmentSelector
                        },
                        motivation: selectedMotivation
                      });
                    }}
                    {...(onAnnotationClick && { onAnnotationClick })}
                    {...(onAnnotationHover && { onAnnotationHover: handleAnnotationHover })}
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
            annotators={annotators}
          />
          <div className="semiont-annotate-view__content">
            {resourceUri && (
              <SvgDrawingCanvas
                resourceUri={toResourceUri(resourceUri)}
                existingAnnotations={allAnnotations}
                drawingMode={selectedMotivation ? selectedShape : null}
                selectedMotivation={selectedMotivation}
                onAnnotationCreate={async (svg) => {
                  if (!selectedMotivation) return;

                  // Unified flow: all annotations go through pending state
                  onAnnotationRequested?.({
                    selector: {
                      type: 'SvgSelector',
                      value: svg
                    },
                    motivation: selectedMotivation
                  });
                }}
                {...(onAnnotationClick && { onAnnotationClick })}
                {...(onAnnotationHover && { onAnnotationHover: handleAnnotationHover })}
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