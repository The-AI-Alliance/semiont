'use client';

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { getTextPositionSelector, getTextQuoteSelector, getTargetSelector, getMimeCategory, resourceUri as toResourceUri } from '@semiont/api-client';
import { getAnnotator } from '../lib/annotation-registry';
import { ImageViewer } from '../components/viewers';
import { SvgDrawingCanvas, type DrawingMode } from '../components/image-annotation/SvgDrawingCanvas';
import { useResourceAnnotations } from '../contexts/ResourceAnnotationsContext';
import { findTextWithContext } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
import { CodeMirrorRenderer } from '../components/CodeMirrorRenderer';
import type { TextSegment } from '../components/CodeMirrorRenderer';
import { AnnotateToolbar, type SelectionMotivation, type ClickAction, type ShapeType } from '../components/annotation/AnnotateToolbar';
import type { AnnotationsCollection, AnnotationHandlers, AnnotationCreationHandler, AnnotationUIState, CreateAnnotationParams } from '@/types/annotation-props';
import '@/styles/animations.css';

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
  onAnnotateModeToggle: () => void;
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
function segmentTextWithAnnotations(exact: string, annotations: Annotation[]): TextSegment[] {
  if (!exact) {
    return [{ exact: '', start: 0, end: 0 }];
  }

  const normalizedAnnotations = annotations
    .map(ann => {
      const targetSelector = getTargetSelector(ann.target);
      const posSelector = getTextPositionSelector(targetSelector);
      const quoteSelector = targetSelector ? getTextQuoteSelector(targetSelector) : null;

      console.log('[AnnotateView] Processing annotation:', {
        id: ann.id?.substring(Math.max(0, (ann.id?.length || 0) - 10)),
        exact: quoteSelector?.exact,
        posSelector
      });

      // Try fuzzy anchoring if TextQuoteSelector with context is available
      let position;
      if (quoteSelector && (quoteSelector.prefix || quoteSelector.suffix)) {
        // Use fuzzy anchoring when prefix/suffix context is available
        // This helps when content changes or same text appears multiple times
        console.log('[AnnotateView] Trying fuzzy anchoring:', {
          exact: quoteSelector.exact,
          prefix: quoteSelector.prefix?.substring(0, 50),
          suffix: quoteSelector.suffix?.substring(0, 50),
          contentLength: exact.length,
          contentPreview: exact.substring(0, 100)
        });
        position = findTextWithContext(
          exact,
          quoteSelector.exact,
          quoteSelector.prefix,
          quoteSelector.suffix
        );
        console.log('[AnnotateView] Fuzzy anchoring result:', position);
      }

      // Fallback to TextPositionSelector or fuzzy position
      const start = position?.start ?? posSelector?.start ?? 0;
      const end = position?.end ?? posSelector?.end ?? 0;
      console.log('[AnnotateView] Final position:', { start, end, posSelector, position });

      return {
        annotation: ann,
        start,
        end
      };
    })
    .filter(a => a.start >= 0 && a.end <= exact.length && a.start < a.end)
    .sort((a, b) => a.start - b.start);

  if (normalizedAnnotations.length === 0) {
    return [{ exact, start: 0, end: exact.length }];
  }

  const segments: TextSegment[] = [];
  let position = 0;

  for (const { annotation, start, end } of normalizedAnnotations) {
    if (start < position) continue; // Skip overlapping annotations

    // Add text before annotation
    if (start > position) {
      segments.push({
        exact: exact.slice(position, start),
        start: position,
        end: start
      });
    }

    // Add annotated segment
    segments.push({
      exact: exact.slice(start, end),
      annotation,
      start,
      end
    });

    position = end;
  }

  // Add remaining text
  if (position < exact.length) {
    segments.push({
      exact: exact.slice(position),
      start: position,
      end: exact.length
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
  editable = false,
  enableWidgets = false,
  onEntityTypeClick,
  onReferenceNavigate,
  onUnresolvedReferenceClick,
  getTargetDocumentName,
  generatingReferenceId,
  onDeleteAnnotation,
  showLineNumbers = false,
  annotateMode,
  onAnnotateModeToggle
}: Props) {
  const t = useTranslations('AnnotateView');
  const { newAnnotationIds, createAnnotation } = useResourceAnnotations();
  const containerRef = useRef<HTMLDivElement>(null);
  const [annotationState, setSelectionState] = useState<{
    exact: string;
    start: number;
    end: number;
    rects: DOMRect[];
  } | null>(null);

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

  // UI state change handlers
  const onSelectionChange = (motivation: SelectionMotivation | null) => {
    onUIStateChange?.({ selectedMotivation: motivation });
  };
  const onClickChange = (motivation: ClickAction) => {
    onUIStateChange?.({ selectedClick: motivation });
  };
  const onShapeChange = (shape: ShapeType) => {
    onUIStateChange?.({ selectedShape: shape });
  };

  // Wrapper for annotation hover that routes based on registry metadata
  const handleAnnotationHover = useCallback((annotationId: string | null) => {
    if (annotationId) {
      const annotation = allAnnotations.find(a => a.id === annotationId);
      const metadata = annotation ? getAnnotator(annotation) : null;

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
  }, [allAnnotations, onAnnotationHover, onCommentHover]);

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
        setSelectionState(null);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString()) {
        setSelectionState(null);
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
      const rects = Array.from(range.getClientRects());
      const text = selection.toString();

      // Get the CodeMirror EditorView instance stored on the CodeMirror container
      const cmContainer = container.querySelector('.codemirror-renderer');
      const view = (cmContainer as any)?.__cmView;
      if (!view || !view.posAtDOM) {
        // Fallback: try to find text in source (won't work for duplicates)
        const start = content.indexOf(text);
        if (start === -1) {
          return;
        }
        const end = start + text.length;

        // Extract context for TextQuoteSelector
        const context = extractContext(content, start, end);

        // Use unified onCreate handler
        if (selectedMotivation && onCreate) {
          // Calculate popup position for Quick Reference (if needed)
          let position: { x: number; y: number } | undefined;
          if (selectedMotivation === 'linking' && rects.length > 0) {
            const lastRect = rects[rects.length - 1];
            if (lastRect) {
              position = { x: lastRect.left, y: lastRect.bottom + 10 };
            }
          }

          onCreate({
            motivation: selectedMotivation,
            selector: {
              type: 'TextQuoteSelector',
              exact: text,
              ...(context.prefix && { prefix: context.prefix }),
              ...(context.suffix && { suffix: context.suffix }),
              start,
              end
            },
            ...(position && { position })
          });

          // Clear selection for immediate creates (highlighting, assessing)
          if (selectedMotivation === 'highlighting' || selectedMotivation === 'assessing') {
            selection.removeAllRanges();
          } else {
            // Keep visual selection for commenting and linking
            setSelectionState({ exact: text, start, end, rects });
          }
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

        // Use unified onCreate handler
        if (selectedMotivation && onCreate) {
          // Calculate popup position for Quick Reference (if needed)
          let position: { x: number; y: number } | undefined;
          if (selectedMotivation === 'linking' && rects.length > 0) {
            const lastRect = rects[rects.length - 1];
            if (lastRect) {
              position = { x: lastRect.left, y: lastRect.bottom + 10 };
            }
          }

          onCreate({
            motivation: selectedMotivation,
            selector: {
              type: 'TextQuoteSelector',
              exact: text,
              ...(context.prefix && { prefix: context.prefix }),
              ...(context.suffix && { suffix: context.suffix }),
              start,
              end
            },
            ...(position && { position })
          });

          // Clear selection for immediate creates (highlighting, assessing)
          if (selectedMotivation === 'highlighting' || selectedMotivation === 'assessing') {
            selection.removeAllRanges();
          } else {
            // Keep visual selection for commenting and linking
            setSelectionState({ exact: text, start, end, rects });
          }
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
        <div className="relative h-full flex flex-col" ref={containerRef}>
          <AnnotateToolbar
            selectedMotivation={selectedMotivation}
            selectedClick={selectedClick}
            onSelectionChange={onSelectionChange || (() => {})}
            onClickChange={onClickChange || (() => {})}
            annotateMode={annotateMode}
            onAnnotateModeToggle={onAnnotateModeToggle}
          />
          <div className="flex-1 overflow-auto">
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
          />

          {/* Visual selection indicator for linking mode */}
          {annotationState && (
            <>
              {/* Dashed ring around selection */}
              {annotationState.rects.map((rect, index) => (
                <div
                  key={index}
                  className="absolute pointer-events-none z-40"
                  style={{
                    left: `${rect.left - containerRef.current!.getBoundingClientRect().left}px`,
                    top: `${rect.top - containerRef.current!.getBoundingClientRect().top}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`,
                    border: '2px dashed rgba(250, 204, 21, 0.6)',
                    borderRadius: '3px',
                    backgroundColor: 'rgba(254, 240, 138, 0.2)',
                    animation: 'pulse 2s ease-in-out infinite'
                  }}
                />
              ))}
            </>
          )}
          </div>
        </div>
      );

    case 'image':
      return (
        <div className="relative h-full flex flex-col" ref={containerRef}>
          <AnnotateToolbar
            selectedMotivation={selectedMotivation}
            selectedClick={selectedClick}
            onSelectionChange={onSelectionChange}
            onClickChange={onClickChange}
            showShapeGroup={true}
            selectedShape={selectedShape}
            onShapeChange={onShapeChange}
            annotateMode={annotateMode}
            onAnnotateModeToggle={onAnnotateModeToggle}
          />
          <div className="flex-1 overflow-auto">
            {resourceUri && (
              <SvgDrawingCanvas
                resourceUri={toResourceUri(resourceUri)}
                existingAnnotations={allAnnotations}
                drawingMode={selectedMotivation ? selectedShape : null}
                selectedMotivation={selectedMotivation}
                onAnnotationCreate={async (svg, position) => {
                  // Use unified onCreate handler for image annotations
                  if (selectedMotivation && onCreate) {
                    onCreate({
                      motivation: selectedMotivation,
                      selector: {
                        type: 'SvgSelector',
                        value: svg
                      },
                      ...(position && { position })
                    });
                  }
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
        <div ref={containerRef} className="flex items-center justify-center h-full p-8">
          <div className="text-center space-y-4">
            <p className="text-gray-600 dark:text-gray-400">
              Annotation not supported for {mimeType}
            </p>
            {resourceUri && (
              <a
                href={resourceUri}
                download
                className="inline-block px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Download File
              </a>
            )}
          </div>
        </div>
      );
  }
}