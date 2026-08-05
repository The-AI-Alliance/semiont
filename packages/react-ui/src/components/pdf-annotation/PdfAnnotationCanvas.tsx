'use client';

import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import type { Annotation, AnchorRect, AnchoredText } from '@semiont/core';
import { resourceId as toResourceId } from '@semiont/core';
import { toViewportAnchorRect } from '../../lib/anchor-rect';
import { createFragmentSelector, anchorRuns, isTextRun, textUnder } from '@semiont/core';
import { rectsForPage } from './rects-for-page';
import { createHoverHandlers, type SemiontSession } from '@semiont/sdk';
import type { SelectionMotivation } from '../annotation/AnnotateToolbar';
import {
  canvasToPdfCoordinates,
  pdfToCanvasCoordinates,
  type CanvasRectangle
} from '../../lib/pdf-coordinates';
import {
  loadPdfDocument,
  renderPdfPageToDataUrl,
  type PDFDocumentProxy
} from '../../lib/browser-pdfjs';
import './PdfAnnotationCanvas.css';

export type DrawingMode = 'rectangle' | 'circle' | 'polygon' | null;

/**
 * How the document's pages are laid out.
 *
 * `paged` is one page with Previous/Next. `scroll` is a virtualized column:
 * every page gets a slot so the scrollbar tells the truth about the
 * document's length, but only the pages near the viewport are mounted.
 *
 * Declared explicitly rather than inferred from `drawingMode`, which does NOT
 * distinguish the modes — AnnotateView passes `drawingMode={null}` whenever no
 * motivation is selected, so keying layout on it would flip a reader between
 * scrolling and paged views as they picked up and put down a tool.
 * See .plans/PDF-CONTINUOUS-SCROLL.md D3.
 */
export type PageLayout = 'paged' | 'scroll';

/** How far outside the viewport a page starts loading, and stays loaded. */
const PRELOAD_MARGIN = '100% 0px';

/**
 * Get color for annotation based on motivation
 */
function getMotivationColor(motivation: SelectionMotivation | null): { stroke: string; fill: string } {
  if (!motivation) {
    return { stroke: 'rgb(156, 163, 175)', fill: 'rgba(156, 163, 175, 0.2)' };
  }

  switch (motivation) {
    case 'highlighting':
      return { stroke: 'rgb(250, 204, 21)', fill: 'rgba(250, 204, 21, 0.3)' };
    case 'linking':
      return { stroke: 'rgb(59, 130, 246)', fill: 'rgba(59, 130, 246, 0.2)' };
    case 'assessing':
      return { stroke: 'rgb(239, 68, 68)', fill: 'rgba(239, 68, 68, 0.2)' };
    case 'commenting':
      return { stroke: 'rgb(255, 255, 255)', fill: 'rgba(255, 255, 255, 0.2)' };
    default:
      return { stroke: 'rgb(156, 163, 175)', fill: 'rgba(156, 163, 175, 0.2)' };
  }
}

interface PdfPageViewProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  /** Raster scale. Display-only: the overlay's geometry never reads it. */
  scale: number;
  resourceUri: string;
  existingAnnotations: Annotation[];
  drawingMode: DrawingMode;
  selectedMotivation?: SelectionMotivation | null;
  session?: SemiontSession | null | undefined;
  hoveredAnnotationId?: string | null;
  selectedAnnotationId?: string | null;
  hoverDelayMs: number;
  /** The document-wide server map, fetched once per resource by the parent. */
  fetchResourceAnchored: () => Promise<AnchoredText | null>;
}

/**
 * One rendered page: its raster, its text map, its annotation overlay, and
 * the drag that draws on it.
 *
 * Everything a page needs lives HERE rather than in the parent, which is what
 * makes a scrolling column possible: mounting a page loads it, and unmounting
 * releases it. The raster is a data-URL string, so the last reference going
 * away IS the memory release — no eviction bookkeeping, no object-URL revoke.
 * The drag lives here too because it needs this page's display dimensions and
 * this page's text; a drag can no more span pages than a rectangle can.
 */
