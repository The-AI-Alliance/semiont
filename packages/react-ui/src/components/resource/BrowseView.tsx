'use client';

import { useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { annotationId as toAnnotationId } from '@semiont/core';
import { capabilitiesOf } from '@semiont/core';
import { createHoverHandlers } from '@semiont/sdk';
import { ANNOTATORS } from '../../lib/annotation-registry';
import { scrollAnnotationIntoView } from '../../lib/scroll-utils';
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

import type { SemiontSession } from '@semiont/sdk';
import { useSessionEventSubscriptions } from '../../hooks/useSessionEventSubscriptions';
import { defaultBrowseRenderers, type BrowseMediaRenderers } from './browse-renderers';

interface Props {
  content: string;
  mimeType: string;
  resourceUri: string;
  annotations: AnnotationsCollection;
  hoveredAnnotationId?: string | null;
  selectedClick?: ClickAction;
  annotateMode: boolean;
  hoverDelayMs?: number;
  /** Session for the shown resource — emits browse:click / beckon:hover; its bus feeds beckon events. */
  session: SemiontSession | null;
  /** Recently-created annotation ids to sparkle (host-provided; was ResourceAnnotationsContext). */
  newAnnotationIds?: Set<string>;
  /** Override the read-only media renderers (render mode → renderer); merged over the defaults. */
  renderers?: BrowseMediaRenderers;
}

/**
 * View component for browsing annotated resources in read-only mode.
 *
 * Two-layer rendering:
 * - Layer 1: Markdown renders once (MemoizedMarkdown, cached by content)
 * - Layer 2: Annotation overlay applied via DOM Range API after paint
 *
 * @emits browse:click - User clicked on annotation. Payload: { annotationId: string, motivation: Motivation }
 * @emits beckon:hover - User hovered over annotation. Payload: { annotationId: string | null }
 *
 * @subscribes beckon:hover - Highlight annotation on hover. Payload: { annotationId: string | null }
 * @subscribes beckon:focus - Scroll to and highlight annotation. Payload: { annotationId: string }
 */
export const BrowseView = memo(function BrowseView({
  content,
  mimeType,
  resourceUri,
  annotations,
  selectedClick = 'detail',
  annotateMode,
  hoverDelayMs = 150,
  session,
  newAnnotationIds,
  renderers,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const render = capabilitiesOf(mimeType)?.render ?? 'none';

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
    if (!session) return;

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
          session.client.browse.click(annotation.id, annotation.motivation);
        }
      }
    };

    const { handleMouseEnter, handleMouseLeave, cleanup: cleanupHover } = createHoverHandlers(
      (id) => session.client.beckon.hover(id),
      hoverDelayMs
    );

    // Single mouseover handler for the container - fires once on enter
    const handleMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const annotationElement = target.closest('[data-annotation-id]');
      const annotationId = annotationElement?.getAttribute('data-annotation-id');
      if (annotationId) handleMouseEnter(toAnnotationId(annotationId));
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
  }, [content, allAnnotations, newAnnotationIds, hoverDelayMs, session]);

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

  const handleAnnotationFocus = useCallback(({ annotationId }: { annotationId?: string | null }) => {
    scrollToAnnotation(annotationId ?? null, true);
  }, [scrollToAnnotation]);

  useSessionEventSubscriptions(session, {
    'beckon:hover': handleAnnotationHover,
    'beckon:focus': handleAnnotationFocus,
  });

  // Route to the media renderer for this render mode. `text`/`image`/`pdf` share
  // the shell (toolbar + annotation-overlay container); `none` (no preview, or an
  // unknown type) has its own metadata+download structure. Callers can override
  // any renderer via `renderers`.
  const mediaRenderers: BrowseMediaRenderers = { ...defaultBrowseRenderers, ...renderers };
  const Renderer = render === 'none' ? undefined : mediaRenderers[render];

  if (!Renderer) {
    return (
      <div ref={containerRef} className="semiont-browse-view semiont-browse-view--unsupported" data-mime-type="unsupported">
        <div className="semiont-browse-view__empty">
          <p className="semiont-browse-view__empty-message">
            Preview not available for {mimeType}
          </p>
          <a
            href={`/api/resources/${resourceUri}`}
            download
            className="semiont-button semiont-button--primary"
          >
            Download File
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="semiont-browse-view" data-mime-type={render}>
      <AnnotateToolbar
        selectedMotivation={null}
        selectedClick={selectedClick}
        showSelectionGroup={false}
        showDeleteButton={false}
        annotateMode={annotateMode}
        annotators={ANNOTATORS}
        session={session}
      />
      <div ref={containerRef} className="semiont-browse-view__content">
        <Renderer content={content} mimeType={mimeType} resourceUri={resourceUri} annotations={allAnnotations} />
      </div>
    </div>
  );
});
