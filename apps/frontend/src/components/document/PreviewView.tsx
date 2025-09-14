'use client';

import React, { useMemo } from 'react';
import { annotationStyles } from '@/lib/annotation-styles';
import type { Annotation } from '@/contexts/DocumentAnnotationsContext';

interface Props {
  content: string;
  highlights: Annotation[];
  references: Annotation[];
  onAnnotationClick?: (annotation: Annotation) => void;
  onWikiLinkClick?: (pageName: string) => void;
}

// Apply annotations to a segment of text given its position in the document
function applyAnnotations(
  text: string,
  startOffset: number,
  annotations: Annotation[],
  onAnnotationClick?: (annotation: Annotation) => void
): React.ReactNode {
  const endOffset = startOffset + text.length;
  
  // Filter annotations that overlap with this text segment
  const relevantAnnotations = annotations
    .filter(ann => {
      if (!ann.selectionData) return false;
      const annStart = ann.selectionData.offset;
      const annEnd = annStart + ann.selectionData.length;
      // Check if annotation overlaps with this segment
      return annStart < endOffset && annEnd > startOffset;
    })
    .map(ann => ({
      annotation: ann,
      // Adjust positions relative to this segment
      start: Math.max(0, (ann.selectionData?.offset ?? 0) - startOffset),
      end: Math.min(text.length, ((ann.selectionData?.offset ?? 0) + (ann.selectionData?.length ?? 0)) - startOffset)
    }))
    .filter(a => a.start < a.end) // Only keep annotations that have content in this segment
    .sort((a, b) => a.start - b.start);
  
  if (!relevantAnnotations.length) return text;
  
  const segments: React.ReactNode[] = [];
  let lastEnd = 0;
  
  for (const { annotation, start, end } of relevantAnnotations) {
    // Skip overlapping annotations
    if (start < lastEnd) continue;
    
    // Add text before annotation
    if (start > lastEnd) {
      segments.push(text.slice(lastEnd, start));
    }
    
    // Add annotated text
    const className = annotationStyles.getAnnotationStyle(annotation);
    const isReference = annotation.type === 'reference' && annotation.referencedDocumentId;
    
    segments.push(
      <span
        key={`ann-${annotation.id}`}
        className={className}
        onClick={() => isReference && onAnnotationClick?.(annotation)}
        title={isReference ? 'Click to navigate to referenced document' : 'Highlight'}
        style={{ cursor: isReference ? 'pointer' : 'default' }}
      >
        {text.slice(start, end)}
      </span>
    );
    
    lastEnd = end;
  }
  
  // Add remaining text
  if (lastEnd < text.length) {
    segments.push(text.slice(lastEnd));
  }
  
  return segments.length > 0 ? segments : text;
}

