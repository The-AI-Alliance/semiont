'use client';

import React, { useEffect, useRef } from 'react';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { EditorState, RangeSetBuilder, StateField, StateEffect, Facet, Compartment } from '@codemirror/state';
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
  hoveredAnnotationId?: string | null;
  scrollToAnnotationId?: string | null;
}

// Effect to update annotation decorations with segments and new IDs
interface AnnotationUpdate {
  segments: TextSegment[];
  newAnnotationIds?: Set<string>;
}

const updateAnnotationsEffect = StateEffect.define<AnnotationUpdate>();

// Build decorations from segments
function buildAnnotationDecorations(
  segments: TextSegment[],
  newAnnotationIds?: Set<string>
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  const annotatedSegments = segments
    .filter(s => s.annotation)
    .sort((a, b) => a.start - b.start);

  for (const segment of annotatedSegments) {
    if (!segment.annotation) continue;

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

    builder.add(segment.start, segment.end, decoration);
  }

  return builder.finish();
}

// State field for annotation decorations
const annotationDecorationsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);

    for (const effect of tr.effects) {
      if (effect.is(updateAnnotationsEffect)) {
        decorations = buildAnnotationDecorations(effect.value.segments, effect.value.newAnnotationIds);
      }
    }

    return decorations;
  },
  provide: field => EditorView.decorations.from(field)
});

export function CodeMirrorRenderer({
  content,
  segments,
  onAnnotationClick,
  onAnnotationRightClick,
  onTextSelect,
  theme = 'light',
  editable = false,
  newAnnotationIds,
  hoveredAnnotationId,
  scrollToAnnotationId
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);
  const segmentsRef = useRef(segments);

  // Update segments ref when they change
  segmentsRef.current = segments;

  // Initialize CodeMirror view once
  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;

    // Create CodeMirror state with markdown mode
    const state = EditorState.create({
      doc: content,
      extensions: [
        markdown(),
        markdownPreview(),
        theme === 'dark' ? oneDark : [],
        EditorView.editable.of(editable),
        annotationDecorationsField,
        // Handle clicks on annotations
        EditorView.domEventHandlers({
          click: (event, view) => {
            const target = event.target as HTMLElement;
            const annotationId = target.closest('[data-annotation-id]')?.getAttribute('data-annotation-id');

            if (annotationId && onAnnotationClick) {
              const segment = segmentsRef.current.find(s => s.annotation?.id === annotationId);
              if (segment?.annotation) {
                event.preventDefault();
                onAnnotationClick(segment.annotation);
                return true; // Stop propagation
              }
            }
            return false;
          },
          contextmenu: (event, view) => {
            const target = event.target as HTMLElement;
            const annotationId = target.closest('[data-annotation-id]')?.getAttribute('data-annotation-id');

            if (annotationId && onAnnotationRightClick) {
              const segment = segmentsRef.current.find(s => s.annotation?.id === annotationId);
              if (segment?.annotation) {
                event.preventDefault();
                onAnnotationRightClick(segment.annotation, event.clientX, event.clientY);
                return true; // Stop propagation
              }
            }
            return false;
          }
        }),
        // Style the editor to look like rendered content
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
    contentRef.current = content;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []); // Only create once

  // Update content when it changes
  useEffect(() => {
    if (!viewRef.current || content === contentRef.current) return;

    viewRef.current.dispatch({
      changes: {
        from: 0,
        to: viewRef.current.state.doc.length,
        insert: content
      }
    });

    contentRef.current = content;
  }, [content]);

  // Update annotations when segments change
  useEffect(() => {
    if (!viewRef.current) return;

    viewRef.current.dispatch({
      effects: updateAnnotationsEffect.of({ segments, ...(newAnnotationIds && { newAnnotationIds }) })
    });
  }, [segments, newAnnotationIds]);

  // Update theme when it changes
  useEffect(() => {
    if (!viewRef.current) return;

    const compartment = new Compartment();
    viewRef.current.dispatch({
      effects: compartment.reconfigure(theme === 'dark' ? oneDark : [])
    });
  }, [theme]);

  // Handle hovered annotation - add pulse effect
  useEffect(() => {
    if (!viewRef.current || !hoveredAnnotationId) return;

    const segment = segments.find(s => s.annotation?.id === hoveredAnnotationId);
    if (!segment) return;

    const element = viewRef.current.contentDOM.querySelector(
      `[data-annotation-id="${hoveredAnnotationId}"]`
    ) as HTMLElement;

    if (element) {
      element.classList.add('annotation-pulse');

      return () => {
        element.classList.remove('annotation-pulse');
      };
    }
  }, [hoveredAnnotationId, segments]);

  // Handle scroll to annotation
  useEffect(() => {
    if (!viewRef.current || !scrollToAnnotationId) return;

    const segment = segments.find(s => s.annotation?.id === scrollToAnnotationId);
    if (!segment) return;

    const pos = segment.start;
    const view = viewRef.current;

    view.dispatch({
      effects: EditorView.scrollIntoView(pos, {
        y: 'center',
        yMargin: 100
      })
    });
  }, [scrollToAnnotationId, segments]);

  return <div ref={containerRef} className="codemirror-renderer" data-markdown-container />;
}