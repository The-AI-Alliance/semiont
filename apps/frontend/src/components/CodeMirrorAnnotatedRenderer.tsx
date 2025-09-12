"use client";

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { EditorState, Extension } from '@codemirror/state';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkWikiLink from 'remark-wiki-link';

// Types matching the existing interface
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

// Position mapping between source and rendered content
class PositionMapper {
  private sourceToRendered = new Map<number, number>();
  private renderedToSource = new Map<number, number>();
  private renderedNodes = new Map<Node, { start: number; end: number }>();
  
  clear() {
    this.sourceToRendered.clear();
    this.renderedToSource.clear();
    this.renderedNodes.clear();
  }
  
  // Build mapping from DOM tree with data attributes
  buildFromDOM(container: HTMLElement) {
    this.clear();
    
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const elem = node as HTMLElement;
            if (elem.hasAttribute('data-source-start')) {
              return NodeFilter.FILTER_ACCEPT;
            }
          }
          if (node.nodeType === Node.TEXT_NODE) {
            const parent = node.parentElement;
            if (parent?.hasAttribute('data-source-start')) {
              return NodeFilter.FILTER_ACCEPT;
            }
          }
          return NodeFilter.FILTER_SKIP;
        }
      }
    );
    
    let node;
    while (node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const elem = node as HTMLElement;
        const start = parseInt(elem.getAttribute('data-source-start') || '0');
        const end = parseInt(elem.getAttribute('data-source-end') || '0');
        
        if (!isNaN(start) && !isNaN(end)) {
          this.renderedNodes.set(node, { start, end });
        }
      }
    }
  }
  
  // Map selection from rendered view to source positions
  mapSelectionToSource(selection: Selection): { start: number; end: number } | null {
    if (!selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    
    // Find the source positions
    let startPos = this.findSourcePosition(range.startContainer, range.startOffset);
    let endPos = this.findSourcePosition(range.endContainer, range.endOffset);
    
    if (startPos !== null && endPos !== null) {
      return { start: startPos, end: endPos };
    }
    
    return null;
  }
  
  private findSourcePosition(node: Node, offset: number): number | null {
    // Walk up to find a node with position data
    let current: Node | null = node;
    
    while (current) {
      if (current.nodeType === Node.ELEMENT_NODE) {
        const elem = current as HTMLElement;
        const start = elem.getAttribute('data-source-start');
        
        if (start) {
          const basePos = parseInt(start);
          
          // If this is a text node, add the offset
          if (node.nodeType === Node.TEXT_NODE) {
            return basePos + offset;
          }
          
          return basePos;
        }
      }
      
      current = current.parentElement;
    }
    
    return null;
  }
}

