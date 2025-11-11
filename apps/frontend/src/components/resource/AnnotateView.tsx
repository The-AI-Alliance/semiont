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
import { AnnotateToolbar, type AnnotationMotivation } from '@/components/annotation/AnnotateToolbar';
import '@/styles/animations.css';

// Re-export for convenience
export type { AnnotationMotivation };

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
  onAnnotationRightClick?: (annotation: Annotation, x: number, y: number) => void;
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
  onConvertAnnotation?: (annotation: Annotation) => void;
  showLineNumbers?: boolean;
  selectedMotivation?: AnnotationMotivation;
  onMotivationChange?: (motivation: AnnotationMotivation) => void;
  onCreateHighlight?: (exact: string, position: { start: number; end: number }) => void;
  onCreateAssessment?: (exact: string, position: { start: number; end: number }) => void;
  onCreateComment?: (exact: string, position: { start: number; end: number }) => void;
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
  onAnnotationRightClick,
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
  onConvertAnnotation,
  showLineNumbers = false,
  selectedMotivation = 'linking',
  onMotivationChange,
  onCreateHighlight,
  onCreateAssessment,
  onCreateComment
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
        if (selectedMotivation === 'highlighting' && onCreateHighlight) {
          onCreateHighlight(text, { start, end });
          selection.removeAllRanges();
          return;
        } else if (selectedMotivation === 'assessing' && onCreateAssessment) {
          onCreateAssessment(text, { start, end });
          selection.removeAllRanges();
          return;
        } else if (selectedMotivation === 'commenting' && onCreateComment) {
          onCreateComment(text, { start, end });
          selection.removeAllRanges();
          return;
        } else if (onTextSelect && rects.length > 0) {
          setSelectionState({ exact: text, start, end, rects });
        }
        return;
      }

      // CodeMirror's posAtDOM gives us the position in the document from a DOM node/offset
      const start = view.posAtDOM(range.startContainer, range.startOffset);
      const end = start + text.length;

      if (start >= 0) {
        // Check motivation and either create immediately or show sparkle
        if (selectedMotivation === 'highlighting' && onCreateHighlight) {
          onCreateHighlight(text, { start, end });
          selection.removeAllRanges();
          return;
        } else if (selectedMotivation === 'assessing' && onCreateAssessment) {
          onCreateAssessment(text, { start, end });
          selection.removeAllRanges();
          return;
        } else if (selectedMotivation === 'commenting' && onCreateComment) {
          onCreateComment(text, { start, end });
          selection.removeAllRanges();
          return;
        } else if (onTextSelect && rects.length > 0) {
          setSelectionState({ exact: text, start, end, rects });

          // Announce to screen readers
          const announcement = document.createElement('div');
          announcement.setAttribute('role', 'status');
          announcement.setAttribute('aria-live', 'polite');
          announcement.className = 'sr-only';
          announcement.textContent = 'Text selected. Sparkle button available to create annotation, or press H for highlight, R for reference.';
          document.body.appendChild(announcement);
          setTimeout(() => announcement.remove(), 1000);
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
  }, [onTextSelect, selectedMotivation, onCreateHighlight, onCreateAssessment, onCreateComment, content]);
  
  // Handle sparkle click
  const handleSparkleClick = useCallback(() => {
    if (annotationState && onTextSelect) {
      onTextSelect(annotationState.exact, {
        start: annotationState.start,
        end: annotationState.end
      });
      setSelectionState(null);
    }
  }, [annotationState, onTextSelect]);
  
  // Handle right-click on annotation
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (annotationState && onTextSelect) {
      e.preventDefault();
      onTextSelect(annotationState.exact, {
        start: annotationState.start,
        end: annotationState.end
      });
      setSelectionState(null);
    }
  }, [annotationState, onTextSelect]);

  // Route to appropriate viewer based on MIME type category
  switch (category) {
    case 'text':
      return (
        <div className="relative h-full flex flex-col" ref={containerRef} onContextMenu={handleContextMenu}>
          <AnnotateToolbar
            selectedMotivation={selectedMotivation}
            onMotivationChange={onMotivationChange || (() => {})}
          />
          <div className="flex-1 overflow-auto">
            <CodeMirrorRenderer
            content={content}
            segments={segments}
            {...(onAnnotationClick && { onAnnotationClick })}
            {...(onAnnotationRightClick && { onAnnotationRightClick })}
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
            {...(onConvertAnnotation && { onConvertAnnotation })}
          />

          {/* Sparkle UI - THE GOOD STUFF WE'RE KEEPING! */}
          {annotationState && onTextSelect && (
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

              {/* Sparkle at the end */}
              {(() => {
                const lastRect = annotationState.rects[annotationState.rects.length - 1];
                const containerRect = containerRef.current?.getBoundingClientRect();
                if (!lastRect || !containerRect) return null;

                return (
                  <button
                    onClick={handleSparkleClick}
                    className="absolute z-50 hover:scale-125 transition-transform cursor-pointer animate-bounce focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:ring-offset-2"
                    style={{
                      left: `${lastRect.right - containerRect.left + 5}px`,
                      top: `${lastRect.top - containerRect.top + lastRect.height / 2}px`,
                      transform: 'translateY(-50%)'
                    }}
                    aria-label={t('ariaLabel')}
                    title={t('tooltip')}
                    data-annotation-ui
                  >
                    <span className="relative inline-flex items-center justify-center">
                      {/* Pulsing ring animation */}
                      <span className="absolute inset-0 rounded-full bg-yellow-400 dark:bg-yellow-500 opacity-75 animate-ping" aria-hidden="true"></span>
                      {/* Solid background circle */}
                      <span className="relative inline-flex items-center justify-center w-8 h-8 rounded-full bg-white dark:bg-gray-800 ring-2 ring-yellow-400 dark:ring-yellow-500 shadow-lg">
                        <span className="text-xl" aria-hidden="true">✨</span>
                      </span>
                    </span>
                  </button>
                );
              })()}
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
            onMotivationChange={onMotivationChange || (() => {})}
          />
          {/* Warning banner */}
          <div className="absolute top-0 left-0 right-0 z-50 bg-yellow-100 dark:bg-yellow-900 border-b border-yellow-200 dark:border-yellow-800 p-3" style={{ marginTop: '56px' }}>
            <p className="text-sm text-yellow-800 dark:text-yellow-200 text-center">
              Image annotation is not yet supported. Switch to Browse mode to view the image.
            </p>
          </div>
          {/* Image viewer offset by banner */}
          <div className="flex-1 overflow-auto" style={{ paddingTop: '56px' }}>
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