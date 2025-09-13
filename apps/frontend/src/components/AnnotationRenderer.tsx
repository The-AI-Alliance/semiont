"use client";

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkWikiLink from 'remark-wiki-link';
import { annotationStyles } from '@/lib/annotation-styles';
import { CodeMirrorRenderer } from './CodeMirrorRenderer';

/**
 * ANNOTATION RENDERER - AXIOMATIC IMPLEMENTATION
 * 
 * Core principles:
 * 1. Immutable text content - annotations only add styling
 * 2. Position fidelity - character positions are preserved exactly
 * 3. Declarative rendering - no DOM manipulation after initial render
 * 4. Separation of concerns - selection UI is independent of annotations
 */

// Types
export interface AnnotationSelection {
  id: string;
  documentId: string;
  selectionData?: {
    type: string;
    offset: number;
    length: number;
    text: string;
  };
  text?: string;
  referencedDocumentId?: string;
  entityType?: string;
  entityTypes?: string[];
  referenceType?: string;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface Props {
  content: string;
  contentType?: string;
  highlights: AnnotationSelection[];
  references: AnnotationSelection[];
  onWikiLinkClick?: (pageName: string) => void;
  onTextSelect?: (text: string, position: { start: number; end: number }) => void;
  onHighlightClick?: (highlight: AnnotationSelection) => void;
  onReferenceClick?: (reference: AnnotationSelection) => void;
  onAnnotationRightClick?: (annotation: AnnotationSelection, x: number, y: number) => void;
}

export interface TextSegment {
  text: string;
  annotation?: AnnotationSelection;
  start: number;
  end: number;
}

// Pure function to segment text with annotations
function segmentTextWithAnnotations(
  text: string,
  annotations: AnnotationSelection[]
): TextSegment[] {
  // Handle empty text case
  if (!text) {
    return [{ text: '', start: 0, end: 0 }];
  }
  
  // Convert annotations to a normalized format with positions
  const normalizedAnnotations = annotations
    .map(ann => ({
      annotation: ann,
      start: ann.selectionData?.offset ?? 0,
      end: (ann.selectionData?.offset ?? 0) + (ann.selectionData?.length ?? 0)
    }))
    .filter(a => a.start >= 0 && a.end <= text.length && a.start < a.end)
    .sort((a, b) => a.start - b.start);
  
  // If no valid annotations, return the whole text as one segment
  if (normalizedAnnotations.length === 0) {
    return [{ text, start: 0, end: text.length }];
  }
  
  const segments: TextSegment[] = [];
  let position = 0;
  
  for (const { annotation, start, end } of normalizedAnnotations) {
    // Skip if this annotation overlaps with the previous one
    if (start < position) continue;
    
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

// Get annotation styling using centralized styles

// Component to render a text segment
const SegmentRenderer: React.FC<{
  segment: TextSegment;
  onAnnotationClick?: (annotation: AnnotationSelection) => void;
  onAnnotationRightClick?: (annotation: AnnotationSelection, x: number, y: number) => void;
}> = React.memo(({ segment, onAnnotationClick, onAnnotationRightClick }) => {
  if (!segment.annotation) {
    return <>{segment.text}</>;
  }
  
  // Determine hover text based on annotation type
  const hoverText = segment.annotation.type === 'highlight' 
    ? 'Right-click to delete or convert to reference'
    : segment.annotation.referencedDocumentId
      ? 'Click to navigate • Right-click for options'
      : (segment.annotation as any).entityTypes?.length > 0 || segment.annotation.entityType
        ? `Entity: ${(segment.annotation as any).entityTypes?.[0] || segment.annotation.entityType} • Right-click for options`
        : 'Right-click to link to document or delete';
  
  return (
    <span
      className={annotationStyles.getAnnotationStyle(segment.annotation)}
      data-annotation-id={segment.annotation.id}
      data-start={segment.start}
      data-end={segment.end}
      title={hoverText}
      onClick={(e) => {
        e.stopPropagation();
        if (onAnnotationClick) {
          onAnnotationClick(segment.annotation!);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onAnnotationRightClick) {
          onAnnotationRightClick(segment.annotation!, e.clientX, e.clientY);
        }
      }}
    >
      {segment.text}
    </span>
  );
});

SegmentRenderer.displayName = 'SegmentRenderer';

// Main component
export function AnnotationRenderer({
  content,
  contentType = 'markdown',
  highlights,
  references,
  onWikiLinkClick,
  onTextSelect,
  onHighlightClick,
  onReferenceClick,
  onAnnotationRightClick
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectionState, setSelectionState] = useState<{
    text: string;
    start: number;
    end: number;
    rects: DOMRect[];
  } | null>(null);
  
  // Combine and process annotations
  const segments = useMemo(() => {
    const allAnnotations = [
      ...highlights.map(h => ({ ...h, type: 'highlight' })),
      ...references.map(r => ({ ...r, type: 'reference' }))
    ];
    
    return segmentTextWithAnnotations(content, allAnnotations);
  }, [content, highlights, references]);
  
  // Handle annotation clicks
  const handleAnnotationClick = useCallback((annotation: AnnotationSelection) => {
    if (annotation.type === 'highlight' && onHighlightClick) {
      onHighlightClick(annotation);
    } else if (annotation.type === 'reference' && onReferenceClick) {
      onReferenceClick(annotation);
    }
  }, [onHighlightClick, onReferenceClick]);
  
  // Handle text selection (separate from annotation rendering)
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
      // Get all rectangles for multi-line selections
      const rects = Array.from(range.getClientRects());
      
      // Calculate position in SOURCE text
      const text = selection.toString();
      
      // For plain text, the rendered text matches the source text
      // So we can directly find the position
      const sourceText = content;
      const start = sourceText.indexOf(text);
      const end = start >= 0 ? start + text.length : -1;
      
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
  }, []);
  
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
  
  // Render content based on type
  const renderContent = () => {
    if (contentType === 'markdown') {
      // Use CodeMirror for markdown - it handles position mapping correctly!
      const props: any = {
        content,
        segments,
        onAnnotationClick: handleAnnotationClick,
        theme: "light",
        editable: false
      };
      if (onAnnotationRightClick) {
        props.onAnnotationRightClick = onAnnotationRightClick;
      }
      if (onWikiLinkClick) {
        props.onWikiLinkClick = onWikiLinkClick;
      }
      return <CodeMirrorRenderer {...props} />;
    }
    
    // For non-markdown, render segments directly
    return (
      <pre className="font-mono text-sm whitespace-pre-wrap">
        {segments.map((segment, i) => (
          <SegmentRenderer
            key={`${segment.start}-${segment.end}-${segment.annotation?.id || i}`}
            segment={segment}
            onAnnotationClick={handleAnnotationClick}
            {...(onAnnotationRightClick && { onAnnotationRightClick })}
          />
        ))}
      </pre>
    );
  };
  
  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="prose prose-lg dark:prose-invert max-w-none selection:bg-blue-200 dark:selection:bg-blue-800"
        onContextMenu={handleContextMenu}
      >
        {renderContent()}
      </div>
      
      {/* Selection UI overlay */}
      {selectionState && (
        <>
          {/* Render a highlight rectangle for each line of the selection */}
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
          
          {/* Position sparkle at the end of the last rectangle */}
          {(() => {
            const lastRect = selectionState.rects[selectionState.rects.length - 1];
            const containerRect = containerRef.current?.getBoundingClientRect();
            if (!lastRect || !containerRect) return null;
            
            return (
              <button
                onClick={handleSparkleClick}
                className="absolute z-50 text-xl hover:scale-125 transition-transform cursor-pointer animate-bounce"
                style={{
                  left: `${lastRect.right - containerRect.left + 5}px`,
                  top: `${lastRect.top - containerRect.top + lastRect.height / 2}px`,
                  transform: 'translateY(-50%)'
                }}
                title="Click to create highlight • Right-click for more options"
                data-selection-ui
              >
                ✨
              </button>
            );
          })()}
        </>
      )}
    </div>
  );
}
      
      // Get all text nodes in the container
      const walker = document.createTreeWalker(
        containerRef.current,
        NodeFilter.SHOW_TEXT,
        null
      );
      
      const textNodes: Array<{ node: Text; start: number; length: number }> = [];
      let position = 0;
      let node;
      
      while (node = walker.nextNode()) {
        const textNode = node as Text;
        const length = textNode.textContent?.length || 0;
        textNodes.push({ node: textNode, start: position, length });
        position += length;
      }
      
      // Apply annotations to text nodes
      for (const segment of segments) {
        if (!segment.annotation) continue;
        
        // Find text nodes that overlap with this segment
        for (const { node, start, length } of textNodes) {
          const nodeEnd = start + length;
          
          // Check for overlap
          if (segment.start < nodeEnd && segment.end > start) {
            const overlapStart = Math.max(0, segment.start - start);
            const overlapEnd = Math.min(length, segment.end - start);
            
            if (overlapStart < overlapEnd && node.parentNode) {
              // Wrap the overlapping portion
              const text = node.textContent || '';
              const before = text.substring(0, overlapStart);
              const annotated = text.substring(overlapStart, overlapEnd);
              const after = text.substring(overlapEnd);
              
              const span = document.createElement('span');
              span.className = annotationStyles.getAnnotationStyle(segment.annotation);
              span.textContent = annotated;
              span.setAttribute('data-annotation-id', segment.annotation.id);
              span.setAttribute('data-markdown-container', 'true');
              
              // Add event handlers
              span.onclick = () => onAnnotationClick(segment.annotation!);
              if (onAnnotationRightClick) {
                span.oncontextmenu = (e) => {
                  e.preventDefault();
                  onAnnotationRightClick(segment.annotation!, e.clientX, e.clientY);
                };
              }
              
              // Replace node with new structure
              const parent = node.parentNode;
              const fragment = document.createDocumentFragment();
              
              if (before) fragment.appendChild(document.createTextNode(before));
              fragment.appendChild(span);
              if (after) fragment.appendChild(document.createTextNode(after));
              
              parent.replaceChild(fragment, node);
              break; // Move to next segment
            }
          }
        }
      }
    }, 100); // Delay to ensure markdown is fully rendered
    
    return () => clearTimeout(timeoutId);
  }, [segments, onAnnotationClick, onAnnotationRightClick]);
  
  return (
    <div ref={containerRef} data-markdown-container>
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          [remarkWikiLink, {
            pageResolver: (name: string) => [name.replace(/ /g, '_').toLowerCase()],
            hrefTemplate: (permalink: string) => `#${permalink}`
          }]
        ]}
        components={{
          // Headings
          h1: ({ children }) => (
            <h1 className="text-3xl font-bold mb-4 text-gray-900 dark:text-white">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-2xl font-semibold mb-3 text-gray-900 dark:text-white">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">{children}</h3>
          ),
          // Paragraphs and text
          p: ({ children }) => (
            <p className="mb-4 text-gray-700 dark:text-gray-300 leading-relaxed">{children}</p>
          ),
          // Lists
          ul: ({ children }) => (
            <ul className="list-disc list-inside mb-4 text-gray-700 dark:text-gray-300">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside mb-4 text-gray-700 dark:text-gray-300">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="mb-1">{children}</li>
          ),
          // Links - handle wiki links specially
          a: ({ href, children }) => {
            if (href?.startsWith('#') && onWikiLinkClick) {
              const pageName = href.substring(1).replace(/_/g, ' ');
              return (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onWikiLinkClick(pageName);
                  }}
                  className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                >
                  {children}
                </a>
              );
            }
            return (
              <a 
                href={href} 
                className="text-blue-600 dark:text-blue-400 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            );
          },
          // Code blocks
          code: ({ className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || '');
            return match ? (
              <pre className="bg-gray-100 dark:bg-gray-800 rounded p-3 mb-4 overflow-x-auto">
                <code className={className}>{children}</code>
              </pre>
            ) : (
              <code className="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-sm">
                {children}
              </code>
            );
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};