'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, AnchorRect, AnchoredText } from '@semiont/core';
import {
  resourceId as toResourceId,
  createFragmentSelector,
  anchorRuns,
  isTextRun,
  textUnder,
} from '@semiont/core';
import { createHoverHandlers, type SemiontSession } from '@semiont/sdk';
import { toViewportAnchorRect } from '../../lib/anchor-rect';
import { rectsForPage } from './rects-for-page';
import { useTranslations } from '../../contexts/TranslationContext';
import type { SelectionMotivation } from '../annotation/AnnotateToolbar';
import {
  canvasToPdfCoordinates,
  pdfToCanvasCoordinates,
  type CanvasRectangle,
} from '../../lib/pdf-coordinates';
import { renderPdfPageToDataUrl, type PDFDocumentProxy } from '../../lib/browser-pdfjs';
// Type-only, so this leaves no runtime edge back to the parent module.
import type { DrawingMode } from './PdfAnnotationCanvas';

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
  /** Re-resolve trigger: a retry landed the map (P4). */
  anchoredEpoch: number;
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
export function PdfPageView({
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
  anchoredEpoch,
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
  /** Translation KEY, not text: `t` is a new closure each render, so keeping
   *  it out of the load effect's deps is what stops a reload loop. */
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const t = useTranslations('PdfViewer');

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
        // reader is waiting on. They start together, and the image is set the
        // moment the render resolves — a `Promise.all` here once put the
        // OPTIONAL half (the anchored map, a network fetch on exactly the
        // scanned documents that need it most) in front of the pixels, so a
        // slow or unanswered map request held a finished render off the
        // screen. The map lands whenever it lands; anchoring "never rejects"
        // covers its failures, and only the render can reach the catch below.
        const anchoredPromise = resolveAnchored(page);
        const { dataUrl } = await renderPdfPageToDataUrl(page, scale);
        if (cancelled) return;
        setPageImageUrl(dataUrl);

        const anchored = await anchoredPromise;
        if (cancelled) return;
        setPageAnchored(anchored);
      } catch (err) {
        if (cancelled) return;

        console.error('Error loading page:', err);
        setErrorKey('pageLoadFailed');
      }
    }

    loadPage();

    return () => {
      cancelled = true;
    };
    // `anchoredEpoch` is deliberately a dep: a retry that lands the map
    // re-resolves this page, so the first annotation after the flip carries
    // its quote (ANNOTATE-DEFERS-ON-NOT-YET P4).
  }, [doc, pageNumber, scale, fetchResourceAnchored, anchoredEpoch]);

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
          session?.client.browse.click(hit.annId, hitRect);
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

  if (errorKey) {
    return <div className="semiont-pdf-annotation-canvas__error">{t(errorKey)}</div>;
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
                    onClick={(e) => session?.client.browse.click(r.annId, e.currentTarget.getBoundingClientRect())}
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
