"use client";

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkWikiLink from 'remark-wiki-link';

// Types
interface AnnotationSelection {
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

// Helper to process text with annotations
function processTextWithAnnotations(
  text: string,
  annotations: Array<{ start: number; end: number; type: string; annotation: AnnotationSelection }>
): React.ReactNode[] {
  if (annotations.length === 0) {
    return [text];
  }

  // Sort annotations by start position
  const sorted = [...annotations].sort((a, b) => a.start - b.start);
  
  const result: React.ReactNode[] = [];
  let lastEnd = 0;
  
  sorted.forEach((ann, index) => {
    // Add text before annotation
    if (ann.start > lastEnd) {
      result.push(text.substring(lastEnd, ann.start));
    }
    
    // Add annotated text
    const annotatedText = text.substring(ann.start, ann.end);
    const className = getAnnotationClassName(ann.annotation);
    
    result.push(
      <span
        key={`ann-${index}`}
        className={className}
        data-annotation-id={ann.annotation.id}
        style={{ cursor: 'pointer' }}
      >
        {annotatedText}
      </span>
    );
    
    lastEnd = ann.end;
  });
  
  // Add remaining text
  if (lastEnd < text.length) {
    result.push(text.substring(lastEnd));
  }
  
  return result;
}

function getAnnotationClassName(annotation: AnnotationSelection): string {
  const base = "rounded px-0.5 ";
  
  if (annotation.type === 'highlight') {
    return base + "bg-yellow-200 hover:bg-yellow-300 dark:bg-yellow-900/50 dark:hover:bg-yellow-800/50";
  }
  
  if (annotation.referenceType === 'entity') {
    return base + "bg-purple-200 hover:bg-purple-300 dark:bg-purple-900/50 dark:hover:bg-purple-800/50";
  }
  
  // Document reference
  return base + "bg-gradient-to-r from-cyan-200 to-blue-200 hover:from-cyan-300 hover:to-blue-300 " +
         "dark:from-cyan-900/50 dark:to-blue-900/50 dark:hover:from-cyan-800/50 dark:hover:to-blue-800/50";
}

export function AnnotatedRenderer({
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
  const [sparkle, setSparkle] = useState<{ x: number; y: number } | null>(null);
  const [selectionBox, setSelectionBox] = useState<DOMRect | null>(null);
  const [currentSelection, setCurrentSelection] = useState<{ text: string; start: number; end: number } | null>(null);
  
  // Prepare all annotations with type field
  const allAnnotations = useMemo(() => {
    const typedHighlights = highlights.map(h => ({ 
      ...h, 
      type: 'highlight',
      start: h.selectionData?.offset ?? 0,
      end: (h.selectionData?.offset ?? 0) + (h.selectionData?.length ?? 0)
    }));
    const typedReferences = references.map(r => ({ 
      ...r, 
      type: 'reference',
      start: r.selectionData?.offset ?? 0,
      end: (r.selectionData?.offset ?? 0) + (r.selectionData?.length ?? 0)
    }));
    
    return [...typedHighlights, ...typedReferences].sort((a, b) => a.start - b.start);
  }, [highlights, references]);
  
  // Process content with annotations
  const processedContent = useMemo(() => {
    // For markdown, we need to handle this differently
    // For now, let's just apply annotations inline
    if (contentType !== 'markdown') {
      return processTextWithAnnotations(content, 
        allAnnotations.map(a => ({
          start: a.start,
          end: a.end,
          type: a.type || '',
          annotation: a
        }))
      );
    }
    
    // For markdown, we'll apply annotations post-render
    return content;
  }, [content, contentType, allAnnotations]);
  
  // Handle text selection
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    const handleMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setSparkle(null);
        setSelectionBox(null);
        setCurrentSelection(null);
        return;
      }
      
      const text = selection.toString();
      if (!text) {
        setSparkle(null);
        setSelectionBox(null);
        setCurrentSelection(null);
        return;
      }
      
      // Calculate position in original text
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      
      // Walk through text nodes to find position
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
        setSparkle({
          x: rect.right - containerRect.left + 5,
          y: rect.top - containerRect.top + rect.height / 2
        });
        
        setSelectionBox(rect);
        setCurrentSelection({
          text,
          start: startOffset,
          end: endOffset
        });
      }
    };
    
    const handleMouseDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest('[data-selection-ui]')) {
        setSparkle(null);
        setSelectionBox(null);
        setCurrentSelection(null);
      }
    };
    
    container.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);
    
    return () => {
      container.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, []);
  
  // Apply annotations to rendered markdown
  useEffect(() => {
    if (!containerRef.current || contentType !== 'markdown') return;
    
    // Add a small delay to ensure markdown has rendered
    const timeoutId = setTimeout(() => {
      if (!containerRef.current) return;
      
      // Clear existing annotation spans
      const existingSpans = containerRef.current.querySelectorAll('span[data-annotation-id]');
      existingSpans.forEach(span => {
        const parent = span.parentNode;
        if (parent) {
          // Create a text node with the span's content
          const textNode = document.createTextNode(span.textContent || '');
          // Replace the span with the text node
          parent.replaceChild(textNode, span);
        }
      });
      
      // Sort annotations by start position (reverse order to process from end to start)
      const sortedAnnotations = [...allAnnotations].sort((a, b) => b.start - a.start);
      
      console.log('Applying annotations:', sortedAnnotations);
      
      // Build a map of all text nodes and their positions first
      const textNodeMap: Array<{node: Text, start: number, end: number}> = [];
      const walker = document.createTreeWalker(
        containerRef.current!,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            // Skip already annotated text
            if ((node.parentElement as HTMLElement)?.hasAttribute('data-annotation-id')) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      
      let currentPos = 0;
      let node;
      while (node = walker.nextNode()) {
        const textNode = node as Text;
        const nodeLength = textNode.textContent?.length || 0;
        textNodeMap.push({
          node: textNode,
          start: currentPos,
          end: currentPos + nodeLength
        });
        currentPos += nodeLength;
      }
      
      console.log(`Found ${textNodeMap.length} text nodes in document`);
      
      // Process annotations in reverse order (from end to start) to avoid position shifts
      sortedAnnotations.forEach((annotation, annotationIndex) => {
        const annotationStart = annotation.start;
        const annotationEnd = annotation.end;
        
        console.log(`Processing annotation ${annotationIndex}: ${annotation.type} from ${annotationStart} to ${annotationEnd}`);
        
        // Find text nodes that overlap with this annotation
        textNodeMap.forEach(({ node: textNode, start: nodeStart, end: nodeEnd }) => {
          // Skip if node doesn't overlap with annotation
          if (annotationEnd <= nodeStart || annotationStart >= nodeEnd) {
            return;
          }
          
          // Skip if node is no longer in DOM
          if (!textNode.parentNode) {
            return;
          }
          
          const text = textNode.textContent || '';
          const parent = textNode.parentNode;
          
          // Calculate overlap
          const overlapStart = Math.max(0, annotationStart - nodeStart);
          const overlapEnd = Math.min(text.length, annotationEnd - nodeStart);
          
          if (overlapStart >= overlapEnd) {
            return;
          }
          
          const beforeText = text.substring(0, overlapStart);
          const annotatedText = text.substring(overlapStart, overlapEnd);
          const afterText = text.substring(overlapEnd);
          
          // Create annotated span
          const span = document.createElement('span');
          span.className = getAnnotationClassName(annotation);
          span.textContent = annotatedText;
          span.setAttribute('data-annotation-id', annotation.id);
          span.style.cursor = 'pointer';
          
          // Add click handlers
          span.onclick = (e) => {
            e.stopPropagation();
            if (annotation.type === 'highlight' && onHighlightClick) {
              onHighlightClick(annotation);
            } else if (annotation.type === 'reference' && onReferenceClick) {
              onReferenceClick(annotation);
            }
          };
          
          span.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (onAnnotationRightClick) {
              onAnnotationRightClick(annotation, e.clientX, e.clientY);
            }
          };
          
          // Build replacement fragment
          const fragment = document.createDocumentFragment();
          if (beforeText) {
            fragment.appendChild(document.createTextNode(beforeText));
          }
          fragment.appendChild(span);
          if (afterText) {
            fragment.appendChild(document.createTextNode(afterText));
          }
          
          // Replace the text node
          try {
            parent.replaceChild(fragment, textNode);
            // Update the textNodeMap entry to reflect the change
            textNode.textContent = ''; // Mark as processed
          } catch (e) {
            console.error('Failed to apply annotation:', e);
          }
        });
      });
    }, 50); // Small delay to ensure markdown rendering is complete
    
    return () => clearTimeout(timeoutId);
  }, [allAnnotations, contentType, onHighlightClick, onReferenceClick, onAnnotationRightClick]);
  
  // Handle context menu and sparkle click
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (currentSelection && onTextSelect) {
      e.preventDefault();
      onTextSelect(currentSelection.text, {
        start: currentSelection.start,
        end: currentSelection.end
      });
      setSparkle(null);
      setSelectionBox(null);
      setCurrentSelection(null);
    }
  }, [currentSelection, onTextSelect]);
  
  const handleSparkleClick = useCallback(() => {
    if (currentSelection && onTextSelect) {
      onTextSelect(currentSelection.text, {
        start: currentSelection.start,
        end: currentSelection.end
      });
      setSparkle(null);
      setSelectionBox(null);
      setCurrentSelection(null);
    }
  }, [currentSelection, onTextSelect]);
  
  // Markdown components
  const markdownComponents = useMemo(() => ({
    // Headings
    h1: ({ children }: any) => (
      <h1 className="text-3xl font-bold mb-4 text-gray-900 dark:text-white">{children}</h1>
    ),
    h2: ({ children }: any) => (
      <h2 className="text-2xl font-semibold mb-3 text-gray-900 dark:text-white">{children}</h2>
    ),
    h3: ({ children }: any) => (
      <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">{children}</h3>
    ),
    // Paragraphs
    p: ({ children }: any) => (
      <p className="mb-4 text-gray-700 dark:text-gray-300 leading-relaxed">{children}</p>
    ),
    // Lists
    ul: ({ children }: any) => (
      <ul className="list-disc list-inside mb-4 text-gray-700 dark:text-gray-300">{children}</ul>
    ),
    ol: ({ children }: any) => (
      <ol className="list-decimal list-inside mb-4 text-gray-700 dark:text-gray-300">{children}</ol>
    ),
    li: ({ children }: any) => (
      <li className="mb-1">{children}</li>
    ),
    // Blockquote
    blockquote: ({ children }: any) => (
      <blockquote className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 mb-4 italic text-gray-600 dark:text-gray-400">
        {children}
      </blockquote>
    ),
    // Code
    code: ({ className, children, ...props }: any) => {
      const match = /language-(\w+)/.exec(className || '');
      const isInline = !match;
      
      if (isInline) {
        return (
          <code className="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-sm font-mono" {...props}>
            {children}
          </code>
        );
      }
      
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    pre: ({ children }: any) => (
      <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-4 overflow-x-auto">
        {children}
      </pre>
    ),
    // Links
    a: ({ href, children }: any) => {
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
          >
            {children}
          </button>
        );
      }
      return <a href={href} className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 underline">{children}</a>;
    },
    // Horizontal rule
    hr: () => <hr className="my-6 border-gray-300 dark:border-gray-600" />,
    // Tables
    table: ({ children }: any) => (
      <table className="min-w-full mb-4 border-collapse">{children}</table>
    ),
    thead: ({ children }: any) => (
      <thead className="border-b border-gray-300 dark:border-gray-600">{children}</thead>
    ),
    tbody: ({ children }: any) => <tbody>{children}</tbody>,
    tr: ({ children }: any) => (
      <tr className="border-b border-gray-200 dark:border-gray-700">{children}</tr>
    ),
    th: ({ children }: any) => (
      <th className="px-4 py-2 text-left font-semibold text-gray-900 dark:text-white">{children}</th>
    ),
    td: ({ children }: any) => (
      <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{children}</td>
    )
  }), [onWikiLinkClick]);
  
  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="prose prose-lg dark:prose-invert max-w-none selection:bg-blue-200 dark:selection:bg-blue-800"
        onContextMenu={handleContextMenu}
      >
        {contentType === 'markdown' ? (
          <ReactMarkdown
            remarkPlugins={[
              remarkGfm,
              [remarkWikiLink, {
                pageResolver: (name: string) => [name.replace(/ /g, '_').toLowerCase()],
                hrefTemplate: (permalink: string) => `#${permalink}`
              }]
            ]}
            components={markdownComponents}
          >
            {content}
          </ReactMarkdown>
        ) : (
          <pre className="font-mono text-sm">{processedContent}</pre>
        )}
      </div>
      
      {/* Selection UI overlay */}
      {selectionBox && currentSelection && (
        <>
          {/* Selection outline */}
          <div
            className="absolute pointer-events-none z-40"
            style={{
              left: `${selectionBox.left - containerRef.current!.getBoundingClientRect().left}px`,
              top: `${selectionBox.top - containerRef.current!.getBoundingClientRect().top}px`,
              width: `${selectionBox.width}px`,
              height: `${selectionBox.height}px`,
              border: '2px dashed rgba(250, 204, 21, 0.6)',
              borderRadius: '3px',
              backgroundColor: 'rgba(254, 240, 138, 0.2)',
              animation: 'pulse 2s ease-in-out infinite'
            }}
          />
          
          {/* Sparkle */}
          {sparkle && (
            <button
              onClick={handleSparkleClick}
              className="absolute z-50 text-xl hover:scale-125 transition-transform cursor-pointer animate-bounce"
              style={{
                left: `${sparkle.x}px`,
                top: `${sparkle.y}px`,
                transform: 'translateY(-50%)'
              }}
              title="Click to create annotation"
              data-selection-ui
            >
              ✨
            </button>
          )}
        </>
      )}
    </div>
  );
}