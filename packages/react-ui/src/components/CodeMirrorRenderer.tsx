'use client';

import { useEffect, useRef } from 'react';
import { EditorView, Decoration, DecorationSet, lineNumbers } from '@codemirror/view';
import { EditorState, RangeSetBuilder, StateField, StateEffect, Compartment } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ANNOTATORS } from '../lib/annotation-registry';
import { ReferenceResolutionWidget } from '../lib/codemirror-widgets';
import { isHighlight, isReference, isResolvedReference, isComment, isAssessment, isTag, getBodySource } from '@semiont/api-client';
import type { components } from '@semiont/core';
import type { EventBus } from "@semiont/core";
import { createHoverHandlers } from '../hooks/useAttentionFlow';

type Annotation = components['schemas']['Annotation'];

// Type augmentation for custom DOM properties used to store CodeMirror state
interface EnrichedHTMLElement extends HTMLElement {
  __lastHoveredAnnotation?: string | null;
  __cmView?: EditorView;
}

export interface TextSegment {
  exact: string;
  annotation?: Annotation;
  start: number;
  end: number;
}

interface Props {
  content: string;
  segments?: TextSegment[]; // Optional - only needed for annotation rendering
  onTextSelect?: (exact: string, position: { start: number; end: number }) => void;
  onChange?: (content: string) => void;
  editable?: boolean;
  newAnnotationIds?: Set<string>;
  hoveredAnnotationId?: string | null;
  hoveredCommentId?: string | null;
  scrollToAnnotationId?: string | null;
  sourceView?: boolean; // If true, show raw source (no markdown rendering)
  showLineNumbers?: boolean; // If true, show line numbers
  enableWidgets?: boolean; // If true, show inline widgets (reference previews, entity badges)
  eventBus?: EventBus;
  getTargetDocumentName?: (documentId: string) => string | undefined;
  generatingReferenceId?: string | null; // ID of reference currently generating a document
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
  eventBus?: EventBus;
  getTargetDocumentName?: (documentId: string) => string | undefined;
}

const updateWidgetsEffect = StateEffect.define<WidgetUpdate>();

/**
 * Convert positions from CRLF character space to LF character space.
 * CodeMirror normalizes all line endings to LF internally, but annotation positions
 * are calculated in the original content's character space (which may have CRLF).
 *
 * @param segments - Segments with positions in CRLF space
 * @param content - Original content (may have CRLF line endings)
 * @returns Segments with positions adjusted for LF space
 */
function convertSegmentPositions(segments: TextSegment[], content: string): TextSegment[] {
  // If content has no CRLF, no conversion needed
  if (!content.includes('\r\n')) {
    return segments;
  }

  // Build a map of CRLF positions for efficient lookup
  const crlfPositions: number[] = [];
  for (let i = 0; i < content.length - 1; i++) {
    if (content[i] === '\r' && content[i + 1] === '\n') {
      crlfPositions.push(i);
    }
  }

  // Convert a single position from CRLF space to LF space
  const convertPosition = (pos: number): number => {
    // Count how many CRLFs appear before this position
    const crlfsBefore = crlfPositions.filter(crlfPos => crlfPos < pos).length;
    return pos - crlfsBefore;
  };

  return segments.map(seg => ({
    ...seg,
    start: convertPosition(seg.start),
    end: convertPosition(seg.end)
  }));
}

/**
 * Get tooltip text for annotation based on type/motivation
 */
