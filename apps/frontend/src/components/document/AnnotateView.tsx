'use client';

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { annotationStyles } from '@/lib/annotation-styles';
import type { Annotation } from '@/contexts/DocumentAnnotationsContext';
import { useDocumentAnnotations } from '@/contexts/DocumentAnnotationsContext';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import '@/styles/animations.css';

interface Props {
  content: string;
  highlights: Annotation[];
  references: Annotation[];
  onTextSelect?: (text: string, position: { start: number; end: number }) => void;
  onAnnotationClick?: (annotation: Annotation) => void;
  onAnnotationRightClick?: (annotation: Annotation, x: number, y: number) => void;
  editable?: boolean;
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
  editable = false
}: Props) {
  const { newAnnotationIds } = useDocumentAnnotations();
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedAnnotationIndex, setFocusedAnnotationIndex] = useState<number>(-1);
  const [selectionState, setSelectionState] = useState<{
    text: string;
    start: number;
    end: number;
    rects: DOMRect[];
  } | null>(null);
  
  // Combine annotations
  const allAnnotations = [...highlights, ...references];
  const segments = segmentTextWithAnnotations(content, allAnnotations);
  const annotatedSegments = segments.filter(s => s.annotation);

  // Navigate through annotations with Tab key
  const navigateToAnnotation = useCallback((direction: 'next' | 'prev') => {
    if (annotatedSegments.length === 0) return;

    let nextIndex = focusedAnnotationIndex;
    if (direction === 'next') {
      nextIndex = (focusedAnnotationIndex + 1) % annotatedSegments.length;
    } else {
      nextIndex = focusedAnnotationIndex === -1
        ? annotatedSegments.length - 1
        : (focusedAnnotationIndex - 1 + annotatedSegments.length) % annotatedSegments.length;
    }

    setFocusedAnnotationIndex(nextIndex);

    // Find and focus the annotation element
    const annotation = annotatedSegments[nextIndex].annotation;
    if (annotation) {
      const element = containerRef.current?.querySelector(
        `[data-annotation-id="${annotation.id}"]`
      ) as HTMLElement;
      if (element) {
        element.focus();
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [focusedAnnotationIndex, annotatedSegments]);

  // Register keyboard shortcuts for annotation navigation
  useKeyboardShortcuts([
    {
      key: 'Tab',
      handler: (e) => {
        if (!containerRef.current?.contains(document.activeElement)) return;
        e.preventDefault();
        navigateToAnnotation(e.shiftKey ? 'prev' : 'next');
      },
      description: 'Navigate through annotations'
    }
  ]);
  
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
      
      // For source view, position calculation is SIMPLE!
      // Just count characters from the start
      const preSelectionRange = document.createRange();
      preSelectionRange.selectNodeContents(container);
      preSelectionRange.setEnd(range.startContainer, range.startOffset);
      
      const start = preSelectionRange.toString().length;
      const end = start + text.length;
      
      if (start >= 0 && rects.length > 0) {
        setSelectionState({ text, start, end, rects });
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
  
  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="font-mono text-sm bg-gray-50 dark:bg-gray-900 p-4 rounded-lg overflow-x-auto"
        onContextMenu={handleContextMenu}
      >
        <pre className="whitespace-pre-wrap break-words">
          {segments.map((segment, i) => {
            if (!segment.annotation) {
              return <span key={`${segment.start}-${segment.end}`}>{segment.text}</span>;
            }
            
            const isReference = segment.annotation.type === 'reference';
            const hasTarget = segment.annotation.referencedDocumentId;
            const isStubReference = isReference && !hasTarget;
            
            const hoverText = segment.annotation.type === 'highlight'
              ? 'Right-click to delete or convert to reference'
              : isStubReference
                ? 'Click to create referenced document • Right-click for options'
                : hasTarget
                ? 'Click to navigate • Right-click for options'
                : 'Right-click for options';

            const isNew = newAnnotationIds.has(segment.annotation.id);
            const baseClassName = annotationStyles.getAnnotationStyle(segment.annotation);
            const className = isNew ? `${baseClassName} annotation-sparkle` : baseClassName;

            const annotationIndex = annotatedSegments.findIndex(
              s => s.annotation?.id === segment.annotation?.id
            );
            const isFocused = annotationIndex === focusedAnnotationIndex;

            return (
              <span
                key={segment.annotation.id}
                className={`${className} ${isFocused ? 'ring-2 ring-cyan-500 ring-offset-2' : ''}`}
                data-annotation-id={segment.annotation.id}
                title={hoverText}
                tabIndex={isFocused ? 0 : -1}
                role="button"
                aria-label={`${segment.annotation.type === 'reference' ? 'Reference' : 'Highlight'}: ${segment.text}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setFocusedAnnotationIndex(annotationIndex);
                  if (onAnnotationClick) {
                    onAnnotationClick(segment.annotation!);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (onAnnotationClick) {
                      onAnnotationClick(segment.annotation!);
                    }
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (onAnnotationRightClick) {
                    onAnnotationRightClick(segment.annotation!, e.clientX, e.clientY);
                  }
                }}
                onFocus={() => setFocusedAnnotationIndex(annotationIndex)}
              >
                {segment.text}
              </span>
            );
          })}
        </pre>
      </div>
      
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
                className="absolute z-50 hover:scale-125 transition-transform cursor-pointer animate-bounce"
                style={{
                  left: `${lastRect.right - containerRect.left + 5}px`,
                  top: `${lastRect.top - containerRect.top + lastRect.height / 2}px`,
                  transform: 'translateY(-50%)'
                }}
                title="Click to create highlight • Right-click for more options"
                data-selection-ui
              >
                <span className="relative inline-flex items-center justify-center">
                  {/* Pulsing ring animation */}
                  <span className="absolute inset-0 rounded-full bg-yellow-400 dark:bg-yellow-500 opacity-75 animate-ping"></span>
                  {/* Solid background circle */}
                  <span className="relative inline-flex items-center justify-center w-8 h-8 rounded-full bg-white dark:bg-gray-800 ring-2 ring-yellow-400 dark:ring-yellow-500 shadow-lg">
                    <span className="text-xl">✨</span>
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