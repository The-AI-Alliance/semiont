'use client';

import { useEffect, useRef } from 'react';
import { EditorView, Decoration, DecorationSet, lineNumbers } from '@codemirror/view';
import { EditorState, RangeSetBuilder, StateField, StateEffect, Compartment } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ReferenceResolutionWidget, showWidgetPreview, hideWidgetPreview } from '../lib/codemirror-widgets';
import { scrollAnnotationIntoView } from '../lib/scroll-utils';
import { isReference, createHoverHandlers, type SemiontSession } from '@semiont/api-client';
import {
  convertSegmentPositions,
  computeAnnotationDecorations,
  computeWidgetDecorations,
} from '../lib/codemirror-logic';
import type { TextSegment } from '../lib/codemirror-logic';
import {
  handleAnnotationClick,
  handleWidgetClick as processWidgetClick,
  dispatchWidgetClick,
  handleWidgetMouseEnter as processWidgetMouseEnter,
  handleWidgetMouseLeave as processWidgetMouseLeave,
} from '../lib/codemirror-handlers';

// Re-export TextSegment for consumers
export type { TextSegment } from '../lib/codemirror-logic';

// Type augmentation for custom DOM properties used to store CodeMirror state
interface EnrichedHTMLElement extends HTMLElement {
  __cmView?: EditorView;
}

interface Props {
  content: string;
  segments?: TextSegment[]; // Optional - only needed for annotation rendering
  onTextSelect?: (exact: string, position: { start: number; end: number }) => void;
  onChange?: (content: string) => void;
  editable?: boolean;
  newAnnotationIds?: Set<string>;
  hoveredAnnotationId?: string | null;
  scrollToAnnotationId?: string | null;
  sourceView?: boolean; // If true, show raw source (no markdown rendering)
  showLineNumbers?: boolean; // If true, show line numbers
  enableWidgets?: boolean; // If true, show inline widgets (reference previews, entity badges)
  session?: SemiontSession | null | undefined;
  getTargetResourceName?: (resourceId: string) => string | undefined;
  generatingReferenceId?: string | null; // ID of reference currently generating a document
  hoverDelayMs: number; // Hover delay in milliseconds for accessibility
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
  getTargetResourceName?: (resourceId: string) => string | undefined;
}

const updateWidgetsEffect = StateEffect.define<WidgetUpdate>();