function getAnnotationTooltip(annotation: Annotation): string {
  const isCommentAnn = isComment(annotation);
  const isHighlightAnn = isHighlight(annotation);
  const isAssessmentAnn = isAssessment(annotation);
  const isTagAnn = isTag(annotation);
  const isReferenceAnn = isReference(annotation);
  const isResolvedRef = isResolvedReference(annotation);

  if (isCommentAnn) {
    return 'Comment';
  } else if (isHighlightAnn) {
    return 'Highlight';
  } else if (isAssessmentAnn) {
    return 'Assessment';
  } else if (isTagAnn) {
    return 'Tag';
  } else if (isResolvedRef) {
    return 'Resolved Reference';
  } else if (isReferenceAnn) {
    return 'Unresolved Reference';
  }
  return 'Annotation';
}

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
    const baseClassName = Object.values(ANNOTATORS).find(a => a.matchesAnnotation(segment.annotation!))?.className || 'annotation-highlight';
    const className = isNew ? `${baseClassName} annotation-sparkle` : baseClassName;

    // Use W3C helpers to determine annotation type
    const isHighlightAnn = isHighlight(segment.annotation);
    const isReferenceAnn = isReference(segment.annotation);
    const isCommentAnn = isComment(segment.annotation);
    const isAssessmentAnn = isAssessment(segment.annotation);
    const isTagAnn = isTag(segment.annotation);

    // Determine annotation type for data attribute - use motivation directly
    let annotationType = 'highlight'; // default
    if (isCommentAnn) annotationType = 'comment';
    else if (isReferenceAnn) annotationType = 'reference';
    else if (isAssessmentAnn) annotationType = 'assessment';
    else if (isTagAnn) annotationType = 'tag';
    else if (isHighlightAnn) annotationType = 'highlight';

    const decoration = Decoration.mark({
      class: className,
      attributes: {
        'data-annotation-id': segment.annotation.id,
        'data-annotation-type': annotationType,
        title: getAnnotationTooltip(segment.annotation)
      }
    });

    builder.add(segment.start, segment.end, decoration);
  }

  return builder.finish();
}

// Create state field for annotation decorations
function createAnnotationDecorationsField() {
  return StateField.define<DecorationSet>({
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
}

// Build widget decorations
function buildWidgetDecorations(
  _content: string,
  segments: TextSegment[],
  generatingReferenceId: string | null | undefined,
  eventBus: any,
  getTargetDocumentName?: (documentId: string) => string | undefined
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
    // Use W3C helper to determine if this is a reference
    if (isReference(annotation)) {
      const bodySource = getBodySource(annotation.body);
      const targetName = bodySource
        ? getTargetDocumentName?.(bodySource)
        : undefined;
      // Compare by ID portion (handle both URI and internal ID formats)
      const isGenerating = generatingReferenceId
        ? annotation.id === generatingReferenceId
        : false;
      const widget = new ReferenceResolutionWidget(
        annotation,
        targetName,
        eventBus,
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
          effect.value.eventBus,
          effect.value.getTargetDocumentName
        );
      }
    }

    return decorations;
  },
  provide: field => EditorView.decorations.from(field)
});

