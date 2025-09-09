"use client";

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkWikiLink from 'remark-wiki-link';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';

interface MarkdownRendererProps {
  content: string;
  onWikiLinkClick?: (pageName: string) => void;
  onTextSelect?: (text: string, position: { start: number; end: number }) => void;
}

export function MarkdownRenderer({ 
  content, 
  onWikiLinkClick,
  onTextSelect 
}: MarkdownRendererProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  const handleTextSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !containerRef.current) return;

    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    // Get the selection range
    const range = selection.getRangeAt(0);
    
    // Calculate position relative to the container
    const preSelectionRange = document.createRange();
    preSelectionRange.selectNodeContents(containerRef.current);
    preSelectionRange.setEnd(range.startContainer, range.startOffset);
    const start = preSelectionRange.toString().length;
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

  return (
    <div 
      ref={containerRef}
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
        components={{
          // Custom rendering for wiki links
          a: ({ node, href, children, ...props }) => {
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
          // Style other markdown elements
          h1: ({ children }) => (
            <h1 className="text-3xl font-bold mb-4 text-gray-900 dark:text-white">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-2xl font-semibold mb-3 text-gray-900 dark:text-white">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="mb-4 text-gray-700 dark:text-gray-300 leading-relaxed">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-6 mb-4 text-gray-700 dark:text-gray-300">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-6 mb-4 text-gray-700 dark:text-gray-300">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="mb-1">{children}</li>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 italic text-gray-600 dark:text-gray-400 my-4">
              {children}
            </blockquote>
          ),
          code: ({ children, className, ...props }) => {
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
          table: ({ children }) => (
            <table className="min-w-full divide-y divide-gray-300 dark:divide-gray-600 mb-4">
              {children}
            </table>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-900 dark:text-white uppercase tracking-wider">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300">
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}