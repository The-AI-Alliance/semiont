'use client';

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { getTextPositionSelector, getTargetSelector, getMimeCategory } from '@semiont/api-client';
import { getAnnotationTypeMetadata } from '@/lib/annotation-registry';
import { ImageViewer } from '@/components/viewers';

type Annotation = components['schemas']['Annotation'];
import { useResourceAnnotations } from '@/contexts/ResourceAnnotationsContext';
import { CodeMirrorRenderer } from '@/components/CodeMirrorRenderer';
import type { TextSegment } from '@/components/CodeMirrorRenderer';
import { AnnotateToolbar, type SelectionMotivation, type ClickMotivation } from '@/components/annotation/AnnotateToolbar';
import '@/styles/animations.css';

// Re-export for convenience
export type { SelectionMotivation, ClickMotivation };

interface Props {
  content: string;
  mimeType?: string;
  resourceUri?: string;
  highlights: Annotation[];
  references: Annotation[];
  assessments: Annotation[];
  comments: Annotation[];
  onTextSelect?: (exact: string, position: { start: number; end: number }) => void;
  onAnnotationClick?: (annotation: Annotation) => void;
  onAnnotationHover?: (annotationId: string | null) => void;
  onCommentHover?: (commentId: string | null) => void;
  hoveredAnnotationId?: string | null;
  hoveredCommentId?: string | null;
  scrollToAnnotationId?: string | null;
  editable?: boolean;
  enableWidgets?: boolean;
  onEntityTypeClick?: (entityType: string) => void;
  onReferenceNavigate?: (documentId: string) => void;
  onUnresolvedReferenceClick?: (annotation: Annotation) => void;
  getTargetDocumentName?: (documentId: string) => string | undefined;
  generatingReferenceId?: string | null;
  onDeleteAnnotation?: (annotation: Annotation) => void;
  showLineNumbers?: boolean;
  selectedSelection?: SelectionMotivation | null;
  selectedClick?: ClickMotivation;
  onSelectionChange?: (motivation: SelectionMotivation | null) => void;
  onClickChange?: (motivation: ClickMotivation) => void;
  onCreateHighlight?: (exact: string, position: { start: number; end: number }) => void;
  onCreateAssessment?: (exact: string, position: { start: number; end: number }) => void;
  onCreateComment?: (exact: string, position: { start: number; end: number }) => void;
  onCreateReference?: (exact: string, position: { start: number; end: number }, popupPosition: { x: number; y: number }) => void;
}

