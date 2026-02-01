'use client';

import React, { useRef, useState, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import type { components, ResourceUri } from '@semiont/api-client';
import { getTargetSelector } from '@semiont/api-client';
import type { SelectionMotivation } from '../annotation/AnnotateToolbar';
import {
  canvasToPdfCoordinates,
  pdfToCanvasCoordinates,
  createFragmentSelector,
  parseFragmentSelector,
  getPageFromFragment,
  type CanvasRectangle
} from '../../lib/pdf-coordinates';
import './PdfAnnotationCanvas.css';

type Annotation = components['schemas']['Annotation'];

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.js`;

export type DrawingMode = 'rectangle' | null;

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
  onAnnotationCreate?: (fragmentSelector: string) => void;
  onAnnotationClick?: (annotation: Annotation) => void;
  onAnnotationHover?: (annotationId: string | null) => void;
  hoveredAnnotationId?: string | null;
}

export function PdfAnnotationCanvas({
  resourceUri,
  existingAnnotations = [],
  drawingMode,
  selectedMotivation,
  onAnnotationCreate,
  onAnnotationClick,
  onAnnotationHover,
  hoveredAnnotationId
}: PdfAnnotationCanvasProps) {
  const resourceId = resourceUri.split('/').pop();
  const pdfUrl = `/api/resources/${resourceId}`;

  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageDimensions, setPageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [scale, setScale] = useState(1.0);

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [selection, setSelection] = useState<CanvasRectangle | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Load PDF
  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
    setIsLoading(false);
  }

  function onDocumentLoadError(err: Error) {
    console.error('Error loading PDF:', err);
    setError('Failed to load PDF');
    setIsLoading(false);
  }

  // Track page dimensions when rendered
  const onPageLoadSuccess = useCallback((page: any) => {
    const viewport = page.getViewport({ scale: 1.0 });
    setPageDimensions({
      width: viewport.width,
      height: viewport.height
    });
  }, []);

  // Mouse event handlers for drawing
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!drawingMode || drawingMode !== 'rectangle') return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setIsDrawing(true);
    setSelection({
      startX: x,
      startY: y,
      endX: x,
      endY: y
    });
  }, [drawingMode]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDrawing || !selection) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    setSelection({
      ...selection,
      endX: e.clientX - rect.left,
      endY: e.clientY - rect.top
    });
  }, [isDrawing, selection]);

  const handleMouseUp = useCallback(() => {
    if (!isDrawing || !selection || !pageDimensions || !onAnnotationCreate) {
      setIsDrawing(false);
      setSelection(null);
      return;
    }

    // Convert canvas coordinates to PDF coordinates
    const pdfCoord = canvasToPdfCoordinates(
      selection,
      pageNumber,
      pageDimensions.width,
      pageDimensions.height,
      scale
    );

    // Create FragmentSelector
    const fragmentSelector = createFragmentSelector(pdfCoord);
    onAnnotationCreate(fragmentSelector);

    // Reset drawing state
    setIsDrawing(false);
    setSelection(null);
  }, [isDrawing, selection, pageNumber, pageDimensions, scale, onAnnotationCreate]);

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
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          if (isDrawing) {
            setIsDrawing(false);
            setSelection(null);
          }
        }}
      >
        <Document
          file={pdfUrl}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={onDocumentLoadError}
          loading={<div>Loading PDF...</div>}
        >
          <Page
            pageNumber={pageNumber}
            renderTextLayer={true}
            renderAnnotationLayer={false}
            onLoadSuccess={onPageLoadSuccess}
            canvasRef={canvasRef}
            scale={scale}
          />
        </Document>

        {/* SVG overlay for annotations */}
        {pageDimensions && (
          <svg
            className="semiont-pdf-annotation-canvas__overlay"
            style={{
              width: pageDimensions.width * scale,
              height: pageDimensions.height * scale,
              position: 'absolute',
              top: 0,
              left: 0,
              pointerEvents: 'none'
            }}
          >
            {/* Render existing annotations for this page */}
            {pageAnnotations.map(ann => {
              const fragmentSel = getFragmentSelector(ann.target);
              if (!fragmentSel) return null;

              const pdfCoord = parseFragmentSelector(fragmentSel.value);
              if (!pdfCoord) return null;

              const rect = pdfToCanvasCoordinates(pdfCoord, pageDimensions.height, scale);
              const isHovered = ann.id === hoveredAnnotationId;

              return (
                <rect
                  key={ann.id}
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  stroke={stroke}
                  strokeWidth={isHovered ? 3 : 2}
                  fill={fill}
                  style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                  onClick={() => onAnnotationClick?.(ann)}
                  onMouseEnter={() => onAnnotationHover?.(ann.id)}
                  onMouseLeave={() => onAnnotationHover?.(null)}
                />
              );
            })}

            {/* Render current selection while drawing */}
            {selection && isDrawing && (
              <rect
                x={Math.min(selection.startX, selection.endX)}
                y={Math.min(selection.startY, selection.endY)}
                width={Math.abs(selection.endX - selection.startX)}
                height={Math.abs(selection.endY - selection.startY)}
                stroke={stroke}
                strokeWidth={2}
                fill={fill}
                pointerEvents="none"
              />
            )}
          </svg>
        )}
      </div>

      {/* Page navigation controls */}
      <div className="semiont-pdf-annotation-canvas__controls">
        <button
          disabled={pageNumber <= 1}
          onClick={() => setPageNumber(pageNumber - 1)}
        >
          Previous
        </button>
        <span>
          Page {pageNumber} of {numPages}
        </span>
        <button
          disabled={pageNumber >= numPages}
          onClick={() => setPageNumber(pageNumber + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
