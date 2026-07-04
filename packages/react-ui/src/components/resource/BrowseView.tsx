'use client';

import { useEffect, useRef, useCallback, useMemo, memo, type MouseEvent as ReactMouseEvent } from 'react';
import { annotationId as toAnnotationId, resourceId as toResourceId } from '@semiont/core';
import { capabilitiesOf, getBodySource, isResolvedReference } from '@semiont/core';
import type { Annotation, ResourceDescriptor } from '@semiont/core';
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
  /** A content link (`<a href>` in the rendered content) was clicked. The viewer preventDefaults and
   *  delegates; it never navigates on its own. Omit → the click is still blocked (nothing happens). */
  onLinkClick?: (link: { href: string; event: ReactMouseEvent }) => void;
  /** A RESOLVED reference span is hovered: fires after the dwell AND the referent's cached descriptor
   *  resolves; `null` on leave (only if a hover fired — stubs stay silent). Host renders its own preview. */
  onReferenceHover?: (hover: ReferenceHover | null) => void;
  /** Inline display variant: auto-height to content, no inner scroll container, no pane chrome —
   *  drops into a chat bubble / card / list item. Default: fill-the-pane (unchanged). */
  inline?: boolean;
}

/** Payload for `onReferenceHover` — the hovered linking annotation, its resolved referent, and where the span is. */
export interface ReferenceHover {
  annotation: Annotation;
  referent: ResourceDescriptor;
  anchorRect: DOMRect;
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
  onLinkClick,
  onReferenceHover,
  inline = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inlineMod = inline ? ' semiont-browse-view--inline' : '';

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

    // Reference-hover delegation (host-facing event surface): after the dwell,
    // resolve the referent's cached descriptor and hand the host
    // { annotation, referent, anchorRect }; `null` on leave — but only if a hover
    // fired, so stubs stay silent. Rides the SAME dwell emitter as beckon:hover —
    // one state machine, two consumers.
    let hoveredElement: HTMLElement | null = null;
    let referentSub: { unsubscribe(): void } | null = null;
    let referenceHoverFired = false;

    const startReferenceHover = (id: string) => {
      if (!onReferenceHover) return; // no handler → no referent load
      const annotation = allAnnotations.find(a => a.id === id);
      if (!annotation || !isResolvedReference(annotation)) return; // stub / non-reference: fires nothing
      const referentId = getBodySource(annotation.body);
      const element = hoveredElement;
      if (!referentId || !element) return;
      referentSub?.unsubscribe();
      referentSub = session.client.browse.resource(toResourceId(referentId)).subscribe({
        next: (referent) => {
          if (referent === undefined) return; // cache still loading
          referentSub?.unsubscribe();
          referentSub = null;
          referenceHoverFired = true;
          // anchorRect taken at fire time so it reflects current layout.
          onReferenceHover({ annotation, referent, anchorRect: element.getBoundingClientRect() });
        },
        error: () => { referentSub = null; }, // failed load: never fires
      });
    };

    const endReferenceHover = () => {
      referentSub?.unsubscribe(); // leave-before-resolve: cancel, no fire
      referentSub = null;
      if (referenceHoverFired) {
        referenceHoverFired = false;
        onReferenceHover?.(null);
      }
    };

    const { handleMouseEnter, handleMouseLeave, cleanup: cleanupHover } = createHoverHandlers(
      (id) => {
        session.client.beckon.hover(id);
        if (id) startReferenceHover(id); else endReferenceHover();
      },
      hoverDelayMs
    );

    // Single mouseover handler for the container - fires once on enter
    const handleMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const annotationElement = target.closest('[data-annotation-id]');
      const annotationId = annotationElement?.getAttribute('data-annotation-id');
      if (annotationId) {
        hoveredElement = annotationElement as HTMLElement; // anchor for onReferenceHover
        handleMouseEnter(toAnnotationId(annotationId));
      }
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
      referentSub?.unsubscribe(); // in-flight referent load dies with the effect
    };
  }, [content, allAnnotations, newAnnotationIds, hoverDelayMs, session, onReferenceHover]);

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

  // A content link inside the rendered output (react-markdown / HTML `<a href>`) must never navigate
  // on its own (embedded/Electron security): always preventDefault, then delegate to the host if it cares.
  const handleContentClick = useCallback((e: ReactMouseEvent) => {
    const anchor = (e.target as HTMLElement).closest('a[href]');
    if (!anchor) return;
    e.preventDefault();
    const href = anchor.getAttribute('href');
    if (href) onLinkClick?.({ href, event: e });
  }, [onLinkClick]);

  // Route to the media renderer for this render mode. `text`/`image`/`pdf` share
  // the shell (toolbar + annotation-overlay container); `none` (no preview, or an
  // unknown type) has its own metadata+download structure. Callers can override
  // any renderer via `renderers`.
  const mediaRenderers: BrowseMediaRenderers = { ...defaultBrowseRenderers, ...renderers };
  const Renderer = render === 'none' ? undefined : mediaRenderers[render];

  if (!Renderer) {
    return (
      <div ref={containerRef} className={`semiont-browse-view semiont-browse-view--unsupported${inlineMod}`} data-mime-type="unsupported">
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
    <div className={`semiont-browse-view${inlineMod}`} data-mime-type={render}>
      <AnnotateToolbar
        selectedMotivation={null}
        selectedClick={selectedClick}
        showSelectionGroup={false}
        showDeleteButton={false}
        annotateMode={annotateMode}
        annotators={ANNOTATORS}
        session={session}
        compact={inline}
      />
      <div ref={containerRef} className="semiont-browse-view__content" onClick={handleContentClick}>
        <Renderer content={content} mimeType={mimeType} resourceUri={resourceUri} annotations={allAnnotations} />
      </div>
    </div>
  );
});
