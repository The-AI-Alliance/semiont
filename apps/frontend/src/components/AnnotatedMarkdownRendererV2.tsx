"use client";

import React, { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkWikiLink from 'remark-wiki-link';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';

// ============================================================================
// Types - Clear, explicit data structures
// ============================================================================

interface TextRange {
  start: number;
  end: number;
}

interface Selection {
  id: string;
  documentId: string;
  range: TextRange;
  text: string;
  type?: string;
  referencedDocumentId?: string;
  entityType?: string;
  referenceType?: string;
}

interface AnnotatedSegment {
  text: string;
  annotation?: Selection;
  start: number;
  end: number;
}

interface Props {
  content: string;
  highlights: Selection[];
  references: Selection[];
  onWikiLinkClick?: (pageName: string) => void;
  onTextSelect?: (text: string, position: TextRange) => void;
  onHighlightClick?: (highlight: Selection) => void;
  onReferenceClick?: (reference: Selection) => void;
  onAnnotationRightClick?: (annotation: Selection, x: number, y: number) => void;
}

// ============================================================================
// Pure Functions - No side effects, easy to test
// ============================================================================

/**
 * Merge and sort all annotations by start position
 */
function mergeAnnotations(highlights: Selection[], references: Selection[]): Selection[] {
  return [...highlights, ...references].sort((a, b) => {
    const aStart = a.range?.start ?? 0;
    const bStart = b.range?.start ?? 0;
    return aStart - bStart;
  });
}

/**
 * Convert text and annotations into non-overlapping segments
 */
function createSegments(text: string, annotations: Selection[]): AnnotatedSegment[] {
  if (annotations.length === 0) {
    return [{ text, start: 0, end: text.length }];
  }

  const segments: AnnotatedSegment[] = [];
  let currentPos = 0;

  for (const annotation of annotations) {
    const start = annotation.range?.start ?? 0;
    const end = annotation.range?.end ?? 0;

    // Add unannotated text before this annotation
    if (currentPos < start) {
      segments.push({
        text: text.slice(currentPos, start),
        start: currentPos,
        end: start
      });
    }

    // Add annotated segment
    if (start < end && end <= text.length) {
      segments.push({
        text: text.slice(start, end),
        annotation,
        start,
        end
      });
      currentPos = end;
    }
  }

  // Add remaining text
  if (currentPos < text.length) {
    segments.push({
      text: text.slice(currentPos),
      start: currentPos,
      end: text.length
    });
  }

  return segments;
}

/**
 * Get CSS classes for an annotation
 */
function getAnnotationClasses(annotation: Selection): string {
  const base = "cursor-pointer transition-colors rounded px-0.5";
  
  if (annotation.type === 'highlight') {
    return `${base} bg-yellow-200 hover:bg-yellow-300 dark:bg-yellow-900/50 dark:hover:bg-yellow-800/50`;
  }
  
  if (annotation.referenceType === 'entity') {
    return `${base} bg-purple-200 hover:bg-purple-300 dark:bg-purple-900/50 dark:hover:bg-purple-800/50`;
  }
  
  // Document reference
  return `${base} bg-gradient-to-r from-cyan-200 to-blue-200 hover:from-cyan-300 hover:to-blue-300 
          dark:from-cyan-900/50 dark:to-blue-900/50 dark:hover:from-cyan-800/50 dark:hover:to-blue-800/50`;
}

// ============================================================================
// Components - Focused, single-responsibility
// ============================================================================

/**
 * Renders a single segment of text with optional annotation
 */
const TextSegment: React.FC<{
  segment: AnnotatedSegment;
  onAnnotationClick?: (annotation: Selection) => void;
  onAnnotationRightClick?: (annotation: Selection, x: number, y: number) => void;
}> = ({ segment, onAnnotationClick, onAnnotationRightClick }) => {
  if (!segment.annotation) {
    return <>{segment.text}</>;
  }

  const handleClick = () => {
    if (onAnnotationClick) {
      onAnnotationClick(segment.annotation!);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (onAnnotationRightClick) {
      onAnnotationRightClick(segment.annotation!, e.clientX, e.clientY);
    }
  };

  return (
    <span
      className={getAnnotationClasses(segment.annotation)}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      data-annotation-id={segment.annotation.id}
      data-annotation-type={segment.annotation.type}
    >
      {segment.text}
    </span>
  );
};

/**
 * Selection UI overlay - completely separate from content
 */
const SelectionOverlay: React.FC<{
  containerRef: React.RefObject<HTMLDivElement>;
  onTextSelect?: (text: string, position: TextRange) => void;
}> = ({ containerRef, onTextSelect }) => {
  const [selection, setSelection] = useState<{
    text: string;
    range: TextRange;
    rect: DOMRect;
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setSelection(null);
        return;
      }

      const text = sel.toString();
      if (!text) {
        setSelection(null);
        return;
      }

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();

      // Calculate text position
      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentElement;
            if (parent?.tagName === 'CODE' || parent?.tagName === 'SCRIPT') {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      let offset = 0;
      let startOffset = -1;
      let endOffset = -1;
      let node;

      while (node = walker.nextNode()) {
        const textNode = node as Text;
        const length = textNode.textContent?.length || 0;

        if (textNode === range.startContainer) {
          startOffset = offset + range.startOffset;
        }
        if (textNode === range.endContainer) {
          endOffset = offset + range.endOffset;
          break;
        }

        offset += length;
      }

      if (startOffset >= 0 && endOffset >= 0) {
        setSelection({
          text,
          range: { start: startOffset, end: endOffset },
          rect
        });
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      // Clear selection if clicking outside
      if (!(e.target as Element).closest('[data-selection-ui]')) {
        setSelection(null);
      }
    };

    container.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      container.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [containerRef]);

  const handleSparkleClick = () => {
    if (selection && onTextSelect) {
      onTextSelect(selection.text, selection.range);
      setSelection(null);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (selection && onTextSelect) {
      e.preventDefault();
      onTextSelect(selection.text, selection.range);
      setSelection(null);
    }
  };

  if (!selection || !containerRef.current) return null;

  const containerRect = containerRef.current.getBoundingClientRect();
  const relativeRect = {
    left: selection.rect.left - containerRect.left,
    top: selection.rect.top - containerRect.top,
    width: selection.rect.width,
    height: selection.rect.height,
    right: selection.rect.right - containerRect.left
  };

  return (
    <div data-selection-ui onContextMenu={handleContextMenu}>
      {/* Selection outline */}
      <div
        className="absolute pointer-events-none z-40"
        style={{
          left: `${relativeRect.left}px`,
          top: `${relativeRect.top}px`,
          width: `${relativeRect.width}px`,
          height: `${relativeRect.height}px`,
          border: '2px dashed rgba(250, 204, 21, 0.6)',
          borderRadius: '3px',
          backgroundColor: 'rgba(254, 240, 138, 0.2)',
          animation: 'pulse 2s ease-in-out infinite'
        }}
      />
      
      {/* Sparkle button */}
      <button
        onClick={handleSparkleClick}
        className="absolute z-50 text-xl hover:scale-125 transition-transform cursor-pointer animate-bounce"
        style={{
          left: `${relativeRect.right + 5}px`,
          top: `${relativeRect.top + relativeRect.height / 2}px`,
          transform: 'translateY(-50%)'
        }}
        title="Click to create annotation"
        data-selection-ui
      >
        ✨
      </button>
    </div>
  );
};

/**
 * Main component - coordinates everything
 */
export function AnnotatedMarkdownRendererV2({
  content,
  highlights,
  references,
  onWikiLinkClick,
  onTextSelect,
  onHighlightClick,
  onReferenceClick,
  onAnnotationRightClick
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Process content into segments
  const segments = useMemo(() => {
    const allAnnotations = mergeAnnotations(highlights, references);
    return createSegments(content, allAnnotations);
  }, [content, highlights, references]);

  // Handle annotation clicks
  const handleAnnotationClick = useCallback((annotation: Selection) => {
    if (annotation.type === 'highlight' && onHighlightClick) {
      onHighlightClick(annotation);
    } else if (annotation.type === 'reference' && onReferenceClick) {
      onReferenceClick(annotation);
    }
  }, [onHighlightClick, onReferenceClick]);

  // Markdown components
  const components = useMemo(() => ({
    // Custom rendering for wiki links
    a: ({ href, children, ...props }: any) => {
      if (href?.startsWith('#')) {
        const pageName = href.substring(1).replace(/_/g, ' ');
        return (
          <button
            onClick={(e) => {
              e.preventDefault();
              if (onWikiLinkClick) {
                onWikiLinkClick(pageName);
              }
            }}
            className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 underline cursor-pointer"
            {...props}
          >
            {children}
          </button>
        );
      }
      return <a href={href} {...props}>{children}</a>;
    },
    // Style other markdown elements
    h1: ({ children }: any) => (
      <h1 className="text-3xl font-bold mb-4 text-gray-900 dark:text-white">{children}</h1>
    ),
    h2: ({ children }: any) => (
      <h2 className="text-2xl font-semibold mb-3 text-gray-900 dark:text-white">{children}</h2>
    ),
    h3: ({ children }: any) => (
      <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">{children}</h3>
    ),
    p: ({ children }: any) => (
      <p className="mb-4 text-gray-700 dark:text-gray-300 leading-relaxed">
        {/* Process children to apply annotations */}
        {React.Children.map(children, (child, index) => {
          if (typeof child === 'string') {
            // This is plain text, apply annotations
            const textSegments = segments.filter(s => 
              s.start < s.end && child.includes(s.text)
            );
            
            if (textSegments.length === 0) {
              return child;
            }

            return textSegments.map((segment, i) => {
              const props: any = {
                key: `${index}-${i}`,
                segment,
                onAnnotationClick: handleAnnotationClick
              };
              if (onAnnotationRightClick) {
                props.onAnnotationRightClick = onAnnotationRightClick;
              }
              return <TextSegment {...props} />;
            });
          }
          return child;
        })}
      </p>
    ),
    // ... other markdown components
  }), [segments, handleAnnotationClick, onAnnotationRightClick, onWikiLinkClick]);

  return (
    <div className="relative">
      <div 
        ref={containerRef}
        data-markdown-container
        className="prose prose-lg dark:prose-invert max-w-none selection:bg-blue-200 dark:selection:bg-blue-800"
      >
        <ReactMarkdown
          remarkPlugins={[
            remarkGfm,
            [remarkWikiLink, {
              pageResolver: (name: string) => [name.replace(/ /g, '_').toLowerCase()],
              hrefTemplate: (permalink: string) => `#${permalink}`
            }]
          ]}
          rehypePlugins={[rehypeHighlight]}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </div>
      
      {onTextSelect && (
        <SelectionOverlay 
          containerRef={containerRef}
          onTextSelect={onTextSelect}
        />
      )}
    </div>
  );
}