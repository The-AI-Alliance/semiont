'use client';

import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { createHoverHandlers } from '../../hooks/useBeckonFlow';
import type { components, ResourceUri } from '@semiont/core';
import { getTargetSelector } from '@semiont/api-client';
import type { SelectionMotivation } from '../annotation/AnnotateToolbar';
import type { EventBus } from "@semiont/core"
import {
  canvasToPdfCoordinates,
  pdfToCanvasCoordinates,
  createFragmentSelector,
  parseFragmentSelector,
  getPageFromFragment,
  type CanvasRectangle
} from '../../lib/pdf-coordinates';
import {
  loadPdfDocument,
  renderPdfPageToDataUrl,
  type PDFDocumentProxy
} from '../../lib/browser-pdfjs';
import './PdfAnnotationCanvas.css';

type Annotation = components['schemas']['Annotation'];

export type DrawingMode = 'rectangle' | 'circle' | 'polygon' | null;

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

interface PdfAnnotationCanvasProps {
  resourceUri: ResourceUri;
  existingAnnotations?: Annotation[];
  drawingMode: DrawingMode;
  selectedMotivation?: SelectionMotivation | null;
  eventBus?: EventBus;
  hoveredAnnotationId?: string | null;
  selectedAnnotationId?: string | null;
  hoverDelayMs?: number;
}

/**
 * PDF annotation canvas with page navigation and rectangle drawing
 *
 * @emits browse:click - Annotation clicked on PDF. Payload: { annotationId: string, motivation: Motivation }
 * @emits mark:requested - New annotation drawn on PDF. Payload: { selector: FragmentSelector, motivation: SelectionMotivation }
 * @emits beckon:hover - Annotation hovered or unhovered. Payload: { annotationId: string | null }
 */
