'use client';

import React, { useEffect, useRef } from 'react';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, lineNumbers } from '@codemirror/view';
import { EditorState, RangeSetBuilder, StateField, StateEffect, Facet, Compartment } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { markdownPreview } from '@/lib/codemirror-markdown-preview';
import { annotationStyles } from '@/lib/annotation-styles';
import { ReferenceResolutionWidget, findWikiLinks } from '@/lib/codemirror-widgets';
import '@/styles/animations.css';

// Export types for use by other components
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

export interface TextSegment {
  text: string;
  annotation?: AnnotationSelection;
  start: number;
  end: number;
}

interface Props {
  content: string;
  segments: TextSegment[];
  onAnnotationClick?: (annotation: AnnotationSelection) => void;
  onAnnotationRightClick?: (annotation: AnnotationSelection, x: number, y: number) => void;
  onAnnotationHover?: (annotationId: string | null) => void;
  onTextSelect?: (text: string, position: { start: number; end: number }) => void;
  onChange?: (content: string) => void;
  editable?: boolean;
  newAnnotationIds?: Set<string>;
  hoveredAnnotationId?: string | null;
  scrollToAnnotationId?: string | null;
  sourceView?: boolean; // If true, show raw source (no markdown rendering)
  showLineNumbers?: boolean; // If true, show line numbers
  enableWidgets?: boolean; // If true, show inline widgets (wiki links, reference previews, entity badges)
  onWikiLinkClick?: (pageName: string) => void;
  onEntityTypeClick?: (entityType: string) => void;
  onReferenceNavigate?: (documentId: string) => void;
  onUnresolvedReferenceClick?: (annotation: AnnotationSelection) => void;
  getTargetDocumentName?: (documentId: string) => string | undefined;
  generatingReferenceId?: string | null; // ID of reference currently generating a document
  onDeleteAnnotation?: (annotation: AnnotationSelection) => void;
  onConvertAnnotation?: (annotation: AnnotationSelection) => void;
}

// Effect to update annotation decorations with segments and new IDs
interface AnnotationUpdate {
  segments: TextSegment[];
  newAnnotationIds?: Set<string>;
}

const updateAnnotationsEffect = StateEffect.define<AnnotationUpdate>();

// Effect to update widget decorations
interface WidgetUpdate {
  content: string;
  segments: TextSegment[];
  generatingReferenceId?: string | null | undefined;
  callbacks: {
    onWikiLinkClick?: (pageName: string) => void;
    onEntityTypeClick?: (entityType: string) => void;
    onReferenceNavigate?: (documentId: string) => void;
    onUnresolvedReferenceClick?: (annotation: AnnotationSelection) => void;
    getTargetDocumentName?: (documentId: string) => string | undefined;
    onDeleteAnnotation?: (annotation: AnnotationSelection) => void;
    onConvertAnnotation?: (annotation: AnnotationSelection) => void;
  };
}

const updateWidgetsEffect = StateEffect.define<WidgetUpdate>();

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
          ? 'Click to delete or convert to reference'
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

// Build widget decorations
function buildWidgetDecorations(
  content: string,
  segments: TextSegment[],
  generatingReferenceId: string | null | undefined,
  callbacks: {
    onWikiLinkClick?: (pageName: string) => void;
    onEntityTypeClick?: (entityType: string) => void;
    onReferenceNavigate?: (documentId: string) => void;
    onUnresolvedReferenceClick?: (annotation: AnnotationSelection) => void;
    getTargetDocumentName?: (documentId: string) => string | undefined;
    onDeleteAnnotation?: (annotation: AnnotationSelection) => void;
    onConvertAnnotation?: (annotation: AnnotationSelection) => void;
  }
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  // Wiki link widgets removed (WikiLinkWidget was deleted)

  // Process all annotations (references and highlights) in sorted order
  // This ensures decorations are added in the correct order for CodeMirror
  const allAnnotatedSegments = segments
    .filter(s => s.annotation)
    .sort((a, b) => a.end - b.end); // Sort by end position

  for (const segment of allAnnotatedSegments) {
    if (!segment.annotation) continue;

    const annotation = segment.annotation;

    // For references: add resolution widget (🔗, ✨ pulsing, or ❓)
    if (annotation.type === 'reference') {
      const targetName = annotation.referencedDocumentId
        ? callbacks.getTargetDocumentName?.(annotation.referencedDocumentId)
        : undefined;
      const isGenerating = generatingReferenceId === annotation.id;
      const widget = new ReferenceResolutionWidget(
        annotation,
        targetName,
        callbacks.onReferenceNavigate,
        callbacks.onUnresolvedReferenceClick,
        isGenerating
      );
      builder.add(
        segment.end,
        segment.end,
        Decoration.widget({ widget, side: 1 })
      );
    }

  }

  return builder.finish();
}