export function CodeMirrorRenderer({
  content,
  segments = [],
  onChange,
  editable = false,
  newAnnotationIds,
  hoveredAnnotationId,
  hoveredCommentId,
  scrollToAnnotationId,
  sourceView = false,
  showLineNumbers = false,
  enableWidgets = false,
  eventBus,
  getTargetDocumentName,
  generatingReferenceId
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);

  // Convert segment positions from CRLF space to LF space
  // CodeMirror normalizes line endings internally, so positions must be adjusted
  const convertedSegments = convertSegmentPositions(segments, content);

  const segmentsRef = useRef(convertedSegments);
  const lineNumbersCompartment = useRef(new Compartment());
  const eventBusRef = useRef(eventBus);
  const getTargetDocumentNameRef = useRef(getTargetDocumentName);

  // Update refs when they change
  segmentsRef.current = segments;
  eventBusRef.current = eventBus;
  getTargetDocumentNameRef.current = getTargetDocumentName;

  // Initialize CodeMirror view once
  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;

    // Create annotation decorations field
    const annotationDecorationsField = createAnnotationDecorationsField();

    // Create CodeMirror state with markdown mode
    const state = EditorState.create({
      doc: content,
      extensions: [
        markdown(),
        lineNumbersCompartment.current.of(showLineNumbers ? lineNumbers() : []),
        EditorView.editable.of(editable),
        EditorView.lineWrapping,
        annotationDecorationsField,
        enableWidgets ? widgetDecorationsField : [],
        // Call onChange when content changes
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onChange) {
            const newContent = update.state.doc.toString();
            contentRef.current = newContent; // Update ref to prevent cursor jumping
            onChange(newContent);
          }
        }),
        // Handle clicks on annotations
        EditorView.domEventHandlers({
          click: (event, _view) => {
            const target = event.target as HTMLElement;
            const annotationElement = target.closest('[data-annotation-id]');
            const annotationId = annotationElement?.getAttribute('data-annotation-id');

            if (annotationId && eventBusRef.current) {
              const segment = segmentsRef.current.find(s => s.annotation?.id === annotationId);
              if (segment?.annotation) {
                event.preventDefault();
                eventBusRef.current.get('annotation:click').next({
                  annotationId,
                  motivation: segment.annotation.motivation
                });
                return true; // Stop propagation
              }
            }
            return false;
          }
        }),
        // Style the editor - use CSS string to inject !important rules
        EditorView.baseTheme({
          '&.cm-editor': {
            height: '100%',
            outline: 'none'
          },
          '&.cm-editor.cm-focused': {
            outline: 'none'
          },
          '.cm-scroller': {
            overflow: 'visible !important', // Let parent container handle scrolling
            height: 'auto !important'
          },
          '.cm-content, .cm-gutters': {
            minHeight: '0 !important'
          },
          '.cm-content': {
            padding: sourceView ? '1rem' : '0',
            fontFamily: sourceView ? 'ui-monospace, monospace' : 'inherit',
            fontSize: sourceView ? '0.875rem' : 'inherit',
            lineHeight: '1.6',
            whiteSpace: sourceView ? 'pre-wrap' : 'pre',
            caretColor: 'var(--cm-cursor-color, #000000)'
          },
          '.cm-line': {
            padding: '0',
            wordBreak: sourceView ? 'break-word' : 'normal'
          },
          '.cm-gutters': {
            backgroundColor: 'transparent',
            border: 'none',
            paddingRight: '0.5rem'
          },
          '.cm-lineNumbers .cm-gutterElement': {
            minWidth: '2rem',
            color: 'rgb(156, 163, 175)',
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
    (containerRef.current as EnrichedHTMLElement).__cmView = view;

    // Attach hover event listeners using native DOM events with delegation
    const container = view.dom;

    const { handleMouseEnter, handleMouseLeave, cleanup: cleanupHover } = createHoverHandlers(
      (annotationId) => eventBusRef.current?.get('annotation:hover').next({ annotationId })
    );

    const handleMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const annotationElement = target.closest('[data-annotation-id]');
      const annotationId = annotationElement?.getAttribute('data-annotation-id');
      if (annotationId) handleMouseEnter(annotationId);
    };

    const handleMouseOut = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const annotationElement = target.closest('[data-annotation-id]');
      if (annotationElement) handleMouseLeave();
    };

    container.addEventListener('mouseover', handleMouseOver);
    container.addEventListener('mouseout', handleMouseOut);

    return () => {
      container.removeEventListener('mouseover', handleMouseOver);
      container.removeEventListener('mouseout', handleMouseOut);
      cleanupHover();
      view.destroy();
      viewRef.current = null;
    };
  }, []); // Only initialize once

  // Update content when it changes externally (not from user typing)
  useEffect(() => {
    if (!viewRef.current) return;

    const currentContent = viewRef.current.state.doc.toString();

    // Only update if content is different from what's in the editor
    // Skip if content matches current editor state (prevents cursor jumping)
    if (content === currentContent) return;

    // Save cursor position
    const selection = viewRef.current.state.selection.main;

    viewRef.current.dispatch({
      changes: {
        from: 0,
        to: viewRef.current.state.doc.length,
        insert: content
      },
      // Restore cursor position if possible
      selection: selection.from <= content.length ? selection : undefined
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
      effects: updateAnnotationsEffect.of({ segments: convertedSegments, ...(newAnnotationIds && { newAnnotationIds }) })
    });
  }, [convertedSegments, newAnnotationIds]);

  // Update widgets when content, segments, or generatingReferenceId changes
  useEffect(() => {
    if (!viewRef.current || !enableWidgets) return;

    viewRef.current.dispatch({
      effects: updateWidgetsEffect.of({
        content,
        segments: convertedSegments,
        generatingReferenceId,
        eventBus: eventBusRef.current,
        getTargetDocumentName: getTargetDocumentNameRef.current
      })
    });
  }, [content, convertedSegments, enableWidgets, generatingReferenceId]);

  // Handle hovered annotation - add pulse effect and scroll if not visible
  useEffect(() => {
    if (!viewRef.current || !hoveredAnnotationId) return undefined;

    const view = viewRef.current;

    // Find the annotation element in the DOM
    const element = view.contentDOM.querySelector(
      `[data-annotation-id="${CSS.escape(hoveredAnnotationId)}"]`
    ) as HTMLElement;

    if (!element) return undefined;

    // Find the actual scroll container - could be annotate view or document viewer
    const scrollContainer = (element.closest('.semiont-annotate-view__content') ||
                            element.closest('.semiont-document-viewer__scrollable-body')) as HTMLElement;

    if (scrollContainer) {
      // Check visibility within the scroll container, not window
      const elementRect = element.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();

      const isVisible =
        elementRect.top >= containerRect.top &&
        elementRect.bottom <= containerRect.bottom;

      if (!isVisible) {
        // Manually scroll the container instead of using scrollIntoView
        const elementTop = element.offsetTop;
        const containerHeight = scrollContainer.clientHeight;
        const elementHeight = element.offsetHeight;
        const scrollTo = elementTop - (containerHeight / 2) + (elementHeight / 2);

        scrollContainer.scrollTo({ top: scrollTo, behavior: 'smooth' });
      }
    }

    // Add pulse effect after a brief delay to ensure element is visible
    const timeoutId = setTimeout(() => {
      element.classList.add('annotation-pulse');
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      element.classList.remove('annotation-pulse');
    };
  }, [hoveredAnnotationId]);

  // Handle hovered comment - add pulse effect and scroll if not visible
  useEffect(() => {
    if (!viewRef.current || !hoveredCommentId) return undefined;

    const view = viewRef.current;

    // Find the comment element in the DOM
    const element = view.contentDOM.querySelector(
      `[data-annotation-id="${CSS.escape(hoveredCommentId)}"]`
    ) as HTMLElement;

    if (!element) return undefined;

    // Find the actual scroll container - could be annotate view or document viewer
    const scrollContainer = (element.closest('.semiont-annotate-view__content') ||
                            element.closest('.semiont-document-viewer__scrollable-body')) as HTMLElement;

    if (scrollContainer) {
      // Check visibility within the scroll container, not window
      const elementRect = element.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();

      const isVisible =
        elementRect.top >= containerRect.top &&
        elementRect.bottom <= containerRect.bottom;

      if (!isVisible) {
        // Manually scroll the container instead of using scrollIntoView
        const elementTop = element.offsetTop;
        const containerHeight = scrollContainer.clientHeight;
        const elementHeight = element.offsetHeight;
        const scrollTo = elementTop - (containerHeight / 2) + (elementHeight / 2);

        scrollContainer.scrollTo({ top: scrollTo, behavior: 'smooth' });
      }
    }

    // Add pulse effect after a brief delay to ensure element is visible
    const timeoutId = setTimeout(() => {
      element.classList.add('annotation-pulse');
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      element.classList.remove('annotation-pulse');
    };
  }, [hoveredCommentId]);

  // Handle scroll to annotation
  useEffect(() => {
    if (!viewRef.current || !scrollToAnnotationId) return;

    const view = viewRef.current;

    // Find the annotation element in the DOM
    const element = view.contentDOM.querySelector(
      `[data-annotation-id="${CSS.escape(scrollToAnnotationId)}"]`
    ) as HTMLElement;

    if (!element) return;

    // Find the actual scroll container - could be annotate view or document viewer
    const scrollContainer = (element.closest('.semiont-annotate-view__content') ||
                            element.closest('.semiont-document-viewer__scrollable-body')) as HTMLElement;

    if (scrollContainer) {
      // Scroll using container.scrollTo to avoid scrolling ancestors
      const elementTop = element.offsetTop;
      const containerHeight = scrollContainer.clientHeight;
      const elementHeight = element.offsetHeight;
      const scrollTo = elementTop - (containerHeight / 2) + (elementHeight / 2);

      scrollContainer.scrollTo({ top: scrollTo, behavior: 'smooth' });
    }
  }, [scrollToAnnotationId]);

  const containerClasses = sourceView
    ? "semiont-codemirror semiont-codemirror--source"
    : "semiont-codemirror";

  return <div ref={containerRef} className={containerClasses} data-markdown-container />;
}