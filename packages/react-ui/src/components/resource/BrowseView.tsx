'use client';

import { useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkAnnotations, type PreparedAnnotation } from '../../lib/remark-annotations';
import { rehypeRenderAnnotations } from '../../lib/rehype-render-annotations';
import type { components } from '@semiont/api-client';
import { getExactText, getTextPositionSelector, getTargetSelector, getBodySource, getMimeCategory, isPdfMimeType, resourceUri as toResourceUri } from '@semiont/api-client';
import type { Annotator } from '../../lib/annotation-registry';
import { ImageViewer } from '../viewers';
import { AnnotateToolbar, type ClickAction } from '../annotation/AnnotateToolbar';
import type { AnnotationsCollection, AnnotationHandlers } from '../../types/annotation-props';

// Lazy load PDF component to avoid SSR issues with browser PDF.js loading
const PdfAnnotationCanvas = lazy(() => import('../pdf-annotation/PdfAnnotationCanvas.client').then(mod => ({ default: mod.PdfAnnotationCanvas })));

type Annotation = components['schemas']['Annotation'];
import { useResourceAnnotations } from '../../contexts/ResourceAnnotationsContext';
import { useMakeMeaningEvents } from '../../contexts/MakeMeaningEventBusContext';

interface Props {
  content: string;
  mimeType: string;
  resourceUri: string;
  annotations: AnnotationsCollection;
  handlers?: AnnotationHandlers;
  hoveredAnnotationId?: string | null;
  hoveredCommentId?: string | null;
  selectedClick?: ClickAction;
  onClickChange?: (motivation: ClickAction) => void;
  annotateMode: boolean;
  onAnnotateModeToggle: () => void;
  annotators: Record<string, Annotator>;
}

/**
 * Convert W3C Annotations to simplified format for remark plugin.
 * Extracts position info and converts start/end to offset/length.
 */
function prepareAnnotations(annotations: Annotation[], annotators: Record<string, Annotator>): PreparedAnnotation[] {
  return annotations
    .map(ann => {
      const targetSelector = getTargetSelector(ann.target);
      const posSelector = getTextPositionSelector(targetSelector);
      const start = posSelector?.start ?? 0;
      const end = posSelector?.end ?? 0;

      // Use annotators to determine type
      const type = Object.values(annotators).find(a => a.matchesAnnotation(ann))?.internalType || 'highlight';

      return {
        id: ann.id,
        exact: getExactText(targetSelector),
        offset: start,           // remark plugin expects 'offset'
        length: end - start,      // remark plugin expects 'length', not 'end'
        type,
        source: getBodySource(ann.body)
      };
    });
}