export function CodeMirrorAnnotatedRenderer({
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
  const renderedRef = useRef<HTMLDivElement>(null);
  const cmView = useRef<EditorView | null>(null);
  const mapper = useRef(new PositionMapper());
  
  const [sparkle, setSparkle] = useState<{ x: number; y: number } | null>(null);
  const [selectionBox, setSelectionBox] = useState<DOMRect | null>(null);
  const [currentSelection, setCurrentSelection] = useState<{ text: string; start: number; end: number } | null>(null);
  
  // Create CodeMirror instance (hidden, for position tracking)
  useEffect(() => {
    if (!containerRef.current) return;
    
    // Create hidden CodeMirror view
    const hiddenContainer = document.createElement('div');
    hiddenContainer.style.position = 'absolute';
    hiddenContainer.style.visibility = 'hidden';
    hiddenContainer.style.pointerEvents = 'none';
    containerRef.current.appendChild(hiddenContainer);
    
    const extensions: Extension[] = [
      EditorView.editable.of(false),
    ];
    
    // Add language support
    if (contentType === 'markdown') {
      extensions.push(markdown());
    } else if (contentType === 'javascript') {
      extensions.push(javascript());
    } else if (contentType === 'python') {
      extensions.push(python());
    }
    
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions
      }),
      parent: hiddenContainer
    });
    
    cmView.current = view;
    
    return () => {
      view.destroy();
      hiddenContainer.remove();
    };
  }, [content, contentType]);
  
  // Render markdown with position tracking
  const renderWithPositions = useCallback((text: string) => {
    if (contentType !== 'markdown') {
      // For non-markdown, just render as preformatted text with positions
      const lines = text.split('\n');
      let pos = 0;
      
      return (
        <pre className="font-mono text-sm">
          {lines.map((line, i) => {
            const startPos = pos;
            const endPos = pos + line.length;
            pos = endPos + 1; // +1 for newline
            
            return (
              <React.Fragment key={i}>
                <span data-source-start={startPos} data-source-end={endPos}>
                  {line}
                </span>
                {i < lines.length - 1 && '\n'}
              </React.Fragment>
            );
          })}
        </pre>
      );
    }
    
    // For markdown, we need to track positions through the rendering
    // This is simplified - a full implementation would parse the AST
    let sourcePos = 0;
    
    return (
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          [remarkWikiLink, {
            pageResolver: (name: string) => [name.replace(/ /g, '_').toLowerCase()],
            hrefTemplate: (permalink: string) => `#${permalink}`
          }]
        ]}
        components={{
          p: ({ children, ...props }) => {
            const startPos = sourcePos;
            // Estimate the source length (this is simplified)
            const textContent = extractTextContent(children);
            const endPos = sourcePos + textContent.length;
            sourcePos = endPos + 2; // Account for paragraph breaks
            
            return (
              <p {...props} data-source-start={startPos} data-source-end={endPos} className="mb-4 text-gray-700 dark:text-gray-300 leading-relaxed">
                {children}
              </p>
            );
          },
          h1: ({ children, ...props }) => {
            const startPos = sourcePos;
            const textContent = extractTextContent(children);
            const endPos = sourcePos + textContent.length + 2; // +2 for ## 
            sourcePos = endPos + 2;
            return (
              <h1 {...props} data-source-start={startPos} data-source-end={endPos} className="text-3xl font-bold mb-4 text-gray-900 dark:text-white">
                {children}
              </h1>
            );
          },
          h2: ({ children, ...props }) => {
            const startPos = sourcePos;
            const textContent = extractTextContent(children);
            const endPos = sourcePos + textContent.length + 3; // +3 for ### 
            sourcePos = endPos + 2;
            return (
              <h2 {...props} data-source-start={startPos} data-source-end={endPos} className="text-2xl font-semibold mb-3 text-gray-900 dark:text-white">
                {children}
              </h2>
            );
          },
          h3: ({ children, ...props }) => {
            const startPos = sourcePos;
            const textContent = extractTextContent(children);
            const endPos = sourcePos + textContent.length + 4; // +4 for #### 
            sourcePos = endPos + 2;
            return (
              <h3 {...props} data-source-start={startPos} data-source-end={endPos} className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">
                {children}
              </h3>
            );
          },
          ul: ({ children, ...props }) => (
            <ul {...props} className="list-disc list-inside mb-4 text-gray-700 dark:text-gray-300">
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol {...props} className="list-decimal list-inside mb-4 text-gray-700 dark:text-gray-300">
              {children}
            </ol>
          ),
          li: ({ children, ...props }) => {
            const startPos = sourcePos;
            const textContent = extractTextContent(children);
            const endPos = sourcePos + textContent.length + 2; // +2 for - 
            sourcePos = endPos + 1;
            return (
              <li {...props} data-source-start={startPos} data-source-end={endPos} className="mb-1">
                {children}
              </li>
            );
          },
          blockquote: ({ children, ...props }) => (
            <blockquote {...props} className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 mb-4 italic text-gray-600 dark:text-gray-400">
              {children}
            </blockquote>
          ),
          code: ({ children, ...props }) => (
            <code {...props} className="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-sm font-mono">
              {children}
            </code>
          ),
          pre: ({ children, ...props }) => (
            <pre {...props} className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-4 overflow-x-auto">
              {children}
            </pre>
          ),
          // Add position tracking to other elements as needed
          a: ({ href, children }) => {
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
        }}
      >
        {text}
      </ReactMarkdown>
    );
  }, [contentType, onWikiLinkClick]);
  
  // Handle selection in rendered content
  useEffect(() => {
    if (!renderedRef.current) return;
    
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
      
      // Get source positions
      mapper.current.buildFromDOM(renderedRef.current!);
      const sourceRange = mapper.current.mapSelectionToSource(selection);
      
      if (sourceRange) {
        // Get bounding rect for visual feedback
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const containerRect = renderedRef.current!.getBoundingClientRect();
        
        // Show sparkle at end of selection
        setSparkle({
          x: rect.right - containerRect.left + 5,
          y: rect.top - containerRect.top + rect.height / 2
        });
        
        setSelectionBox(rect);
        setCurrentSelection({
          text,
          start: sourceRange.start,
          end: sourceRange.end
        });
      }
    };
    
    const handleMouseDown = (e: MouseEvent) => {
      // Clear selection if clicking outside
      if (!(e.target as Element).closest('[data-selection-ui]')) {
        setSparkle(null);
        setSelectionBox(null);
        setCurrentSelection(null);
      }
    };
    
    renderedRef.current.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);
    
    return () => {
      renderedRef.current?.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, []);
  
  // Handle right-click on selection
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
  
  // Handle sparkle click
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
  
  // Apply annotations to rendered content
  useEffect(() => {
    if (!renderedRef.current || !cmView.current) return;
    
    // Clear existing annotation spans
    const existingSpans = renderedRef.current.querySelectorAll('span.annotation-span');
    existingSpans.forEach(span => {
      const parent = span.parentNode;
      if (parent) {
        // Replace span with its text content
        while (span.firstChild) {
          parent.insertBefore(span.firstChild, span);
        }
        parent.removeChild(span);
      }
    });
    
    // Apply new annotations
    // Add type field to distinguish highlights from references
    const annotatedHighlights = highlights.map(h => ({ ...h, type: 'highlight' }));
    const annotatedReferences = references.map(r => ({ ...r, type: 'reference' }));
    
    const allAnnotations = [...annotatedHighlights, ...annotatedReferences].sort((a, b) => {
      const aStart = a.selectionData?.offset ?? 0;
      const bStart = b.selectionData?.offset ?? 0;
      return aStart - bStart;
    });
    
    console.log('Applying annotations:', allAnnotations);
    
    // Process annotations by walking through text nodes
    allAnnotations.forEach(annotation => {
      const start = annotation.selectionData?.offset ?? 0;
      const length = annotation.selectionData?.length ?? 0;
      const end = start + length;
      
      console.log(`Annotation ${annotation.type} from ${start} to ${end}`);
      
      // Walk through all text nodes to find the ones in range
      const walker = document.createTreeWalker(
        renderedRef.current!,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            // Skip text nodes that are already inside annotation spans
            if ((node.parentElement as HTMLElement)?.classList?.contains('annotation-span')) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      
      let currentPos = 0;
      let node;
      const nodesToWrap: { node: Text, start: number, end: number }[] = [];
      
      while (node = walker.nextNode()) {
        const textNode = node as Text;
        const nodeLength = textNode.textContent?.length || 0;
        const nodeStart = currentPos;
        const nodeEnd = currentPos + nodeLength;
        
        // Check if this text node overlaps with the annotation
        if (start < nodeEnd && end > nodeStart) {
          // Calculate the portion of this node to wrap
          const wrapStart = Math.max(0, start - nodeStart);
          const wrapEnd = Math.min(nodeLength, end - nodeStart);
          
          if (wrapStart < wrapEnd) {
            nodesToWrap.push({
              node: textNode,
              start: wrapStart,
              end: wrapEnd
            });
          }
        }
        
        currentPos = nodeEnd;
        
        // Stop if we've passed the annotation end
        if (currentPos >= end) break;
      }
      
      // Wrap the identified text portions
      nodesToWrap.forEach(({ node, start, end }) => {
        const text = node.textContent || '';
        const parent = node.parentNode;
        
        if (parent) {
          // Split the text node if needed
          const beforeText = text.substring(0, start);
          const annotatedText = text.substring(start, end);
          const afterText = text.substring(end);
          
          // Create the annotation span
          const span = document.createElement('span');
          span.className = 'annotation-span';
          span.textContent = annotatedText;
          
          // Apply styling based on annotation type
          if (annotation.type === 'highlight') {
            span.classList.add('bg-yellow-200', 'dark:bg-yellow-900/50', 'rounded', 'px-0.5');
          } else if (annotation.type === 'reference') {
            if (annotation.referenceType === 'entity') {
              span.classList.add('bg-purple-200', 'dark:bg-purple-900/50', 'rounded', 'px-0.5');
            } else {
              span.classList.add('bg-gradient-to-r', 'from-cyan-200', 'to-blue-200', 
                                'dark:from-cyan-900/50', 'dark:to-blue-900/50', 'rounded', 'px-0.5');
            }
          }
          
          // Add interactivity
          span.style.cursor = 'pointer';
          span.onclick = () => {
            if (annotation.type === 'highlight' && onHighlightClick) {
              onHighlightClick(annotation);
            } else if (annotation.type === 'reference' && onReferenceClick) {
              onReferenceClick(annotation);
            }
          };
          
          span.oncontextmenu = (e) => {
            e.preventDefault();
            if (onAnnotationRightClick) {
              onAnnotationRightClick(annotation, e.clientX, e.clientY);
            }
          };
          
          // Replace the text node with the new structure
          const fragment = document.createDocumentFragment();
          
          if (beforeText) {
            fragment.appendChild(document.createTextNode(beforeText));
          }
          fragment.appendChild(span);
          if (afterText) {
            fragment.appendChild(document.createTextNode(afterText));
          }
          
          parent.replaceChild(fragment, node);
        }
      });
    });
  }, [highlights, references, onHighlightClick, onReferenceClick, onAnnotationRightClick]);
  
  return (
    <div ref={containerRef} className="relative">
      {/* Rendered content */}
      <div
        ref={renderedRef}
        className="prose prose-lg dark:prose-invert max-w-none selection:bg-blue-200 dark:selection:bg-blue-800"
        onContextMenu={handleContextMenu}
      >
        {renderWithPositions(content)}
      </div>
      
      {/* Selection UI overlay */}
      {selectionBox && currentSelection && (
        <>
          {/* Selection outline */}
          <div
            className="absolute pointer-events-none z-40"
            style={{
              left: `${selectionBox.left - renderedRef.current!.getBoundingClientRect().left}px`,
              top: `${selectionBox.top - renderedRef.current!.getBoundingClientRect().top}px`,
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

// Helper function to extract text content from React children
function extractTextContent(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) {
    return children.map(extractTextContent).join('');
  }
  if (React.isValidElement(children) && children.props.children) {
    return extractTextContent(children.props.children);
  }
  return '';
}