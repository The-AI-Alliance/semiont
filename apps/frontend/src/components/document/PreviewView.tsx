'use client';

import React, { useMemo, useCallback } from 'react';
import { annotationStyles } from '@/lib/annotation-styles';
import type { Annotation } from '@/contexts/DocumentAnnotationsContext';

interface Props {
  content: string;
  highlights: Annotation[];
  references: Annotation[];
  onAnnotationClick?: (annotation: Annotation) => void;
  onWikiLinkClick?: (pageName: string) => void;
}

interface TextSegment {
  text: string;
  annotation?: Annotation;
  start: number;
  end: number;
}

// Segment text with annotations - same as SourceView
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

// Simple markdown parser for basic formatting
function parseInlineMarkdown(text: string): React.ReactNode {
  // Handle basic inline markdown (bold, italic, code, links)
  let result: React.ReactNode[] = [];
  let key = 0;
  
  // Simple regex-based parsing (not perfect but good enough for preview)
  const patterns = [
    { regex: /\*\*(.+?)\*\*/g, wrap: (_match: string, content: string) => <strong key={key++}>{content}</strong> },
    { regex: /\*(.+?)\*/g, wrap: (_match: string, content: string) => <em key={key++}>{content}</em> },
    { regex: /`(.+?)`/g, wrap: (_match: string, content: string) => <code key={key++} className="px-1 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-sm">{content}</code> },
    { regex: /\[([^\]]+)\]\(([^)]+)\)/g, wrap: (_match: string, text: string, url: string) => <a key={key++} href={url} className="text-blue-600 dark:text-blue-400 underline hover:text-blue-800 dark:hover:text-blue-300">{text}</a> }
  ];
  
  let elements: Array<{ start: number; end: number; element: React.ReactNode }> = [];
  
  // Find all matches
  for (const pattern of patterns) {
    let match;
    pattern.regex.lastIndex = 0; // Reset regex
    while ((match = pattern.regex.exec(text)) !== null) {
      const args = match.slice(0);
      const element = pattern.wrap(args[0] || '', args[1] || '', args[2] || '');
      elements.push({
        start: match.index,
        end: match.index + match[0].length,
        element
      });
    }
  }
  
  // Sort by position
  elements.sort((a, b) => a.start - b.start);
  
  // Build result without overlaps
  let lastEnd = 0;
  for (const { start, end, element } of elements) {
    if (start >= lastEnd) {
      // Add text before this element
      if (start > lastEnd) {
        result.push(text.slice(lastEnd, start));
      }
      result.push(element);
      lastEnd = end;
    }
  }
  
  // Add remaining text
  if (lastEnd < text.length) {
    result.push(text.slice(lastEnd));
  }
  
  return result.length > 0 ? result : text;
}

// Parse block-level markdown (headers, lists, etc.)
function parseBlockMarkdown(text: string): React.ReactNode {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let inList = false;
  let listItems: React.ReactNode[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';
    
    // Headers
    if (line.startsWith('# ')) {
      elements.push(<h1 key={i} className="text-3xl font-bold mb-4">{parseInlineMarkdown(line.slice(2))}</h1>);
    } else if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className="text-2xl font-bold mb-3">{parseInlineMarkdown(line.slice(3))}</h2>);
    } else if (line.startsWith('### ')) {
      elements.push(<h3 key={i} className="text-xl font-bold mb-2">{parseInlineMarkdown(line.slice(4))}</h3>);
    }
    // Lists
    else if (line.match(/^[-*+] /)) {
      if (!inList) {
        inList = true;
        listItems = [];
      }
      listItems.push(<li key={i}>{parseInlineMarkdown(line.slice(2))}</li>);
    }
    // Blockquote
    else if (line.startsWith('> ')) {
      elements.push(
        <blockquote key={i} className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 italic my-2">
          {parseInlineMarkdown(line.slice(2))}
        </blockquote>
      );
    }
    // Regular paragraph or empty line
    else {
      // End list if we were in one
      if (inList && line.trim() === '') {
        elements.push(<ul key={`list-${i}`} className="list-disc pl-6 mb-4">{listItems}</ul>);
        inList = false;
        listItems = [];
      } else if (line.trim()) {
        elements.push(<p key={i} className="mb-4">{parseInlineMarkdown(line)}</p>);
      }
    }
  }
  
  // Close any open list
  if (inList) {
    elements.push(<ul key="list-final" className="list-disc pl-6 mb-4">{listItems}</ul>);
  }
  
  return <>{elements}</>;
}

export function PreviewView({
  content,
  highlights,
  references,
  onAnnotationClick
}: Props) {
  // Combine and segment annotations
  const allAnnotations = [...highlights, ...references];
  const segments = useMemo(() => 
    segmentTextWithAnnotations(content, allAnnotations),
    [content, allAnnotations]
  );
  
  // Render a segment with markdown parsing
  const renderSegment = useCallback((segment: TextSegment) => {
    const parsedContent = parseBlockMarkdown(segment.text);
    
    if (!segment.annotation) {
      return parsedContent;
    }
    
    // For annotated segments, wrap in appropriate styling
    const isReference = segment.annotation.type === 'reference' && segment.annotation.referencedDocumentId;
    const className = annotationStyles.getAnnotationStyle(segment.annotation);
    
    return (
      <span
        className={className}
        onClick={() => {
          if (isReference && onAnnotationClick) {
            onAnnotationClick(segment.annotation!);
          }
        }}
        title={
          isReference
            ? 'Click to navigate to referenced document'
            : 'Highlight'
        }
        style={{
          cursor: isReference ? 'pointer' : 'default'
        }}
      >
        {parsedContent}
      </span>
    );
  }, [onAnnotationClick]);
  
  return (
    <div className="prose prose-lg dark:prose-invert max-w-none p-4">
      {segments.map((segment, index) => (
        <React.Fragment key={`${segment.start}-${segment.end}-${index}`}>
          {renderSegment(segment)}
        </React.Fragment>
      ))}
    </div>
  );
}