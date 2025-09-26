'use client';

import React, { useEffect, useRef } from 'react';
import { EditorView, Decoration, DecorationSet } from '@codemirror/view';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { markdownPreview } from '@/lib/codemirror-markdown-preview';
import type { TextSegment, AnnotationSelection } from './AnnotationRenderer';
import { annotationStyles } from '@/lib/annotation-styles';
import '@/styles/animations.css';

interface Props {
  content: string;
  segments: TextSegment[];
  onAnnotationClick?: (annotation: AnnotationSelection) => void;
  onAnnotationRightClick?: (annotation: AnnotationSelection, x: number, y: number) => void;
  onTextSelect?: (text: string, position: { start: number; end: number }) => void;
  theme?: 'light' | 'dark';
  editable?: boolean;
  newAnnotationIds?: Set<string>;
}

export function CodeMirrorRenderer({
  content,
  segments,
  onAnnotationClick,
  onAnnotationRightClick,
  onTextSelect,
  theme = 'light',
  editable = false,
  newAnnotationIds
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create decorations for annotations
    const builder = new RangeSetBuilder<Decoration>();
    
    // Sort segments by start position for RangeSetBuilder
    const annotatedSegments = segments
      .filter(s => s.annotation)
      .sort((a, b) => a.start - b.start);
    
    for (const segment of annotatedSegments) {
      if (!segment.annotation) continue;
      
      // Create decoration with appropriate styling
      const isNew = newAnnotationIds?.has(segment.annotation.id) || false;
      const baseClassName = annotationStyles.getAnnotationStyle(segment.annotation);
      const className = isNew ? `${baseClassName} annotation-sparkle` : baseClassName;
      const decoration = Decoration.mark({
        class: className,
        attributes: {
          'data-annotation-id': segment.annotation.id,
          'data-annotation-type': segment.annotation.type || '',
          title: segment.annotation.type === 'highlight' 
            ? 'Right-click to delete or convert to reference'
            : segment.annotation.referencedDocumentId
              ? 'Click to navigate • Right-click for options'
              : 'Right-click for options'
        }
      });
      
      // Add decoration at SOURCE positions (CodeMirror handles the mapping!)
      builder.add(segment.start, segment.end, decoration);
    }
    
    const decorations = builder.finish();

    // Create CodeMirror state with markdown mode
    const state = EditorState.create({
      doc: content,
      extensions: [
        markdown(),
        markdownPreview(), // Add our custom markdown preview extension
        theme === 'dark' ? oneDark : [],
        EditorView.editable.of(editable),
        EditorView.decorations.of(decorations),
        // Handle clicks on annotations and text selection
        EditorView.domEventHandlers({
          click: (event, view) => {
            const target = event.target as HTMLElement;
            const annotationId = target.closest('[data-annotation-id]')?.getAttribute('data-annotation-id');
            
            if (annotationId && onAnnotationClick) {
              const segment = segments.find(s => s.annotation?.id === annotationId);
              if (segment?.annotation) {
                event.preventDefault();
                onAnnotationClick(segment.annotation);
              }
            }
            return false;
          },
          contextmenu: (event, view) => {
            const target = event.target as HTMLElement;
            const annotationId = target.closest('[data-annotation-id]')?.getAttribute('data-annotation-id');
            
            if (annotationId && onAnnotationRightClick) {
              const segment = segments.find(s => s.annotation?.id === annotationId);
              if (segment?.annotation) {
                event.preventDefault();
                onAnnotationRightClick(segment.annotation, event.clientX, event.clientY);
              }
            }
            return false;
          }
        }),
        // Style the editor to look like rendered content, not an editor
        EditorView.theme({
          '.cm-content': {
            padding: '0',
            fontFamily: 'inherit',
            fontSize: 'inherit',
            lineHeight: '1.6'
          },
          '.cm-line': {
            padding: '0'
          },
          '.cm-editor': {
            outline: 'none'
          },
          '.cm-editor.cm-focused': {
            outline: 'none'
          },
          '.cm-scroller': {
            fontFamily: 'inherit'
          },
          // Hide cursor when not editable
          '.cm-cursor': {
            display: editable ? 'block' : 'none'
          }
        })
      ]
    });

    // Create editor view
    const view = new EditorView({
      state,
      parent: containerRef.current
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [content, segments, onAnnotationClick, onAnnotationRightClick, theme, editable]);

  return <div ref={containerRef} className="codemirror-renderer" data-markdown-container />;
}