// Build CodeMirror decorations from pure metadata
function buildAnnotationDecorations(
  segments: TextSegment[],
  newAnnotationIds?: Set<string>
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const entries = computeAnnotationDecorations(segments, newAnnotationIds);

  for (const { start, end, meta } of entries) {
    const decoration = Decoration.mark({
      class: meta.className,
      attributes: {
        'data-annotation-id': meta.annotationId,
        'data-annotation-type': meta.annotationType,
        title: meta.tooltip,
      },
    });
    builder.add(start, end, decoration);
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

// Build widget decorations using pure metadata
function buildWidgetDecorations(
  _content: string,
  segments: TextSegment[],
  generatingReferenceId: string | null | undefined,
  getTargetResourceName?: (resourceId: string) => string | undefined
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const widgetMetas = computeWidgetDecorations(segments, generatingReferenceId, getTargetResourceName);

  // We still need the full annotation objects for ReferenceResolutionWidget
  const annotationsByEnd = new Map<number, TextSegment>();
  for (const s of segments) {
    if (s.annotation && isReference(s.annotation)) {
      annotationsByEnd.set(s.end, s);
    }
  }

  for (const meta of widgetMetas) {
    const segment = annotationsByEnd.get(meta.position);
    if (!segment?.annotation) continue;

    const widget = new ReferenceResolutionWidget(
      segment.annotation,
      meta.targetName,
      meta.isGenerating
    );
    builder.add(meta.position, meta.position, Decoration.widget({ widget, side: 1 }));
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
          effect.value.getTargetResourceName
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
  scrollToAnnotationId,
  sourceView = false,
  showLineNumbers = false,
  enableWidgets = false,
  session,
  getTargetResourceName,
  generatingReferenceId,
  hoverDelayMs
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);

  // Convert segment positions from CRLF space to LF space
  // CodeMirror normalizes line endings internally, so positions must be adjusted
  const convertedSegments = convertSegmentPositions(segments, content);

  const segmentsRef = useRef(convertedSegments);
  // Index segments by annotation ID for O(1) click lookups
  const segmentsByIdRef = useRef(new Map<string, TextSegment>());
  const lineNumbersCompartment = useRef(new Compartment());
  const sessionRef = useRef(session);
  const getTargetResourceNameRef = useRef(getTargetResourceName);

  // Update refs when they change
  segmentsRef.current = segments;
  const segmentsById = new Map<string, TextSegment>();
  for (const s of segments) {
    if (s.annotation) segmentsById.set(s.annotation.id, s);
  }
  segmentsByIdRef.current = segmentsById;
  sessionRef.current = session;
  getTargetResourceNameRef.current = getTargetResourceName;

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
        // Handle clicks on annotations — delegates to extracted handler
        EditorView.domEventHandlers({
          click: (event, _view) => {
            const target = event.target as HTMLElement;
            if (sessionRef.current && handleAnnotationClick(target, segmentsByIdRef.current, sessionRef.current)) {
              event.preventDefault();
              return true;
            }
            return false;
          }
        }),
        // Style the editor
        EditorView.baseTheme({
          '&.cm-editor': {
            height: '100%',
            outline: 'none'
          },
          '&.cm-editor.cm-focused': {
            outline: 'none'
          },
          '.cm-scroller': {
            overflow: 'visible !important',
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
      (annotationId) => sessionRef.current?.emit('beckon:hover', { annotationId }),
      hoverDelayMs
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

    // Delegated widget event handlers — delegates to extracted handlers
    const onWidgetClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const result = processWidgetClick(target);
      if (!result.handled) return;

      e.preventDefault();
      e.stopPropagation();

      if (sessionRef.current) {
        dispatchWidgetClick(result, sessionRef.current);
      }
    };

    const onWidgetMouseEnter = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const result = processWidgetMouseEnter(target);
      if (result.showPreview && result.targetName && result.widget) {
        showWidgetPreview(result.widget, result.targetName);
      }
    };

    const onWidgetMouseLeave = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const result = processWidgetMouseLeave(target);
      if (result.hidePreview && result.widget) {
        hideWidgetPreview(result.widget);
      }
    };

    container.addEventListener('mouseover', handleMouseOver);
    container.addEventListener('mouseout', handleMouseOut);
    container.addEventListener('click', onWidgetClick);
    container.addEventListener('mouseenter', onWidgetMouseEnter, true);
    container.addEventListener('mouseleave', onWidgetMouseLeave, true);

    return () => {
      container.removeEventListener('mouseover', handleMouseOver);
      container.removeEventListener('mouseout', handleMouseOut);
      container.removeEventListener('click', onWidgetClick);
      container.removeEventListener('mouseenter', onWidgetMouseEnter, true);
      container.removeEventListener('mouseleave', onWidgetMouseLeave, true);
      cleanupHover();
      view.destroy();
      viewRef.current = null;
    };
  }, [hoverDelayMs]); // Re-initialize when hover delay changes

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
        getTargetResourceName: getTargetResourceNameRef.current
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

  // Handle scroll to annotation
  useEffect(() => {
    if (!viewRef.current || !scrollToAnnotationId) return;
    scrollAnnotationIntoView(scrollToAnnotationId, viewRef.current.contentDOM);
  }, [scrollToAnnotationId]);

  const containerClasses = sourceView
    ? "semiont-codemirror semiont-codemirror--source"
    : "semiont-codemirror";

  return <div ref={containerRef} className={containerClasses} data-markdown-container />;
}