// Segment text with annotations - SIMPLE because it's source view!
function segmentTextWithAnnotations(exact: string, annotations: Annotation[]): TextSegment[] {
  if (!exact) {
    return [{ exact: '', start: 0, end: 0 }];
  }

  const normalizedAnnotations = annotations
    .map(ann => {
      const targetSelector = getTargetSelector(ann.target);
      const posSelector = getTextPositionSelector(targetSelector);
      return {
        annotation: ann,
        start: posSelector?.start ?? 0,
        end: posSelector?.end ?? 0
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
  highlights,
  references,
  assessments,
  comments,
  onTextSelect,
  onAnnotationClick,
  onAnnotationHover,
  onCommentHover,
  hoveredAnnotationId,
  hoveredCommentId,
  scrollToAnnotationId,
  editable = false,
  enableWidgets = false,
  onEntityTypeClick,
  onReferenceNavigate,
  onUnresolvedReferenceClick,
  getTargetDocumentName,
  generatingReferenceId,
  onDeleteAnnotation,
  showLineNumbers = false,
  selectedSelection = 'linking',
  selectedClick = 'detail',
  onSelectionChange,
  onClickChange,
  onCreateHighlight,
  onCreateAssessment,
  onCreateComment,
  onCreateReference
}: Props) {
  const t = useTranslations('AnnotateView');
  const { newAnnotationIds } = useResourceAnnotations();
  const containerRef = useRef<HTMLDivElement>(null);
  const [annotationState, setSelectionState] = useState<{
    exact: string;
    start: number;
    end: number;
    rects: DOMRect[];
  } | null>(null);

  const category = getMimeCategory(mimeType);

  // Combine annotations
  const allAnnotations = [...highlights, ...references, ...assessments, ...comments];
  const segments = segmentTextWithAnnotations(content, allAnnotations);

  // Wrapper for annotation hover that routes based on registry metadata
  const handleAnnotationHover = useCallback((annotationId: string | null) => {
    if (annotationId) {
      const annotation = allAnnotations.find(a => a.id === annotationId);
      const metadata = annotation ? getAnnotationTypeMetadata(annotation) : null;

      // Route to side panel if annotation type has one
      if (metadata?.hasSidePanel && onCommentHover) {
        onCommentHover(annotationId);
        return;
      }
    }
    // For non-side-panel annotations or null, call the regular handler
    if (onAnnotationHover) {
      onAnnotationHover(annotationId);
    }
  }, [allAnnotations, onAnnotationHover, onCommentHover]);

  // Handle text annotation with sparkle or immediate creation
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString()) {
        setSelectionState(null);
        return;
      }

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

        // Check motivation and either create immediately or show sparkle
        if (selectedSelection === 'highlighting' && onCreateHighlight) {
          onCreateHighlight(text, { start, end });
          selection.removeAllRanges();
          return;
        } else if (selectedSelection === 'assessing' && onCreateAssessment) {
          onCreateAssessment(text, { start, end });
          selection.removeAllRanges();
          return;
        } else if (selectedSelection === 'commenting' && onCreateComment) {
          onCreateComment(text, { start, end });
          // Keep visual selection while Comment Panel is open
          setSelectionState({ exact: text, start, end, rects });
          return;
        } else if (selectedSelection === 'linking' && onCreateReference && rects.length > 0) {
          // Calculate popup position from rects
          const lastRect = rects[rects.length - 1];
          if (lastRect) {
            onCreateReference(text, { start, end }, { x: lastRect.left, y: lastRect.bottom + 10 });
            // Keep visual selection while Quick Reference popup is open
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
        // Check motivation and either create immediately or show sparkle
        if (selectedSelection === 'highlighting' && onCreateHighlight) {
          onCreateHighlight(text, { start, end });
          selection.removeAllRanges();
          return;
        } else if (selectedSelection === 'assessing' && onCreateAssessment) {
          onCreateAssessment(text, { start, end });
          selection.removeAllRanges();
          return;
        } else if (selectedSelection === 'commenting' && onCreateComment) {
          onCreateComment(text, { start, end });
          // Keep visual selection while Comment Panel is open
          setSelectionState({ exact: text, start, end, rects });
          return;
        } else if (selectedSelection === 'linking' && onCreateReference && rects.length > 0) {
          // Calculate popup position from rects
          const lastRect = rects[rects.length - 1];
          if (lastRect) {
            onCreateReference(text, { start, end }, { x: lastRect.left, y: lastRect.bottom + 10 });
            // Keep visual selection while Quick Reference popup is open
            setSelectionState({ exact: text, start, end, rects });
          }
          return;
        }
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest('[data-annotation-ui]')) {
        setSelectionState(null);
      }
    };

    container.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      container.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [selectedSelection, onCreateHighlight, onCreateAssessment, onCreateComment, onCreateReference, content]);

  // Route to appropriate viewer based on MIME type category
  switch (category) {
    case 'text':
      return (
        <div className="relative h-full flex flex-col" ref={containerRef}>
          <AnnotateToolbar
            selectedSelection={selectedSelection}
            selectedClick={selectedClick}
            onSelectionChange={onSelectionChange || (() => {})}
            onClickChange={onClickChange || (() => {})}
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
            selectedSelection={selectedSelection}
            selectedClick={selectedClick}
            onSelectionChange={onSelectionChange || (() => {})}
            onClickChange={onClickChange || (() => {})}
          />
          <div className="flex-1 overflow-auto">
            {resourceUri && (
              <ImageViewer
                resourceUri={resourceUri as any}
                mimeType={mimeType}
                alt="Resource content"
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