// State field for widget decorations
const widgetDecorationsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);

    for (const effect of tr.effects) {
      if (effect.is(updateWidgetsEffect)) {
        decorations = buildWidgetDecorations(
          effect.value.content,
          effect.value.segments,
          effect.value.generatingReferenceId,
          effect.value.callbacks
        );
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
  onAnnotationHover,
  onTextSelect,
  onChange,
  editable = false,
  newAnnotationIds,
  hoveredAnnotationId,
  scrollToAnnotationId,
  sourceView = false,
  showLineNumbers = false,
  enableWidgets = false,
  onWikiLinkClick,
  onEntityTypeClick,
  onReferenceNavigate,
  onUnresolvedReferenceClick,
  getTargetDocumentName,
  generatingReferenceId,
  onDeleteAnnotation,
  onConvertAnnotation
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);
  const segmentsRef = useRef(segments);
  const lineNumbersCompartment = useRef(new Compartment());
  const callbacksRef = useRef<{
    onWikiLinkClick?: (pageName: string) => void;
    onEntityTypeClick?: (entityType: string) => void;
    onReferenceNavigate?: (documentId: string) => void;
    onUnresolvedReferenceClick?: (annotation: AnnotationSelection) => void;
    getTargetDocumentName?: (documentId: string) => string | undefined;
    onDeleteAnnotation?: (annotation: AnnotationSelection) => void;
    onConvertAnnotation?: (annotation: AnnotationSelection) => void;
  }>({});

  // Update segments ref when they change
  segmentsRef.current = segments;

  // Update callbacks ref when they change
  useEffect(() => {
    callbacksRef.current = {
      ...(onWikiLinkClick && { onWikiLinkClick }),
      ...(onEntityTypeClick && { onEntityTypeClick }),
      ...(onReferenceNavigate && { onReferenceNavigate }),
      ...(onUnresolvedReferenceClick && { onUnresolvedReferenceClick }),
      ...(getTargetDocumentName && { getTargetDocumentName }),
      ...(onDeleteAnnotation && { onDeleteAnnotation }),
      ...(onConvertAnnotation && { onConvertAnnotation })
    };
  }, [onWikiLinkClick, onEntityTypeClick, onReferenceNavigate, onUnresolvedReferenceClick, getTargetDocumentName, onDeleteAnnotation, onConvertAnnotation]);

  // Initialize CodeMirror view once
  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;

    // Create CodeMirror state with markdown mode
    const state = EditorState.create({
      doc: content,
      extensions: [
        markdown(),
        sourceView ? [] : markdownPreview(),
        lineNumbersCompartment.current.of(showLineNumbers ? lineNumbers() : []),
        EditorView.editable.of(editable),
        EditorView.lineWrapping,
        annotationDecorationsField,
        enableWidgets ? widgetDecorationsField : [],
        // Call onChange when content changes
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onChange) {
            onChange(update.state.doc.toString());
          }
        }),
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
          },
          mousemove: (event, view) => {
            if (!onAnnotationHover) return false;

            const target = event.target as HTMLElement;
            const annotationElement = target.closest('[data-annotation-id]');
            const annotationId = annotationElement?.getAttribute('data-annotation-id');

            // Track last hovered ID to avoid redundant calls
            const lastHovered = (view.dom as any).__lastHoveredAnnotation;
            if (annotationId !== lastHovered) {
              (view.dom as any).__lastHoveredAnnotation = annotationId || null;
              onAnnotationHover(annotationId || null);
            }

            return false;
          }
        }),
        // Style the editor
        EditorView.theme({
          '.cm-content': {
            padding: sourceView ? '1rem' : '0',
            fontFamily: sourceView ? 'ui-monospace, monospace' : 'inherit',
            fontSize: sourceView ? '0.875rem' : 'inherit',
            lineHeight: '1.6',
            whiteSpace: sourceView ? 'pre-wrap' : 'pre'
          },
          '.cm-line': {
            padding: '0',
            wordBreak: sourceView ? 'break-word' : 'normal'
          },
          '.cm-editor': {
            outline: 'none',
            backgroundColor: 'transparent'
          },
          '.cm-editor.cm-focused': {
            outline: 'none'
          },
          '.cm-scroller': {
            fontFamily: sourceView ? 'ui-monospace, monospace' : 'inherit',
            overflowX: sourceView ? 'auto' : 'visible'
          },
          '.cm-cursor': {
            display: editable ? 'block' : 'none'
          },
          '.cm-gutters': {
            backgroundColor: 'transparent',
            border: 'none',
            paddingRight: '0.5rem'
          },
          '.cm-lineNumbers .cm-gutterElement': {
            minWidth: '2rem',
            color: 'rgb(156, 163, 175)', // gray-400 for better contrast in dark mode
            opacity: '0.7'
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

    // Store the view on the container for position calculation
    (containerRef.current as any).__cmView = view;

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

  // Update line numbers when showLineNumbers changes
  useEffect(() => {
    if (!viewRef.current) return;

    viewRef.current.dispatch({
      effects: lineNumbersCompartment.current.reconfigure(showLineNumbers ? lineNumbers() : [])
    });
  }, [showLineNumbers]);

  // Update annotations when segments change
  useEffect(() => {
    if (!viewRef.current) return;

    viewRef.current.dispatch({
      effects: updateAnnotationsEffect.of({ segments, ...(newAnnotationIds && { newAnnotationIds }) })
    });
  }, [segments, newAnnotationIds]);

  // Update widgets when content, segments, or generatingReferenceId changes
  useEffect(() => {
    if (!viewRef.current || !enableWidgets) return;

    viewRef.current.dispatch({
      effects: updateWidgetsEffect.of({
        content,
        segments,
        generatingReferenceId,
        callbacks: callbacksRef.current
      })
    });
  }, [content, segments, enableWidgets, generatingReferenceId]);

  // Handle hovered annotation - add pulse effect and scroll if not visible
  useEffect(() => {
    if (!viewRef.current || !hoveredAnnotationId) return undefined;

    const segment = segments.find(s => s.annotation?.id === hoveredAnnotationId);
    if (!segment) return undefined;

    const view = viewRef.current;

    // Scroll first
    view.dispatch({
      effects: EditorView.scrollIntoView(segment.start, {
        y: 'nearest',
        yMargin: 50
      })
    });

    // Add pulse effect after a brief delay to ensure element is visible
    const timeoutId = setTimeout(() => {
      const element = view.contentDOM.querySelector(
        `[data-annotation-id="${hoveredAnnotationId}"]`
      ) as HTMLElement;

      if (element) {
        element.classList.add('annotation-pulse');
      }
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      const element = view.contentDOM.querySelector(
        `[data-annotation-id="${hoveredAnnotationId}"]`
      ) as HTMLElement;
      if (element) {
        element.classList.remove('annotation-pulse');
      }
    };
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

  const containerClasses = sourceView
    ? "codemirror-renderer bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg overflow-x-auto"
    : "codemirror-renderer";

  return <div ref={containerRef} className={containerClasses} data-markdown-container />;
}