function PdfPageView({
  doc,
  pageNumber,
  scale,
  resourceUri,
  existingAnnotations,
  drawingMode,
  selectedMotivation,
  session,
  hoveredAnnotationId,
  selectedAnnotationId,
  hoverDelayMs,
  fetchResourceAnchored,
}: PdfPageViewProps) {
  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const [pageDimensions, setPageDimensions] = useState<{ width: number; height: number } | null>(null);
  /**
   * This page's text and per-run geometry, read once when the page loads so a
   * drag can be quoted without a round trip. Null while loading; `items` is
   * empty on a scanned page, which has no text layer for the browser to read.
   */
  const [pageAnchored, setPageAnchored] = useState<AnchoredText | null>(null);
  const [displayDimensions, setDisplayDimensions] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const [selection, setSelection] = useState<CanvasRectangle | null>(null);

  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let cancelled = false;

    /**
     * The map a rectangle on this page quotes from, or null when there is
     * none to be had.
     *
     * Never rejects, which is what lets the render run alongside it: quoting
     * is the optional half of loading a page, so a failure here degrades to
     * geometry-only rather than reaching the caller's error path. It is also
     * the only reason `Promise.all` below is safe — a rejection from either
     * side would leave the other promise dangling, and only the render can
     * reject.
     */
    async function resolveAnchored(page: Awaited<ReturnType<typeof doc.getPage>>): Promise<AnchoredText | null> {
      try {
        // The page's text layer, read once here rather than at drag time —
        // `handleMouseUp` stays synchronous, and a native page costs nothing
        // extra since pdf.js already parsed it to draw the page.
        const runs = (await page.getTextContent()).items.filter(isTextRun);
        if (runs.length > 0) return anchorRuns(runs, pageNumber);

        // No runs means a scanned page: the characters exist only as pixels
        // and pdf.js has nothing to give. The server derived a map at ingest,
        // so ask for it rather than leaving the annotation anonymous.
        // Whole-resource — served once per document by the parent's cache —
        // and `textUnder` filters by page: the same shape the native branch
        // produces, so nothing downstream branches.
        //
        // `null` is the ordinary answer for a document that has no map and
        // never will; a failure is equally non-fatal. Either way the
        // annotation ships with geometry only, which is what shipped before
        // this existed. The served record is the full extraction outcome
        // (PERSIST-ANCHORS D1); a stored decline means extraction ran and
        // found nothing to anchor — for this canvas the same degradation as
        // no map at all.
        return await fetchResourceAnchored();
      } catch {
        return null;
      }
    }

    async function loadPage() {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;

        // Get page dimensions (at scale 1.0)
        const viewport = page.getViewport({ scale: 1.0 });
        setPageDimensions({ width: viewport.width, height: viewport.height });

        // Anchoring and rendering are independent, and only one of them the
        // reader is waiting on. Sequencing them put a network round-trip in
        // front of the pixels on exactly the documents that need it most: a
        // scanned page fetches its map from the server, and rendering behind
        // that await is how "failing to quote it must not fail to show it"
        // became true of errors but not of latency. Started together, the
        // page appears on its own schedule.
        const [anchored, { dataUrl }] = await Promise.all([
          resolveAnchored(page),
          renderPdfPageToDataUrl(page, scale),
        ]);

        if (cancelled) return;

        setPageAnchored(anchored);
        setPageImageUrl(dataUrl);
      } catch (err) {
        if (cancelled) return;

        console.error('Error loading page:', err);
        setError('Failed to load page');
      }
    }

    loadPage();

    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, scale, fetchResourceAnchored]);

  // Update display dimensions on resize
  useEffect(() => {
    const updateDisplayDimensions = () => {
      if (imageRef.current) {
        setDisplayDimensions({
          width: imageRef.current.clientWidth,
          height: imageRef.current.clientHeight
        });
      }
    };

    updateDisplayDimensions();

    // Use ResizeObserver to detect image element size changes
    // This catches: sidebar open/close, window resize, font size changes, etc.
    let resizeObserver: ResizeObserver | null = null;

    try {
      resizeObserver = new ResizeObserver(updateDisplayDimensions);
      if (imageRef.current) {
        resizeObserver.observe(imageRef.current);
      }
    } catch (error) {
      // Fallback for browsers without ResizeObserver support
      console.warn('ResizeObserver not supported, falling back to window resize listener');
      window.addEventListener('resize', updateDisplayDimensions);
    }

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      } else {
        window.removeEventListener('resize', updateDisplayDimensions);
      }
    };
  }, [pageImageUrl]);

  // Mouse event handlers for drawing
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!drawingMode) return;
    if (!imageRef.current) return;

    const rect = imageRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Clear any previous selection when starting new drawing
    setIsDrawing(true);
    setSelection({
      startX: x,
      startY: y,
      endX: x,
      endY: y
    });
  }, [drawingMode]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDrawing || !selection || !imageRef.current) return;

    const rect = imageRef.current.getBoundingClientRect();

    setSelection({
      ...selection,
      endX: e.clientX - rect.left,
      endY: e.clientY - rect.top
    });
  }, [isDrawing, selection]);

  const handleMouseUp = useCallback(() => {
    if (!isDrawing || !selection || !pageDimensions || !displayDimensions || !session) {
      setIsDrawing(false);
      setSelection(null);
      return;
    }

    // Calculate drag distance
    const dragDistance = Math.sqrt(
      Math.pow(selection.endX - selection.startX, 2) +
      Math.pow(selection.endY - selection.startY, 2)
    );

    // Minimum drag threshold in pixels (10px)
    const MIN_DRAG_DISTANCE = 10;

    if (dragDistance < MIN_DRAG_DISTANCE) {
      // This was a click, not a drag - check if we clicked an existing annotation
      if (existingAnnotations.length > 0) {
        // The hit-test owns the coordinate transform — capture the hit
        // annotation's viewport rect for the emission below (A1 anchor).
        let hitRect: AnchorRect | undefined;
        const hit = rectsForPage(existingAnnotations, pageNumber).find(r => {
          const rect = pdfToCanvasCoordinates(r.coord, pageDimensions.height, 1.0);

          // Scale to display coordinates
          const scaleX = displayDimensions.width / pageDimensions.width;
          const scaleY = displayDimensions.height / pageDimensions.height;

          const displayX = rect.x * scaleX;
          const displayY = rect.y * scaleY;
          const displayWidth = rect.width * scaleX;
          const displayHeight = rect.height * scaleY;

          const inside = (
            selection.endX >= displayX &&
            selection.endX <= displayX + displayWidth &&
            selection.endY >= displayY &&
            selection.endY <= displayY + displayHeight
          );
          if (inside && imageRef.current) {
            hitRect = toViewportAnchorRect(imageRef.current.getBoundingClientRect(), displayX, displayY, displayWidth, displayHeight);
          }
          return inside;
        });

        if (hit) {
          session?.client.browse.click(hit.annId, hit.annotation.motivation, hitRect);
          setIsDrawing(false);
          setSelection(null);
          return;
        }
      }

      // Click on empty space - do nothing
      setIsDrawing(false);
      setSelection(null);
      return;
    }

    // This was a drag - create new annotation
    // Scale selection from display coordinates to native page coordinates
    const scaleX = pageDimensions.width / displayDimensions.width;
    const scaleY = pageDimensions.height / displayDimensions.height;

    const nativeSelection: CanvasRectangle = {
      startX: selection.startX * scaleX,
      startY: selection.startY * scaleY,
      endX: selection.endX * scaleX,
      endY: selection.endY * scaleY
    };

    // Convert canvas coordinates to PDF coordinates
    const pdfCoord = canvasToPdfCoordinates(
      nativeSelection,
      pageNumber,
      pageDimensions.width,
      pageDimensions.height,
      1.0 // Use scale 1.0 since we already scaled to native coords
    );

    // Create FragmentSelector
    const fragmentSelector = createFragmentSelector(pdfCoord);

    // What the box was drawn around. Without it the annotation is a rectangle
    // with no memory of its own content: the panel entry is blank, search over
    // annotation text misses it, and an export has nothing to print. Empty on a
    // scanned page or over an image — emit no quote at all rather than an empty
    // one, which would assert the box was drawn around nothing.
    const quoted = pageAnchored ? textUnder(pageAnchored, pdfCoord) : '';

    // Emit annotation:requested event with FragmentSelector
    if (selectedMotivation) {
      session.client.mark.request(
        toResourceId(resourceUri),
        [
          {
            type: 'FragmentSelector',
            conformsTo: 'http://tools.ietf.org/rfc/rfc3778',
            value: fragmentSelector,
          },
          ...(quoted ? [{ type: 'TextQuoteSelector' as const, exact: quoted }] : []),
        ],
        selectedMotivation,
      );
    }

    // Keep drawing state active to show preview until annotation is persisted
    // The parent component should clear this by changing drawingMode after save
    setIsDrawing(false);
    // Note: We keep selection so the preview remains visible
    // It will be cleared when drawingMode changes or user starts new selection
  }, [isDrawing, selection, pageNumber, pageDimensions, displayDimensions, selectedMotivation, existingAnnotations, session, resourceUri, pageAnchored]);

  // Every FragmentSelector rect on this page — one per line for a multi-line
  // (multi-selector) annotation, exactly one for a manual annotation.
  const pageRects = rectsForPage(existingAnnotations, pageNumber);

  // Hover handlers with currentHover guard and dwell delay
  const { handleMouseEnter, handleMouseLeave } = useMemo(
    () => createHoverHandlers((id) => session?.client.beckon.hover(id), hoverDelayMs),
    [session, hoverDelayMs]
  );

  // Calculate motivation color
  const { stroke, fill } = getMotivationColor(selectedMotivation ?? null);

  if (error) {
    return <div className="semiont-pdf-annotation-canvas__error">{error}</div>;
  }

  return (
    <div
      className="semiont-pdf-annotation-canvas__container"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => {
        if (isDrawing) {
          setIsDrawing(false);
          setSelection(null);
        }
      }}
      data-drawing-mode={drawingMode || 'none'}
    >
      {/* PDF page rendered as image */}
      {pageImageUrl && (
        <img
          ref={imageRef}
          src={pageImageUrl}
          alt={`PDF page ${pageNumber}`}
          className="semiont-pdf-annotation-canvas__image"
          draggable={false}
          style={{ pointerEvents: 'none' }}
          onLoad={() => {
            // Use double RAF to ensure layout is complete even in onLoad
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (imageRef.current) {
                  setDisplayDimensions({
                    width: imageRef.current.clientWidth,
                    height: imageRef.current.clientHeight
                  });
                }
              });
            });
          }}
        />
      )}

      {/* SVG overlay for annotations */}
      {displayDimensions && pageDimensions && (
        <div className="semiont-pdf-annotation-canvas__overlay-container">
          <div className="semiont-pdf-annotation-canvas__overlay">
            <svg
              className="semiont-pdf-annotation-canvas__svg"
              width={displayDimensions.width}
              height={displayDimensions.height}
            >
              {/* Render existing annotations for this page */}
              {pageRects.map(r => {
                const rect = pdfToCanvasCoordinates(r.coord, pageDimensions.height, 1.0);

                // Scale to display coordinates
                const scaleX = displayDimensions.width / pageDimensions.width;
                const scaleY = displayDimensions.height / pageDimensions.height;

                const isHovered = r.annId === hoveredAnnotationId;
                const isSelected = r.annId === selectedAnnotationId;

                // Colour by the annotation's own motivation (not the toolbar's).
                const annMotivation = r.annotation.motivation as SelectionMotivation | null;
                const { stroke: annStroke, fill: annFill } = getMotivationColor(annMotivation);

                return (
                  <rect
                    key={`${r.annId}:${r.selectorIndex}`}
                    x={rect.x * scaleX}
                    y={rect.y * scaleY}
                    width={rect.width * scaleX}
                    height={rect.height * scaleY}
                    stroke={annStroke}
                    strokeWidth={isSelected ? 4 : isHovered ? 3 : 2}
                    fill={annFill}
                    style={{
                      pointerEvents: 'auto',
                      cursor: 'pointer',
                      opacity: isSelected ? 1 : isHovered ? 0.9 : 0.7
                    }}
                    onClick={(e) => session?.client.browse.click(r.annId, r.annotation.motivation, e.currentTarget.getBoundingClientRect())}
                    onMouseEnter={() => handleMouseEnter(r.annId)}
                    onMouseLeave={handleMouseLeave}
                  />
                );
              })}

              {/* Render current selection while drawing or awaiting save */}
              {selection && (() => {
                const rectX = Math.min(selection.startX, selection.endX);
                const rectY = Math.min(selection.startY, selection.endY);
                const rectWidth = Math.abs(selection.endX - selection.startX);
                const rectHeight = Math.abs(selection.endY - selection.startY);

                // PDF only supports rectangle shapes (FragmentSelector with viewrect)
                // Circle/polygon are disabled in the UI for PDF media types
                return (
                  <rect
                    x={rectX}
                    y={rectY}
                    width={rectWidth}
                    height={rectHeight}
                    stroke={stroke}
                    strokeWidth={2}
                    strokeDasharray="5,5"
                    fill={fill}
                    pointerEvents="none"
                  />
                );
              })()}
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}

interface PdfAnnotationCanvasProps {
  pdfUrl: string;
  /** The '@id' of the annotated resource — stamped as `source` on mark:requested (multi-viewer routing). */
  resourceUri: string;
  existingAnnotations?: Annotation[];
  drawingMode: DrawingMode;
  selectedMotivation?: SelectionMotivation | null;
  session?: SemiontSession | null | undefined;
  hoveredAnnotationId?: string | null;
  selectedAnnotationId?: string | null;
  hoverDelayMs?: number;
  /** `paged` (default) or the virtualized `scroll` column. See `PageLayout`. */
  pageLayout?: PageLayout;
}

/**
 * PDF annotation canvas with page navigation and rectangle drawing
 *
 * @emits browse:click - Annotation clicked on PDF. Payload: { annotationId: string, motivation: Motivation }
 * @emits mark:requested - New annotation drawn on PDF. Payload: { selector: [FragmentSelector, TextQuoteSelector?], motivation: SelectionMotivation } — the quote is the text under the rectangle, omitted when the page has no text layer
 * @emits beckon:hover - Annotation hovered or unhovered. Payload: { annotationId: string | null }
 */
export function PdfAnnotationCanvas({
  pdfUrl,
  resourceUri,
  existingAnnotations = [],
  drawingMode,
  selectedMotivation,
  session,
  hoveredAnnotationId,
  selectedAnnotationId,
  hoverDelayMs = 150,
  pageLayout = 'paged'
}: PdfAnnotationCanvasProps) {
  // PDF state
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Page 1's rendered height, used to size the slots of pages that have not
   * been mounted yet. Uniform documents (the overwhelming case, and every
   * scan) get exactness for one `getPage`; a mixed-size document gets scroll
   * drift in its unmeasured tail, which self-corrects as pages mount.
   * See .plans/PDF-CONTINUOUS-SCROLL.md D4.
   */
  const [estimatedPageHeight, setEstimatedPageHeight] = useState<number | null>(null);
  const [scale] = useState(1.5); // Fixed scale for better quality

  /** Pages currently intersecting the viewport (plus the preload margin). */
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  const slotRefs = useRef(new Map<number, HTMLElement>());
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Load PDF document on mount
  useEffect(() => {
    let cancelled = false;

    async function loadPdf() {
      try {
        setIsLoading(true);
        setError(null);

        const doc = await loadPdfDocument(pdfUrl);

        if (cancelled) return;

        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setIsLoading(false);

        // One extra getPage, for slot sizing (D4). Failure is not fatal:
        // unsized slots still scroll, just less faithfully.
        try {
          const first = await doc.getPage(1);
          if (cancelled) return;
          setEstimatedPageHeight(first.getViewport({ scale }).height);
        } catch {
          /* leave unsized */
        }
      } catch (err) {
        if (cancelled) return;

        console.error('Error loading PDF:', err);
        setError('Failed to load PDF');
        setIsLoading(false);
      }
    }

    loadPdf();

    return () => {
      cancelled = true;
    };
  }, [pdfUrl, scale]);

  /**
   * The server-derived map, fetched once per document rather than once per
   * page (PERSIST-ANCHORS P4). The map is WHOLE-RESOURCE — one artifact
   * covering every page — so re-reading it per page meant a full refetch and
   * re-decode on every page turn; on a 400-page scan that is one decode per
   * interaction instead of one per document. Living on the parent is also
   * what lets a scrolling column mount many pages against a single fetch.
   *
   * The cache holds the in-flight promise so concurrent page loads share one
   * fetch. Answers cache — including "no map" and a stored decline, which are
   * definitive — but a transport failure clears the entry, so the next page
   * load retries instead of pinning the whole document to geometry-only.
   */
  const resourceAnchoredRef = useRef<{ uri: string; outcome: Promise<AnchoredText | null> } | null>(null);
  const fetchResourceAnchored = useCallback((): Promise<AnchoredText | null> => {
    if (!session) return Promise.resolve(null); // no session yet — don't cache its absence
    const cached = resourceAnchoredRef.current;
    if (cached && cached.uri === resourceUri) return cached.outcome;

    const uri = resourceUri;
    const outcome = session.client.browse.resourceAnchoredText(toResourceId(uri)).then(
      (served) => (served && !('declined' in served) ? served : null),
      () => {
        if (resourceAnchoredRef.current?.uri === uri) resourceAnchoredRef.current = null;
        return null;
      },
    );
    resourceAnchoredRef.current = { uri, outcome };
    return outcome;
  }, [session, resourceUri]);

  // The mount window. Slots report their own visibility; a page is mounted
  // while its slot intersects (widened by PRELOAD_MARGIN so the next page is
  // ready before it is reached), and unmounting is what frees its raster.
  useEffect(() => {
    if (pageLayout !== 'scroll' || numPages === 0) return;

    let observer: IntersectionObserver | null = null;
    try {
      observer = new IntersectionObserver(
        (entries) => {
          setVisiblePages((prev) => {
            const next = new Set(prev);
            for (const entry of entries) {
              const page = Number((entry.target as HTMLElement).dataset.page);
              if (!page) continue;
              if (entry.isIntersecting) next.add(page);
              else next.delete(page);
            }
            return next;
          });
        },
        { rootMargin: PRELOAD_MARGIN },
      );
    } catch {
      // No IntersectionObserver: mount every page rather than none. Correct,
      // simply not virtualized — the same posture as the ResizeObserver
      // fallback in PdfPageView.
      setVisiblePages(new Set(Array.from({ length: numPages }, (_, i) => i + 1)));
      return;
    }

    observerRef.current = observer;
    for (const el of slotRefs.current.values()) observer.observe(el);

    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [pageLayout, numPages]);

  const registerSlot = useCallback((page: number) => (el: HTMLDivElement | null) => {
    const previous = slotRefs.current.get(page);
    if (previous) observerRef.current?.unobserve(previous);
    if (el) {
      slotRefs.current.set(page, el);
      observerRef.current?.observe(el);
    } else {
      slotRefs.current.delete(page);
    }
  }, []);

  const scrollToPage = useCallback((page: number) => {
    slotRefs.current.get(page)?.scrollIntoView({ block: 'start' });
  }, []);

  // In the column the reader decides which page they are on by scrolling, so
  // the indicator reports rather than controls: the topmost visible page.
  const currentPage = pageLayout === 'scroll'
    ? (visiblePages.size > 0 ? Math.min(...visiblePages) : 1)
    : pageNumber;

  const pageProps = {
    scale,
    resourceUri,
    existingAnnotations,
    drawingMode,
    selectedMotivation,
    session,
    hoveredAnnotationId,
    selectedAnnotationId,
    hoverDelayMs,
    fetchResourceAnchored,
  };

  if (error) {
    return <div className="semiont-pdf-annotation-canvas__error">{error}</div>;
  }

  return (
    <div className="semiont-pdf-annotation-canvas">
      {isLoading && <div className="semiont-pdf-annotation-canvas__loading">Loading PDF...</div>}

      {pdfDoc && pageLayout === 'scroll' ? (
        <div className="semiont-pdf-annotation-canvas__column">
          {Array.from({ length: numPages }, (_, i) => i + 1).map((page) => (
            <div
              key={page}
              ref={registerSlot(page)}
              data-page={page}
              className="semiont-pdf-annotation-canvas__slot"
              style={visiblePages.has(page) || !estimatedPageHeight ? undefined : { height: estimatedPageHeight }}
            >
              {visiblePages.has(page) && (
                <PdfPageView doc={pdfDoc} pageNumber={page} {...pageProps} />
              )}
            </div>
          ))}
        </div>
      ) : (
        pdfDoc && !isLoading && (
          <PdfPageView doc={pdfDoc} pageNumber={pageNumber} {...pageProps} />
        )
      )}

      {/* Page navigation controls */}
      {numPages > 0 && (
        <div className="semiont-pdf-annotation-canvas__controls">
          <button
            disabled={currentPage <= 1}
            onClick={() => (pageLayout === 'scroll' ? scrollToPage(currentPage - 1) : setPageNumber(pageNumber - 1))}
            className="semiont-pdf-annotation-canvas__button"
          >
            Previous
          </button>
          <span className="semiont-pdf-annotation-canvas__page-info">
            Page {currentPage} of {numPages}
          </span>
          <button
            disabled={currentPage >= numPages}
            onClick={() => (pageLayout === 'scroll' ? scrollToPage(currentPage + 1) : setPageNumber(pageNumber + 1))}
            className="semiont-pdf-annotation-canvas__button"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
