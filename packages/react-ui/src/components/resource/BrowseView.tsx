'use client';

import { useEffect, useRef, useCallback, useMemo, memo, lazy, Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resourceUri as toResourceUri } from '@semiont/core';
import { getMimeCategory, isPdfMimeType } from '@semiont/api-client';
import { ANNOTATORS } from '../../lib/annotation-registry';
import { createHoverHandlers } from '../../hooks/useAttentionFlow';
import { scrollAnnotationIntoView } from '../../lib/scroll-utils';
import { ImageViewer } from '../viewers';
import { AnnotateToolbar, type ClickAction } from '../annotation/AnnotateToolbar';
import type { AnnotationsCollection } from '../../types/annotation-props';
import {
  buildSourceToRenderedMap,
  buildTextNodeIndex,
  resolveAnnotationRanges,
  applyHighlights,
  clearHighlights,
  toOverlayAnnotations,
} from '../../lib/annotation-overlay';

// Lazy load PDF component to avoid SSR issues with browser PDF.js loading
const PdfAnnotationCanvas = lazy(() => import('../pdf-annotation/PdfAnnotationCanvas.client').then(mod => ({ default: mod.PdfAnnotationCanvas })));

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
  hoverDelayMs?: number;
}

/**
 * Memoized markdown renderer — only re-renders when content changes.
 * No annotation plugins: annotations are applied as a DOM overlay after paint.
 */
const MemoizedMarkdown = memo(function MemoizedMarkdown({
  content,
}: {
  content: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
    >
      {content}
    </ReactMarkdown>
  );
});

/**
 * View component for browsing annotated resources in read-only mode.
 *
 * Two-layer rendering:
 * - Layer 1: Markdown renders once (MemoizedMarkdown, cached by content)
 * - Layer 2: Annotation overlay applied via DOM Range API after paint
 *
 * @emits attend:click - User clicked on annotation. Payload: { annotationId: string, motivation: Motivation }
 * @emits attend:hover - User hovered over annotation. Payload: { annotationId: string | null }
 *
 * @subscribes attend:hover - Highlight annotation on hover. Payload: { annotationId: string | null }
 * @subscribes attend:focus - Scroll to and highlight annotation. Payload: { annotationId: string }
 */
export const BrowseView = memo(function BrowseView({
  content,
  mimeType,
  resourceUri,
  annotations,
  selectedClick = 'detail',
  annotateMode,
  hoverDelayMs = 150
}: Props) {
  const { newAnnotationIds } = useResourceAnnotations();
  const eventBus = useEventBus();
  const containerRef = useRef<HTMLDivElement>(null);

  const category = getMimeCategory(mimeType);

  const { highlights, references, assessments, comments, tags } = annotations;

  const allAnnotations = useMemo(
    () => [...highlights, ...references, ...assessments, ...comments, ...tags],
    [highlights, references, assessments, comments, tags]
  );

  const overlayAnnotations = useMemo(
    () => toOverlayAnnotations(allAnnotations),
    [allAnnotations]
  );

  // Cache offset map (recomputed only when content changes)
  const offsetMapRef = useRef<Map<number, number> | null>(null);

  // Build offset map after markdown DOM paints (once per content change)
  useEffect(() => {
    if (!containerRef.current) return;
    offsetMapRef.current = buildSourceToRenderedMap(content, containerRef.current);
  }, [content]);

  // Layer 2: overlay annotations after DOM paint
  useEffect(() => {
    if (!containerRef.current || !offsetMapRef.current || overlayAnnotations.length === 0) return;

    const container = containerRef.current;
    const textNodeIndex = buildTextNodeIndex(container);
    const ranges = resolveAnnotationRanges(overlayAnnotations, offsetMapRef.current, textNodeIndex);
    applyHighlights(ranges);

    return () => clearHighlights(container);
  }, [overlayAnnotations]);

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
          eventBus.get('attend:click').next({ annotationId, motivation: annotation.motivation });
        }
      }
    };

    const { handleMouseEnter, handleMouseLeave, cleanup: cleanupHover } = createHoverHandlers(
      (annotationId) => eventBus.get('attend:hover').next({ annotationId }),
      hoverDelayMs
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
  }, [content, allAnnotations, newAnnotationIds, hoverDelayMs]);

  // Helper to scroll annotation into view with pulse effect
  const scrollToAnnotation = useCallback((annotationId: string | null, removePulse = false) => {
    if (!containerRef.current) return;
    // removePulse = true means "add pulse and auto-remove after 2s"
    scrollAnnotationIntoView(annotationId, containerRef.current, { pulse: removePulse });
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
    'attend:hover': handleAnnotationHover,
    'attend:focus': handleAnnotationFocus,
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
            <MemoizedMarkdown content={content} />
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
});