export function BrowseView({
  content,
  mimeType,
  resourceUri,
  annotations,
  handlers,
  selectedClick = 'detail',
  onClickChange,
  annotateMode,
  onAnnotateModeToggle,
  annotators
}: Props) {
  const { newAnnotationIds } = useResourceAnnotations();
  const eventBus = useMakeMeaningEvents();
  const containerRef = useRef<HTMLDivElement>(null);

  const category = getMimeCategory(mimeType);

  const { highlights, references, assessments, comments, tags } = annotations;

  // Extract individual handlers from grouped object
  const onAnnotationClick = handlers?.onClick;

  const allAnnotations = [...highlights, ...references, ...assessments, ...comments, ...tags];

  const preparedAnnotations = prepareAnnotations(allAnnotations, annotators);

  // Create a map of annotation ID -> full annotation for click handling
  const map = new Map<string, Annotation>();
  for (const ann of allAnnotations) {
    map.set(ann.id, ann);
  }
  const annotationMap = map;

  // Wrapper for annotation hover that routes based on registry metadata
  const handleAnnotationHover = useCallback((annotationId: string | null) => {
    if (annotationId) {
      const annotation = annotationMap.get(annotationId);
      const metadata = annotation ? Object.values(annotators).find(a => a.matchesAnnotation(annotation!)) : null;

      // Route to side panel if annotation type has one
      if (metadata?.hasSidePanel) {
        // Emit comment hover event
        eventBus.emit('ui:comment:hover', { commentId: annotationId });
        eventBus.emit('ui:annotation:hover', { annotationId: null });
        return;
      } else {
        // Emit annotation hover event
        eventBus.emit('ui:annotation:hover', { annotationId });
        eventBus.emit('ui:comment:hover', { commentId: null });
        return;
      }
    }
    // Clear both when null
    eventBus.emit('ui:annotation:hover', { annotationId: null });
    eventBus.emit('ui:comment:hover', { commentId: null });
  }, [annotationMap, eventBus, annotators]);

  // Attach click handlers, hover handlers, and animations after render
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;

    // Find all annotation spans
    const annotationSpans = container.querySelectorAll('[data-annotation-id]');

    // Attach click handlers
    const handleClick = (e: Event) => {
      const target = e.currentTarget as HTMLElement;
      const annotationId = target.getAttribute('data-annotation-id');
      const annotationType = target.getAttribute('data-annotation-type');

      if (annotationId && annotationType === 'reference' && onAnnotationClick) {
        const annotation = annotationMap.get(annotationId);
        if (annotation) {
          onAnnotationClick(annotation);
        }
      }
    };

    // Attach hover handlers
    const handleMouseEnter = (e: Event) => {
      const target = e.currentTarget as HTMLElement;
      const annotationId = target.getAttribute('data-annotation-id');
      if (annotationId) {
        handleAnnotationHover(annotationId);
      }
    };

    const handleMouseLeave = () => {
      handleAnnotationHover(null);
    };

    const clickHandlers: Array<{ element: Element; handler: EventListener }> = [];
    const hoverHandlers: Array<{ element: Element; enterHandler: EventListener; leaveHandler: EventListener }> = [];

    annotationSpans.forEach((span) => {
      const annotationType = span.getAttribute('data-annotation-type');
      if (annotationType === 'reference') {
        span.addEventListener('click', handleClick);
        clickHandlers.push({ element: span, handler: handleClick });
      }

      // Add hover handlers for all annotation types
      span.addEventListener('mouseenter', handleMouseEnter);
      span.addEventListener('mouseleave', handleMouseLeave);
      hoverHandlers.push({ element: span, enterHandler: handleMouseEnter, leaveHandler: handleMouseLeave });
    });

    // Apply animation classes to new annotations
    if (newAnnotationIds) {
      annotationSpans.forEach((span) => {
        const annotationId = span.getAttribute('data-annotation-id');
        if (annotationId && newAnnotationIds.has(annotationId)) {
          span.classList.add('annotation-sparkle');
        }
      });
    }

    // Cleanup
    return () => {
      clickHandlers.forEach(({ element, handler }) => {
        element.removeEventListener('click', handler);
      });
      hoverHandlers.forEach(({ element, enterHandler, leaveHandler }) => {
        element.removeEventListener('mouseenter', enterHandler);
        element.removeEventListener('mouseleave', leaveHandler);
      });
    };
  }, [content, allAnnotations, onAnnotationClick, annotationMap, newAnnotationIds, handleAnnotationHover]);

  // Subscribe to hover events - scroll and pulse annotation into view
  useEffect(() => {
    const handleHover = ({ annotationId }: { annotationId: string | null }) => {
      if (!containerRef.current || !annotationId) return;

      const element = containerRef.current.querySelector(
        `[data-annotation-id="${CSS.escape(annotationId)}"]`
      ) as HTMLElement;

      if (!element) return;

      // Find the scroll container
      const scrollContainer = element.closest('.semiont-browse-view__content') as HTMLElement;

      if (scrollContainer) {
        // Check visibility within the scroll container
        const elementRect = element.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();

        const isVisible =
          elementRect.top >= containerRect.top &&
          elementRect.bottom <= containerRect.bottom;

        if (!isVisible) {
          // Scroll using container.scrollTo to avoid scrolling ancestors
          const elementTop = element.offsetTop;
          const containerHeight = scrollContainer.clientHeight;
          const elementHeight = element.offsetHeight;
          const scrollTo = elementTop - (containerHeight / 2) + (elementHeight / 2);

          scrollContainer.scrollTo({ top: scrollTo, behavior: 'smooth' });
        }
      }

      // Add pulse effect
      setTimeout(() => {
        element.classList.add('annotation-pulse');
      }, 100);
    };

    eventBus.on('ui:annotation:hover', handleHover);
    return () => eventBus.off('ui:annotation:hover', handleHover);
  }, [eventBus]);

  // Subscribe to comment hover events - scroll and pulse comment into view
  useEffect(() => {
    const handleCommentHover = ({ commentId }: { commentId: string | null }) => {
      if (!containerRef.current || !commentId) return;

      const element = containerRef.current.querySelector(
        `[data-annotation-id="${CSS.escape(commentId)}"]`
      ) as HTMLElement;

      if (!element) return;

      // Find the scroll container
      const scrollContainer = element.closest('.semiont-browse-view__content') as HTMLElement;

      if (scrollContainer) {
        // Check visibility within the scroll container
        const elementRect = element.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();

        const isVisible =
          elementRect.top >= containerRect.top &&
          elementRect.bottom <= containerRect.bottom;

        if (!isVisible) {
          // Scroll using container.scrollTo to avoid scrolling ancestors
          const elementTop = element.offsetTop;
          const containerHeight = scrollContainer.clientHeight;
          const elementHeight = element.offsetHeight;
          const scrollTo = elementTop - (containerHeight / 2) + (elementHeight / 2);

          scrollContainer.scrollTo({ top: scrollTo, behavior: 'smooth' });
        }
      }

      // Add pulse effect
      setTimeout(() => {
        element.classList.add('annotation-pulse');
      }, 100);
    };

    eventBus.on('ui:comment:hover', handleCommentHover);
    return () => eventBus.off('ui:comment:hover', handleCommentHover);
  }, [eventBus]);

  // Route to appropriate viewer based on MIME type category
  switch (category) {
    case 'text':
      return (
        <div className="semiont-browse-view" data-mime-type="text">
          <AnnotateToolbar
            selectedMotivation={null}
            selectedClick={selectedClick}
            onSelectionChange={() => {}}
            onClickChange={onClickChange || (() => {})}
            showSelectionGroup={false}
            showDeleteButton={false}
            annotateMode={annotateMode}
            onAnnotateModeToggle={onAnnotateModeToggle}
            annotators={annotators}
          />
          <div ref={containerRef} className="semiont-browse-view__content">
            <ReactMarkdown
              remarkPlugins={[
                remarkGfm,
                [remarkAnnotations, { annotations: preparedAnnotations }]
              ]}
              rehypePlugins={[
                rehypeRenderAnnotations
              ]}
            >
              {content}
            </ReactMarkdown>
          </div>
        </div>
      );

    case 'image':
      // Check if it's actually a PDF (categorized as 'image' for spatial annotations)
      if (isPdfMimeType(mimeType)) {
        return (
          <div className="semiont-browse-view" data-mime-type="pdf">
            <AnnotateToolbar
              selectedMotivation={null}
              selectedClick={selectedClick}
              onSelectionChange={() => {}}
              onClickChange={onClickChange || (() => {})}
              showSelectionGroup={false}
              showDeleteButton={false}
              annotateMode={annotateMode}
              onAnnotateModeToggle={onAnnotateModeToggle}
              annotators={annotators}
            />
            <div ref={containerRef} className="semiont-browse-view__content">
              <Suspense fallback={<div className="semiont-browse-view__loading">Loading PDF viewer...</div>}>
                <PdfAnnotationCanvas
                  resourceUri={toResourceUri(resourceUri)}
                  existingAnnotations={allAnnotations}
                  drawingMode={null}
                  selectedMotivation={null}
                  onAnnotationCreate={() => {}}
                  {...(onAnnotationClick && { onAnnotationClick })}
                />
              </Suspense>
            </div>
          </div>
        );
      }

      // Regular image
      return (
        <div className="semiont-browse-view" data-mime-type="image">
          <AnnotateToolbar
            selectedMotivation={null}
            selectedClick={selectedClick}
            onSelectionChange={() => {}}
            onClickChange={onClickChange || (() => {})}
            showSelectionGroup={false}
            showDeleteButton={false}
            annotateMode={annotateMode}
            onAnnotateModeToggle={onAnnotateModeToggle}
            annotators={annotators}
          />
          <div ref={containerRef} className="semiont-browse-view__content">
            <ImageViewer
              resourceUri={resourceUri as any}
              mimeType={mimeType}
              alt="Resource content"
            />
          </div>
        </div>
      );

    case 'unsupported':
      return (
        <div ref={containerRef} className="semiont-browse-view semiont-browse-view--unsupported" data-mime-type="unsupported">
          <div className="semiont-browse-view__empty">
            <p className="semiont-browse-view__empty-message">
              Preview not available for {mimeType}
            </p>
            <a
              href={resourceUri}
              download
              className="semiont-button semiont-button--primary"
            >
              Download File
            </a>
          </div>
        </div>
      );
  }
}