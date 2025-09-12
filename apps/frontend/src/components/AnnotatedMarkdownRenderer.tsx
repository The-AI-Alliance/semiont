"use client";

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkWikiLink from 'remark-wiki-link';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';

// Extended Selection type to handle actual backend response
interface ExtendedSelection {
  id: string;
  documentId: string;
  selectionData: {
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

interface AnnotatedMarkdownRendererProps {
  content: string;
  highlights: ExtendedSelection[];
  references: ExtendedSelection[];
  onWikiLinkClick?: (pageName: string) => void;
  onTextSelect?: (text: string, position: { start: number; end: number }) => void;
  onHighlightClick?: (highlight: ExtendedSelection) => void;
  onReferenceClick?: (reference: ExtendedSelection) => void;
  onAnnotationRightClick?: (annotation: ExtendedSelection, x: number, y: number) => void;
}

export function AnnotatedMarkdownRenderer({ 
  content, 
  highlights,
  references,
  onWikiLinkClick,
  onTextSelect,
  onHighlightClick,
  onReferenceClick,
  onAnnotationRightClick
}: AnnotatedMarkdownRendererProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  // Apply annotations after markdown is rendered
  React.useEffect(() => {
    if (!containerRef.current) return;
    
    // Small delay to ensure markdown is fully rendered
    const timer = setTimeout(() => {

    const container = containerRef.current!;
    
    // Collect all text nodes in document order
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          // Skip text nodes that are inside code blocks or script tags
          const parent = node.parentElement;
          if (parent?.tagName === 'CODE' || parent?.tagName === 'SCRIPT' || parent?.tagName === 'STYLE') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while (node = walker.nextNode()) {
      textNodes.push(node as Text);
    }

    // Build a map of cumulative text positions
    let cumulativeOffset = 0;
    const nodeMap: Array<{ node: Text; start: number; end: number; text: string }> = [];
    
    textNodes.forEach(textNode => {
      const text = textNode.textContent || '';
      nodeMap.push({
        node: textNode,
        start: cumulativeOffset,
        end: cumulativeOffset + text.length,
        text
      });
      cumulativeOffset += text.length;
    });

    // Process annotations
    const allAnnotations = [
      ...(highlights as ExtendedSelection[])?.map(h => ({
        ...h,
        type: 'highlight' as const
      })) || [],
      ...(references as ExtendedSelection[])?.map(r => ({
        ...r,
        type: 'reference' as const
      })) || []
    ];

    // Sort annotations by offset (process from start to end)
    allAnnotations.sort((a, b) => a.selectionData.offset - b.selectionData.offset);

    // Process each text node and apply all relevant annotations
    nodeMap.forEach(({ node, start: nodeStart, end: nodeEnd }) => {
      // Find all annotations that affect this text node
      const nodeAnnotations = allAnnotations.filter(annotation => {
        const annotationStart = annotation.selectionData.offset;
        const annotationEnd = annotationStart + annotation.selectionData.length;
        return annotationStart < nodeEnd && annotationEnd > nodeStart;
      });

      if (nodeAnnotations.length === 0) return;

      // Calculate split points for this text node
      const splits: Array<{ start: number; end: number; annotation: typeof allAnnotations[0] | undefined }> = [];
      const text = node.textContent || '';
      
      // Convert annotation positions to relative positions within this node
      const relativeBoundaries = new Set<number>([0, text.length]);
      
      nodeAnnotations.forEach(annotation => {
        const annotationStart = annotation.selectionData.offset;
        const annotationEnd = annotationStart + annotation.selectionData.length;
        
        const relativeStart = Math.max(0, annotationStart - nodeStart);
        const relativeEnd = Math.min(text.length, annotationEnd - nodeStart);
        
        if (relativeStart < text.length) relativeBoundaries.add(relativeStart);
        if (relativeEnd > 0) relativeBoundaries.add(relativeEnd);
      });

      // Convert boundaries to sorted array
      const boundaries = Array.from(relativeBoundaries).sort((a, b) => a - b);
      
      // Create segments between boundaries
      for (let i = 0; i < boundaries.length - 1; i++) {
        const segmentStart = boundaries[i];
        const segmentEnd = boundaries[i + 1];
        
        // Skip if boundaries are undefined (shouldn't happen, but satisfies TypeScript)
        if (segmentStart === undefined || segmentEnd === undefined) continue;
        
        // Find which annotation(s) apply to this segment
        const segmentAnnotation = nodeAnnotations.find(annotation => {
          const annotationStart = annotation.selectionData.offset;
          const annotationEnd = annotationStart + annotation.selectionData.length;
          
          const relativeStart = Math.max(0, annotationStart - nodeStart);
          const relativeEnd = Math.min(text.length, annotationEnd - nodeStart);
          
          return relativeStart <= segmentStart && relativeEnd >= segmentEnd;
        });
        
        splits.push({ 
          start: segmentStart, 
          end: segmentEnd, 
          annotation: segmentAnnotation 
        });
      }

      // Build the replacement fragment
      const parent = node.parentNode;
      if (parent && splits.length > 0) {
        const fragment = document.createDocumentFragment();
        
        splits.forEach(({ start, end, annotation }) => {
          const segmentText = text.substring(start, end);
          
          if (annotation) {
            // Create wrapper span
            const wrapper = document.createElement('span');
            wrapper.className = annotation.type === 'highlight' 
              ? 'bg-yellow-200 dark:bg-yellow-900/40 px-0.5 cursor-pointer hover:bg-yellow-300 dark:hover:bg-yellow-800/50 transition-colors'
              : 'bg-gradient-to-r from-cyan-200 to-blue-200 dark:from-cyan-900/40 dark:to-blue-900/40 px-1 py-0.5 rounded-md cursor-pointer hover:from-cyan-300 hover:to-blue-300 dark:hover:from-cyan-800/50 dark:hover:to-blue-800/50 transition-all border border-cyan-400/30 dark:border-cyan-600/30';
            wrapper.dataset.annotationType = annotation.type;
            wrapper.dataset.annotationId = annotation.id;
            wrapper.textContent = segmentText;

            // Add click handler
            wrapper.addEventListener('click', () => {
              if (annotation.type === 'highlight' && onHighlightClick) {
                onHighlightClick(annotation);
              } else if (annotation.type === 'reference' && onReferenceClick) {
                onReferenceClick(annotation);
              }
            });

            // Add right-click handler for context menu
            wrapper.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              if (onAnnotationRightClick) {
                onAnnotationRightClick(annotation, e.clientX, e.clientY);
              }
            });
            
            fragment.appendChild(wrapper);
          } else {
            fragment.appendChild(document.createTextNode(segmentText));
          }
        });
        
        parent.replaceChild(fragment, node);
      }
    });
    }, 100); // 100ms delay to ensure DOM is ready

    return () => clearTimeout(timer);
  }, [highlights, references, onHighlightClick, onReferenceClick, onAnnotationRightClick, content]);