// Simple markdown renderer with annotation support
function renderMarkdown(
  content: string,
  annotations: Annotation[],
  onAnnotationClick?: (annotation: Annotation) => void
): React.ReactNode {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let currentOffset = 0; // Track position in original content
  
  while (i < lines.length) {
    const line = lines[i] || '';
    const lineStart = currentOffset;
    
    // Headers
    if (line.startsWith('### ')) {
      const headerText = line.slice(4);
      const headerOffset = lineStart + 4; // Account for "### "
      elements.push(
        <h3 key={`h3-${i}`} className="text-xl font-bold mb-2">
          {applyAnnotations(headerText, headerOffset, annotations, onAnnotationClick)}
        </h3>
      );
      currentOffset += line.length + 1; // +1 for newline
    } else if (line.startsWith('## ')) {
      const headerText = line.slice(3);
      const headerOffset = lineStart + 3; // Account for "## "
      elements.push(
        <h2 key={`h2-${i}`} className="text-2xl font-bold mb-3">
          {applyAnnotations(headerText, headerOffset, annotations, onAnnotationClick)}
        </h2>
      );
      currentOffset += line.length + 1;
    } else if (line.startsWith('# ')) {
      const headerText = line.slice(2);
      const headerOffset = lineStart + 2; // Account for "# "
      elements.push(
        <h1 key={`h1-${i}`} className="text-3xl font-bold mb-4">
          {applyAnnotations(headerText, headerOffset, annotations, onAnnotationClick)}
        </h1>
      );
      currentOffset += line.length + 1;
    }
    // Code blocks
    else if (line.startsWith('```')) {
      currentOffset += line.length + 1; // Skip the opening ```
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]?.startsWith('```')) {
        codeLines.push(lines[i] || '');
        currentOffset += (lines[i] || '').length + 1;
        i++;
      }
      if (i < lines.length) {
        currentOffset += (lines[i] || '').length + 1; // Skip the closing ```
      }
      elements.push(
        <pre key={`code-${i}`} className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg overflow-x-auto mb-4">
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
    }
    // Unordered lists
    else if (line.match(/^[-*+] /)) {
      const listItems: React.ReactNode[] = [];
      while (i < lines.length && lines[i]?.match(/^[-*+] /)) {
        const listLine = lines[i]!;
        const listText = listLine.slice(2);
        const listOffset = currentOffset + 2; // Account for "- "
        listItems.push(
          <li key={`li-${i}`}>
            {applyAnnotations(listText, listOffset, annotations, onAnnotationClick)}
          </li>
        );
        currentOffset += listLine.length + 1;
        i++;
      }
      elements.push(
        <ul key={`ul-${i}`} className="list-disc pl-6 mb-4">
          {listItems}
        </ul>
      );
      i--; // Back up one since we went one too far
    }
    // Ordered lists (numbered)
    else if (line.match(/^\d+\. /)) {
      const listItems: React.ReactNode[] = [];
      while (i < lines.length && lines[i]?.match(/^\d+\. /)) {
        const listLine = lines[i]!;
        const match = listLine.match(/^(\d+)\. (.*)/)!;
        const listText = match[2];
        const listOffset = currentOffset + match[1].length + 2; // Account for "1. "
        listItems.push(
          <li key={`li-${i}`}>
            {applyAnnotations(listText, listOffset, annotations, onAnnotationClick)}
          </li>
        );
        currentOffset += listLine.length + 1;
        i++;
      }
      elements.push(
        <ol key={`ol-${i}`} className="list-decimal pl-6 mb-4">
          {listItems}
        </ol>
      );
      i--; // Back up one since we went one too far
    }
    // Blockquote
    else if (line.startsWith('> ')) {
      const quoteText = line.slice(2);
      const quoteOffset = lineStart + 2; // Account for "> "
      elements.push(
        <blockquote key={`bq-${i}`} className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 italic my-2">
          {applyAnnotations(quoteText, quoteOffset, annotations, onAnnotationClick)}
        </blockquote>
      );
      currentOffset += line.length + 1;
    }
    // Horizontal rule
    else if (line.match(/^---+$/) || line.match(/^\*\*\*+$/) || line.match(/^___+$/)) {
      elements.push(<hr key={`hr-${i}`} className="my-4" />);
      currentOffset += line.length + 1;
    }
    // Empty line
    else if (line.trim() === '') {
      currentOffset += 1; // Just the newline
    }
    // Regular paragraph
    else {
      // Collect paragraph lines
      const paragraphLines: string[] = [];
      const paragraphStart = currentOffset;
      
      paragraphLines.push(line);
      currentOffset += line.length + 1;
      i++;
      
      while (i < lines.length && lines[i]?.trim() && !lines[i]?.match(/^[#>\-*+`]/) && !lines[i]?.match(/^\d+\. /) && !lines[i]?.match(/^---+$/) && !lines[i]?.match(/^\*\*\*+$/) && !lines[i]?.match(/^___+$/)) {
        paragraphLines.push(lines[i]!);
        currentOffset += lines[i]!.length + 1;
        i++;
      }
      i--; // Back up one
      
      // Join with newlines to preserve original positions
      const paragraphText = paragraphLines.join('\n');
      elements.push(
        <p key={`p-${i}`} className="mb-4">
          {applyAnnotations(paragraphText, paragraphStart, annotations, onAnnotationClick)}
        </p>
      );
    }
    
    i++;
  }
  
  return <>{elements}</>;
}

export function PreviewView({
  content,
  highlights,
  references,
  onAnnotationClick
}: Props) {
  const allAnnotations = useMemo(() => 
    [...highlights, ...references],
    [highlights, references]
  );
  
  const renderedContent = useMemo(() => 
    renderMarkdown(content, allAnnotations, onAnnotationClick),
    [content, allAnnotations, onAnnotationClick]
  );
  
  return (
    <div className="prose prose-lg dark:prose-invert max-w-none p-4">
      {renderedContent}
    </div>
  );
}