export function PdfAnnotationCanvas({
  resourceUri,
  existingAnnotations = [],
  drawingMode,
  selectedMotivation,
  eventBus,
  hoveredAnnotationId,
  selectedAnnotationId,
  hoverDelayMs = 150
}: PdfAnnotationCanvasProps) {
  const pdfUrl = useMemo(() => {
    const resourceId = resourceUri.split('/').pop();
    return `/api/resources/${resourceId}`;
  }, [resourceUri]);

  // Removed excessive logging

  // PDF state
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageDimensions, setPageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [displayDimensions, setDisplayDimensions] = useState<{ width: number; height: number } | null>(null);
  const [scale] = useState(1.5); // Fixed scale for better quality

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [selection, setSelection] = useState<CanvasRectangle | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

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
  }, [pdfUrl]);

  // Load current page when page number changes
  useEffect(() => {
    if (!pdfDoc) return;

    let cancelled = false;
    const doc = pdfDoc;

    async function loadPage() {
      try {
        const page = await doc.getPage(pageNumber);

        if (cancelled) return;

        // Get page dimensions (at scale 1.0)
        const viewport = page.getViewport({ scale: 1.0 });
        setPageDimensions({
          width: viewport.width,
          height: viewport.height
        });

        // Render page to image
        const { dataUrl } = await renderPdfPageToDataUrl(page, scale);

        if (cancelled) return;

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
  }, [pdfDoc, pageNumber, scale]);

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
    if (!isDrawing || !selection || !pageDimensions || !displayDimensions || !eventBus) {
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
        const clickedAnnotation = pageAnnotations.find(ann => {
          const fragmentSel = getFragmentSelector(ann.target);
          if (!fragmentSel) return false;

          const pdfCoord = parseFragmentSelector(fragmentSel.value);
          if (!pdfCoord) return false;

          const rect = pdfToCanvasCoordinates(pdfCoord, pageDimensions.height, 1.0);

          // Scale to display coordinates
          const scaleX = displayDimensions.width / pageDimensions.width;
          const scaleY = displayDimensions.height / pageDimensions.height;

          const displayX = rect.x * scaleX;
          const displayY = rect.y * scaleY;
          const displayWidth = rect.width * scaleX;
          const displayHeight = rect.height * scaleY;

          return (
            selection.endX >= displayX &&
            selection.endX <= displayX + displayWidth &&
            selection.endY >= displayY &&
            selection.endY <= displayY + displayHeight
          );
        });

        if (clickedAnnotation) {
          eventBus?.get('browse:click').next({ annotationId: clickedAnnotation.id, motivation: clickedAnnotation.motivation });
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

    // Emit annotation:requested event with FragmentSelector
    if (selectedMotivation) {
      eventBus.get('mark:requested').next({
        selector: {
          type: 'FragmentSelector',
          conformsTo: 'http://tools.ietf.org/rfc/rfc3778',
          value: fragmentSelector
        },
        motivation: selectedMotivation
      });
    }

    // Keep drawing state active to show preview until annotation is persisted
    // The parent component should clear this by changing drawingMode after save
    setIsDrawing(false);
    // Note: We keep selection so the preview remains visible
    // It will be cleared when drawingMode changes or user starts new selection
  }, [isDrawing, selection, pageNumber, pageDimensions, displayDimensions, selectedMotivation, existingAnnotations]);

  // Helper to get FragmentSelector from annotation target
  const getFragmentSelector = (target: Annotation['target']) => {
    const selector = getTargetSelector(target);
    if (!selector) return null;
    const selectors = Array.isArray(selector) ? selector : [selector];

    const found = selectors.find(s => s.type === 'FragmentSelector');
    if (!found || found.type !== 'FragmentSelector') return null;
    return found as { type: 'FragmentSelector'; value: string; conformsTo?: string };
  };

  // Filter annotations for current page
  const pageAnnotations = existingAnnotations.filter(ann => {
    const fragmentSel = getFragmentSelector(ann.target);
    if (!fragmentSel) return false;
    const page = getPageFromFragment(fragmentSel.value);
    return page === pageNumber;
  });

  // Hover handlers with currentHover guard and dwell delay
  const { handleMouseEnter, handleMouseLeave } = useMemo(
    () => createHoverHandlers((annotationId) => eventBus?.get('beckon:hover').next({ annotationId }), hoverDelayMs),
    [eventBus, hoverDelayMs]
  );

  // Calculate motivation color
  const { stroke, fill } = getMotivationColor(selectedMotivation ?? null);

  if (error) {
    return <div className="semiont-pdf-annotation-canvas__error">{error}</div>;
  }

  return (
    <div className="semiont-pdf-annotation-canvas">
      {isLoading && <div className="semiont-pdf-annotation-canvas__loading">Loading PDF...</div>}

      <div
        ref={containerRef}
        className="semiont-pdf-annotation-canvas__container"
        style={{ display: isLoading ? 'none' : undefined }}
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
                {pageAnnotations.map(ann => {
                  const fragmentSel = getFragmentSelector(ann.target);
                  if (!fragmentSel) return null;

                  const pdfCoord = parseFragmentSelector(fragmentSel.value);
                  if (!pdfCoord) return null;

                  const rect = pdfToCanvasCoordinates(pdfCoord, pageDimensions.height, 1.0);

                  // Scale to display coordinates
                  const scaleX = displayDimensions.width / pageDimensions.width;
                  const scaleY = displayDimensions.height / pageDimensions.height;

                  const isHovered = ann.id === hoveredAnnotationId;
                  const isSelected = ann.id === selectedAnnotationId;

                  // Get color for this annotation's motivation (not the selected motivation)
                  const annMotivation = ann.motivation as SelectionMotivation | null;
                  const { stroke: annStroke, fill: annFill } = getMotivationColor(annMotivation);

                  return (
                    <rect
                      key={ann.id}
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
                      onClick={() => eventBus?.get('browse:click').next({ annotationId: ann.id, motivation: ann.motivation })}
                      onMouseEnter={() => handleMouseEnter(ann.id)}
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

      {/* Page navigation controls */}
      {numPages > 0 && (
        <div className="semiont-pdf-annotation-canvas__controls">
          <button
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber(pageNumber - 1)}
            className="semiont-pdf-annotation-canvas__button"
          >
            Previous
          </button>
          <span className="semiont-pdf-annotation-canvas__page-info">
            Page {pageNumber} of {numPages}
          </span>
          <button
            disabled={pageNumber >= numPages}
            onClick={() => setPageNumber(pageNumber + 1)}
            className="semiont-pdf-annotation-canvas__button"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