  const handleTextSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !containerRef.current) return;

    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    // Get the selection range
    const range = selection.getRangeAt(0);
    
    // Calculate position relative to the original content
    const preSelectionRange = document.createRange();
    preSelectionRange.selectNodeContents(containerRef.current);
    preSelectionRange.setEnd(range.startContainer, range.startOffset);
    
    // Get the text content and calculate actual position
    const preSelectionText = preSelectionRange.toString();
    const start = preSelectionText.length;
    const end = start + selectedText.length;

    if (onTextSelect) {
      onTextSelect(selectedText, { start, end });
    }
  };

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('mouseup', handleTextSelection);
    container.addEventListener('touchend', handleTextSelection);

    return () => {
      container.removeEventListener('mouseup', handleTextSelection);
      container.removeEventListener('touchend', handleTextSelection);
    };
  }, [onTextSelect]);

  // Define markdown components
  const markdownComponents = {
    // Custom rendering for wiki links
    a: ({ node, href, children, ...props }: any) => {
      // Check if this is a wiki link (starts with #)
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
      // Regular links
      return (
        <a 
          href={href} 
          className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 underline"
          target="_blank"
          rel="noopener noreferrer"
          {...props}
        >
          {children}
        </a>
      );
    },
    // Keep other styles the same
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
      <p className="mb-4 text-gray-700 dark:text-gray-300 leading-relaxed">{children}</p>
    ),
    ul: ({ children }: any) => (
      <ul className="list-disc pl-6 mb-4 text-gray-700 dark:text-gray-300">{children}</ul>
    ),
    ol: ({ children }: any) => (
      <ol className="list-decimal pl-6 mb-4 text-gray-700 dark:text-gray-300">{children}</ol>
    ),
    li: ({ children }: any) => (
      <li className="mb-1">{children}</li>
    ),
    blockquote: ({ children }: any) => (
      <blockquote className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 italic text-gray-600 dark:text-gray-400 my-4">
        {children}
      </blockquote>
    ),
    code: ({ children, className, ...props }: any) => {
      const isInline = !className?.includes('language-');
      if (isInline) {
        return (
          <code className="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-sm font-mono text-red-600 dark:text-red-400" {...props}>
            {children}
          </code>
        );
      }
      return (
        <code className="block bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto font-mono text-sm" {...props}>
          {children}
        </code>
      );
    },
    table: ({ children }: any) => (
      <table className="min-w-full divide-y divide-gray-300 dark:divide-gray-600 mb-4">
        {children}
      </table>
    ),
    th: ({ children }: any) => (
      <th className="px-3 py-2 text-left text-xs font-medium text-gray-900 dark:text-white uppercase tracking-wider">
        {children}
      </th>
    ),
    td: ({ children }: any) => (
      <td className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300">
        {children}
      </td>
    ),
  };

  return (
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
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}