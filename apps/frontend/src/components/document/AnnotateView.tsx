'use client';

import React, { useRef, useState, useCallback, useEffect } from 'react';
import type { Annotation } from '@semiont/core-types';
import { useDocumentAnnotations } from '@/contexts/DocumentAnnotationsContext';
import { CodeMirrorRenderer } from '@/components/CodeMirrorRenderer';
import type { TextSegment as CMTextSegment } from '@/components/CodeMirrorRenderer';
import '@/styles/animations.css';

interface Props {
  content: string;
  highlights: Annotation[];
  references: Annotation[];
  onTextSelect?: (text: string, position: { start: number; end: number }) => void;
  onAnnotationClick?: (annotation: Annotation) => void;
  onAnnotationRightClick?: (annotation: Annotation, x: number, y: number) => void;
  onAnnotationHover?: (annotationId: string | null) => void;
  hoveredAnnotationId?: string | null;
  scrollToAnnotationId?: string | null;
  editable?: boolean;
  enableWidgets?: boolean;
  onWikiLinkClick?: (pageName: string) => void;
  onEntityTypeClick?: (entityType: string) => void;
  onReferenceNavigate?: (documentId: string) => void;
  onUnresolvedReferenceClick?: (annotation: any) => void;
  getTargetDocumentName?: (documentId: string) => string | undefined;
  generatingReferenceId?: string | null;
  onDeleteAnnotation?: (annotation: any) => void;
  onConvertAnnotation?: (annotation: any) => void;
  showLineNumbers?: boolean;
}

interface TextSegment {
  text: string;
  annotation?: Annotation;
  start: number;
  end: number;
}

// Segment text with annotations - SIMPLE because it's source view!
function segmentTextWithAnnotations(text: string, annotations: Annotation[]): TextSegment[] {
  if (!text) {
    return [{ text: '', start: 0, end: 0 }];
  }
  
  const normalizedAnnotations = annotations
    .map(ann => ({
      annotation: ann,
      start: ann.selectionData?.offset ?? 0,
      end: (ann.selectionData?.offset ?? 0) + (ann.selectionData?.length ?? 0)
    }))
    .filter(a => a.start >= 0 && a.end <= text.length && a.start < a.end)
    .sort((a, b) => a.start - b.start);
  
  if (normalizedAnnotations.length === 0) {
    return [{ text, start: 0, end: text.length }];
  }
  
  const segments: TextSegment[] = [];
  let position = 0;
  
  for (const { annotation, start, end } of normalizedAnnotations) {
    if (start < position) continue; // Skip overlapping annotations
    
    // Add text before annotation
    if (start > position) {
      segments.push({
        text: text.slice(position, start),
        start: position,
        end: start
      });
    }
    
    // Add annotated segment
    segments.push({
      text: text.slice(start, end),
      annotation,
      start,
      end
    });
    
    position = end;
  }
  
  // Add remaining text
  if (position < text.length) {
    segments.push({
      text: text.slice(position),
      start: position,
      end: text.length
    });
  }
  
  return segments;
}

export function AnnotateView({
  content,
  highlights,
  references,
  onTextSelect,
  onAnnotationClick,
  onAnnotationRightClick,
  onAnnotationHover,
  hoveredAnnotationId,
  scrollToAnnotationId,
  editable = false,
  enableWidgets = false,
  onWikiLinkClick,
  onEntityTypeClick,
  onReferenceNavigate,
  onUnresolvedReferenceClick,
  getTargetDocumentName,
  generatingReferenceId,
  onDeleteAnnotation,
  onConvertAnnotation,
  showLineNumbers = false
}: Props) {
  const { newAnnotationIds } = useDocumentAnnotations();
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectionState, setSelectionState] = useState<{
    text: string;
    start: number;
    end: number;
    rects: DOMRect[];
  } | null>(null);

  // Combine annotations
  const allAnnotations = [...highlights, ...references];
  const segments = segmentTextWithAnnotations(content, allAnnotations);
  
  // Handle text selection with sparkle
  useEffect(() => {
    if (!onTextSelect) return;

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
        if (rects.length > 0) {
          setSelectionState({ text, start, end, rects });
        }
        return;
      }

      // CodeMirror's posAtDOM gives us the position in the document from a DOM node/offset
      const start = view.posAtDOM(range.startContainer, range.startOffset);
      const end = start + text.length;

      if (start >= 0 && rects.length > 0) {
        setSelectionState({ text, start, end, rects });

        // Announce to screen readers
        const announcement = document.createElement('div');
        announcement.setAttribute('role', 'status');
        announcement.setAttribute('aria-live', 'polite');
        announcement.className = 'sr-only';
        announcement.textContent = 'Text selected. Sparkle button available to create annotation, or press H for highlight, R for reference.';
        document.body.appendChild(announcement);
        setTimeout(() => announcement.remove(), 1000);
      }
    };
    
    const handleMouseDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest('[data-selection-ui]')) {
        setSelectionState(null);
      }
    };
    
    container.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);
    
    return () => {
      container.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [onTextSelect]);
  
  // Handle sparkle click
  const handleSparkleClick = useCallback(() => {
    if (selectionState && onTextSelect) {
      onTextSelect(selectionState.text, {
        start: selectionState.start,
        end: selectionState.end
      });
      setSelectionState(null);
    }
  }, [selectionState, onTextSelect]);
  
  // Handle right-click on selection
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (selectionState && onTextSelect) {
      e.preventDefault();
      onTextSelect(selectionState.text, {
        start: selectionState.start,
        end: selectionState.end
      });
      setSelectionState(null);
    }
  }, [selectionState, onTextSelect]);
  
  // Convert segments to CodeMirror format
  const cmSegments: CMTextSegment[] = segments.map(seg => ({
    text: seg.text,
    annotation: seg.annotation as any, // Types are compatible
    start: seg.start,
    end: seg.end
  }));

  return (
    <div className="relative h-full" ref={containerRef} onContextMenu={handleContextMenu}>
      <CodeMirrorRenderer
        content={content}
        segments={cmSegments}
        onAnnotationClick={onAnnotationClick as any}
        onAnnotationRightClick={onAnnotationRightClick as any}
        {...(onAnnotationHover && { onAnnotationHover })}
        editable={false}
        newAnnotationIds={newAnnotationIds}
        {...(hoveredAnnotationId !== undefined && { hoveredAnnotationId })}
        {...(scrollToAnnotationId !== undefined && { scrollToAnnotationId })}
        sourceView={true}
        showLineNumbers={showLineNumbers}
        enableWidgets={enableWidgets}
        {...(onWikiLinkClick && { onWikiLinkClick })}
        {...(onEntityTypeClick && { onEntityTypeClick })}
        {...(onReferenceNavigate && { onReferenceNavigate })}
        {...(onUnresolvedReferenceClick && { onUnresolvedReferenceClick })}
        {...(getTargetDocumentName && { getTargetDocumentName })}
        {...(generatingReferenceId !== undefined && { generatingReferenceId })}
        {...(onDeleteAnnotation && { onDeleteAnnotation })}
        {...(onConvertAnnotation && { onConvertAnnotation })}
      />
      
      {/* Sparkle UI - THE GOOD STUFF WE'RE KEEPING! */}
      {selectionState && onTextSelect && (
        <>
          {/* Dashed ring around selection */}
          {selectionState.rects.map((rect, index) => (
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
            const lastRect = selectionState.rects[selectionState.rects.length - 1];
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
                aria-label="Create annotation from selected text. Press H for highlight or R for reference."
                title="Click to create highlight • Right-click for more options"
                data-selection-ui
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
  );
}