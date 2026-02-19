'use client';

import { useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkAnnotations, type PreparedAnnotation } from '../../lib/remark-annotations';
import { rehypeRenderAnnotations } from '../../lib/rehype-render-annotations';
import type { components } from '@semiont/api-client';
import { getExactText, getTextPositionSelector, getTargetSelector, getBodySource, getMimeCategory, isPdfMimeType, resourceUri as toResourceUri } from '@semiont/api-client';
import { ANNOTATORS } from '../../lib/annotation-registry';
import { createHoverHandlers } from '../../hooks/useAttentionFlow';
import { ImageViewer } from '../viewers';
import { AnnotateToolbar, type ClickAction } from '../annotation/AnnotateToolbar';
import type { AnnotationsCollection } from '../../types/annotation-props';

// Lazy load PDF component to avoid SSR issues with browser PDF.js loading
const PdfAnnotationCanvas = lazy(() => import('../pdf-annotation/PdfAnnotationCanvas.client').then(mod => ({ default: mod.PdfAnnotationCanvas })));

type Annotation = components['schemas']['Annotation'];
import { useResourceAnnotations } from '../../contexts/ResourceAnnotationsContext';
import { useEventBus } from '../../contexts/EventBusContext';
import { useEventSubscriptions } from '../../contexts/useEventSubscription';

interface Props {
  content: string;
  mimeType: string;
  resourceUri: string;
  annotations: AnnotationsCollection;
  hoveredAnnotationId?: string | null;
  hoveredCommentId?: string | null;
  selectedClick?: ClickAction;
  annotateMode: boolean;
}

/**
 * Convert W3C Annotations to simplified format for remark plugin.
 * Extracts position info and converts start/end to offset/length.
 */
function prepareAnnotations(annotations: Annotation[]): PreparedAnnotation[] {
/**
 * View component for browsing resources with rendered annotations
 *
 * @emits annotation:click - Annotation clicked in browse view. Payload: { annotationId: string, motivation: Motivation }
 * @emits annotation:hover - Annotation hovered in browse view. Payload: { annotationId: string | null }
 */
  return annotations
    .map(ann => {
      const targetSelector = getTargetSelector(ann.target);
      const posSelector = getTextPositionSelector(targetSelector);
      const start = posSelector?.start ?? 0;
      const end = posSelector?.end ?? 0;

      // Use ANNOTATORS registry to determine type
      const type = Object.values(ANNOTATORS).find(a => a.matchesAnnotation(ann))?.internalType || 'highlight';

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

/**
 * View component for browsing annotated resources in read-only mode
 *
 * @emits annotation:click - User clicked on annotation. Payload: { annotationId: string, motivation: Motivation }
 * @emits annotation:hover - User hovered over annotation. Payload: { annotationId: string | null }
 *
 * @subscribes annotation:hover - Highlight annotation on hover. Payload: { annotationId: string | null }
 * @subscribes annotation:focus - Scroll to and highlight annotation. Payload: { annotationId: string }
 */
export function BrowseView({
  content,
  mimeType,
  resourceUri,
  annotations,
  selectedClick = 'detail',
  annotateMode
}: Props) {
  const { newAnnotationIds } = useResourceAnnotations();
  const eventBus = useEventBus();
  const containerRef = useRef<HTMLDivElement>(null);

  const category = getMimeCategory(mimeType);

  const { highlights, references, assessments, comments, tags } = annotations;

  const allAnnotations = [...highlights, ...references, ...assessments, ...comments, ...tags];

  const preparedAnnotations = prepareAnnotations(allAnnotations);

  // Attach click handler, hover handler, and animations after render
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;

    // Single click handler for the container
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const annotationElement = target.closest('[data-annotation-id]');
      if (!annotationElement) return;

      const annotationId = annotationElement.getAttribute('data-annotation-id');
      const annotationType = annotationElement.getAttribute('data-annotation-type');

      if (annotationId && annotationType === 'reference') {
        const annotation = allAnnotations.find(a => a.id === annotationId);
        if (annotation) {
          eventBus.emit('annotation:click', { annotationId, motivation: annotation.motivation });
        }
      }
    };

    const { handleMouseEnter, handleMouseLeave, cleanup: cleanupHover } = createHoverHandlers(
      (annotationId) => eventBus.emit('annotation:hover', { annotationId })
    );

    // Single mouseover handler for the container - fires once on enter
    const handleMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const annotationElement = target.closest('[data-annotation-id]');
      const annotationId = annotationElement?.getAttribute('data-annotation-id');
      if (annotationId) handleMouseEnter(annotationId);
    };

    // Single mouseout handler for the container - fires once on exit
    const handleMouseOut = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const annotationElement = target.closest('[data-annotation-id]');
      if (annotationElement) handleMouseLeave();
    };

    // Apply animation classes to new annotations
    if (newAnnotationIds) {
      const annotationSpans = container.querySelectorAll('[data-annotation-id]');
      annotationSpans.forEach((span) => {
        const annotationId = span.getAttribute('data-annotation-id');
        if (annotationId && newAnnotationIds.has(annotationId)) {
          span.classList.add('annotation-sparkle');
        }
      });
    }

    container.addEventListener('click', handleClick);
    container.addEventListener('mouseover', handleMouseOver);
    container.addEventListener('mouseout', handleMouseOut);

    return () => {
      container.removeEventListener('click', handleClick);
      container.removeEventListener('mouseover', handleMouseOver);
      container.removeEventListener('mouseout', handleMouseOut);
      cleanupHover();
    };
  }, [content, allAnnotations, newAnnotationIds]);

  // Helper to scroll annotation into view with pulse effect
  const scrollToAnnotation = useCallback((annotationId: string | null, removePulse = false) => {
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
    element.classList.add('annotation-pulse');
    if (removePulse) {
      setTimeout(() => {
        element.classList.remove('annotation-pulse');
      }, 2000);
    }
  }, []);

  // Handle hover events for scrolling
  // Event handlers (extracted to avoid inline arrow functions)
  const handleAnnotationHover = useCallback(({ annotationId }: { annotationId: string | null }) => {
    scrollToAnnotation(annotationId);
  }, [scrollToAnnotation]);

  const handleAnnotationFocus = useCallback(({ annotationId }: { annotationId: string | null }) => {
    scrollToAnnotation(annotationId, true);
  }, [scrollToAnnotation]);

  useEventSubscriptions({
    'annotation:hover': handleAnnotationHover,
    'annotation:focus': handleAnnotationFocus,
  });

  // Route to appropriate viewer based on MIME type category
  switch (category) {
    case 'text':
      return (
        <div className="semiont-browse-view" data-mime-type="text">
          <AnnotateToolbar
            selectedMotivation={null}
            selectedClick={selectedClick}
            showSelectionGroup={false}
            showDeleteButton={false}
            annotateMode={annotateMode}
            annotators={ANNOTATORS}
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
              showSelectionGroup={false}
              showDeleteButton={false}
              annotateMode={annotateMode}
              annotators={ANNOTATORS}
            />
            <div ref={containerRef} className="semiont-browse-view__content">
              <Suspense fallback={<div className="semiont-browse-view__loading">Loading PDF viewer...</div>}>
                <PdfAnnotationCanvas
                  resourceUri={toResourceUri(resourceUri)}
                  existingAnnotations={allAnnotations}
                  drawingMode={null}
                  selectedMotivation={null}
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
            showSelectionGroup={false}
            showDeleteButton={false}
            annotateMode={annotateMode}
            annotators={ANNOTATORS}
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