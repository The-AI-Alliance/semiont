'use client';

import React, { useRef, useState, useEffect, useCallback } from 'react';
import type { components, ResourceUri } from '@semiont/api-client';
import { createRectangleSvg, createCircleSvg, createPolygonSvg, scaleSvgToNative, parseSvgSelector, type Point } from '@/lib/svg-utils';
import { AnnotationOverlay } from './AnnotationOverlay';
import type { SelectionMotivation } from '@/components/annotation/AnnotateToolbar';

type Annotation = components['schemas']['Annotation'];

export type DrawingMode = 'rectangle' | 'polygon' | 'circle' | 'freeform' | null;

/**
 * Get color for annotation preview based on motivation
 * Returns object with stroke color and fill color (with alpha)
 */
function getMotivationColor(motivation: SelectionMotivation | null): { stroke: string; fill: string } {
  if (!motivation) {
    return { stroke: 'rgb(156, 163, 175)', fill: 'rgba(156, 163, 175, 0.2)' }; // gray default
  }

  switch (motivation) {
    case 'highlighting':
      return { stroke: 'rgb(250, 204, 21)', fill: 'rgba(250, 204, 21, 0.2)' }; // yellow
    case 'linking':
      return { stroke: 'rgb(59, 130, 246)', fill: 'rgba(59, 130, 246, 0.2)' }; // blue
    case 'assessing':
      return { stroke: 'rgb(239, 68, 68)', fill: 'rgba(239, 68, 68, 0.2)' }; // red
    case 'commenting':
      return { stroke: 'rgb(255, 255, 255)', fill: 'rgba(255, 255, 255, 0.2)' }; // white
    default:
      return { stroke: 'rgb(156, 163, 175)', fill: 'rgba(156, 163, 175, 0.2)' }; // gray default
  }
}

interface SvgDrawingCanvasProps {
  resourceUri: ResourceUri;
  existingAnnotations?: Annotation[];
  drawingMode: DrawingMode;
  selectedMotivation?: SelectionMotivation | null;
  onAnnotationCreate?: (svg: string, position?: { x: number; y: number }) => void;
  onAnnotationClick?: (annotation: Annotation) => void;
  onAnnotationHover?: (annotationId: string | null) => void;
  hoveredAnnotationId?: string | null;
  selectedAnnotationId?: string | null;
}

export function SvgDrawingCanvas({
  resourceUri,
  existingAnnotations = [],
  drawingMode,
  selectedMotivation,
  onAnnotationCreate,
  onAnnotationClick,
  onAnnotationHover,
  hoveredAnnotationId,
  selectedAnnotationId
}: SvgDrawingCanvasProps) {
  // Extract resource ID from W3C canonical URI (last segment of path)
  const resourceId = resourceUri.split('/').pop();

  // Use Next.js API route proxy instead of direct backend call
  // This allows us to add authentication headers which <img> tags can't send
  const imageUrl = `/api/resources/${resourceId}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [displayDimensions, setDisplayDimensions] = useState<{ width: number; height: number } | null>(null);

  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [currentPoint, setCurrentPoint] = useState<Point | null>(null);

  // Load image dimensions
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      setImageDimensions({
        width: img.naturalWidth,
        height: img.naturalHeight
      });
    };
    img.src = imageUrl;
  }, [imageUrl]);

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
    window.addEventListener('resize', updateDisplayDimensions);
    return () => window.removeEventListener('resize', updateDisplayDimensions);
  }, [imageDimensions]);

  // Convert mouse event to SVG coordinates relative to image
  const getRelativeCoordinates = useCallback((e: React.MouseEvent<HTMLDivElement>): Point | null => {
    if (!imageRef.current) return null;

    const rect = imageRef.current.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }, []);

  // Handle mouse down - start drawing
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!drawingMode) return;

    const point = getRelativeCoordinates(e);
    if (point) {
      setIsDrawing(true);
      setStartPoint(point);
      setCurrentPoint(point);
    }
  }, [drawingMode, getRelativeCoordinates]);

  // Handle mouse move - update current point
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawing || !startPoint) return;

    const point = getRelativeCoordinates(e);
    if (point) {
      setCurrentPoint(point);
    }
  }, [isDrawing, startPoint, getRelativeCoordinates]);

  // Handle mouse up - distinguish between click and drag
  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawing || !startPoint || !drawingMode) return;

    const endPoint = getRelativeCoordinates(e);
    if (!endPoint || !displayDimensions || !imageDimensions) return;

    // Calculate drag distance
    const dragDistance = Math.sqrt(
      Math.pow(endPoint.x - startPoint.x, 2) +
      Math.pow(endPoint.y - startPoint.y, 2)
    );

    // Minimum drag threshold in pixels (10px)
    const MIN_DRAG_DISTANCE = 10;

    if (dragDistance < MIN_DRAG_DISTANCE) {
      // This was a click, not a drag - check if we clicked an existing annotation
      if (onAnnotationClick && existingAnnotations.length > 0) {
        // Find annotation at click point
        // Note: We're checking in display coordinates
        const clickedAnnotation = existingAnnotations.find(ann => {
          if (typeof ann.target === 'string') return false;

          const svgSelector = ann.target.selector;
          if (!svgSelector) return false;

          // Handle selector array
          const selectors = Array.isArray(svgSelector) ? svgSelector : [svgSelector];
          const svgSel = selectors.find(s => s.type === 'SvgSelector');
          if (!svgSel || svgSel.type !== 'SvgSelector') return false;

          const parsed = parseSvgSelector(svgSel.value);
          if (!parsed) return false;

          // Scale annotation bounds to display coordinates
          const scaleX = displayDimensions.width / imageDimensions.width;
          const scaleY = displayDimensions.height / imageDimensions.height;

          if (parsed.type === 'rect') {
            const { x, y, width, height } = parsed.data;
            const displayX = x * scaleX;
            const displayY = y * scaleY;
            const displayWidth = width * scaleX;
            const displayHeight = height * scaleY;

            return (
              endPoint.x >= displayX &&
              endPoint.x <= displayX + displayWidth &&
              endPoint.y >= displayY &&
              endPoint.y <= displayY + displayHeight
            );
          }

          return false;
        });

        if (clickedAnnotation) {
          onAnnotationClick(clickedAnnotation);
          setIsDrawing(false);
          setStartPoint(null);
          setCurrentPoint(null);
          return;
        }
      }

      // Click on empty space - do nothing
      setIsDrawing(false);
      setStartPoint(null);
      setCurrentPoint(null);
      return;
    }

    // This was a drag - create new annotation based on drawing mode
    let displaySvg: string;

    switch (drawingMode) {
      case 'circle': {
        // Calculate radius from start to end point
        const radius = Math.sqrt(
          Math.pow(endPoint.x - startPoint.x, 2) +
          Math.pow(endPoint.y - startPoint.y, 2)
        );
        displaySvg = createCircleSvg(startPoint, radius);
        break;
      }

      case 'polygon': {
        // Create a 4-point polygon (diamond shape) using the bounding box
        const centerX = (startPoint.x + endPoint.x) / 2;
        const centerY = (startPoint.y + endPoint.y) / 2;
        const halfWidth = Math.abs(endPoint.x - startPoint.x) / 2;
        const halfHeight = Math.abs(endPoint.y - startPoint.y) / 2;

        const points = [
          { x: centerX, y: centerY - halfHeight },        // top
          { x: centerX + halfWidth, y: centerY },         // right
          { x: centerX, y: centerY + halfHeight },        // bottom
          { x: centerX - halfWidth, y: centerY }          // left
        ];
        displaySvg = createPolygonSvg(points);
        break;
      }

      case 'rectangle':
      default:
        displaySvg = createRectangleSvg(startPoint, endPoint);
        break;
    }

    // Scale to native image resolution
    const nativeSvg = scaleSvgToNative(
      displaySvg,
      displayDimensions.width,
      displayDimensions.height,
      imageDimensions.width,
      imageDimensions.height
    );

    // Calculate center position for popup placement (in screen coordinates)
    const centerX = (startPoint.x + endPoint.x) / 2;
    const centerY = (startPoint.y + endPoint.y) / 2;
    const rect = imageRef.current?.getBoundingClientRect();
    const screenPosition = rect ? {
      x: rect.left + centerX,
      y: rect.top + centerY
    } : undefined;

    // Notify parent
    if (onAnnotationCreate) {
      onAnnotationCreate(nativeSvg, screenPosition);
    }

    // Reset drawing state
    setIsDrawing(false);
    setStartPoint(null);
    setCurrentPoint(null);
  }, [isDrawing, startPoint, drawingMode, displayDimensions, imageDimensions, getRelativeCoordinates, onAnnotationCreate, onAnnotationClick, existingAnnotations]);

  // Cancel drawing on mouse leave
  const handleMouseLeave = useCallback(() => {
    if (isDrawing) {
      setIsDrawing(false);
      setStartPoint(null);
      setCurrentPoint(null);
    }
  }, [isDrawing]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full flex items-center justify-center bg-gray-100 dark:bg-gray-800"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      style={{ cursor: drawingMode ? 'crosshair' : 'default' }}
    >
      {/* Image */}
      <img
        ref={imageRef}
        src={imageUrl}
        alt="Annotatable content"
        className="max-w-full max-h-full object-contain"
        draggable={false}
      />

      {/* Overlay for annotations and drawing */}
      {displayDimensions && imageDimensions && (
        <div
          className="absolute top-0 left-0 w-full h-full flex items-center justify-center pointer-events-none"
        >
          <div
            className="relative"
            style={{
              width: displayDimensions.width,
              height: displayDimensions.height
            }}
          >
            {/* Existing annotations */}
            <AnnotationOverlay
              annotations={existingAnnotations}
              imageWidth={imageDimensions.width}
              imageHeight={imageDimensions.height}
              displayWidth={displayDimensions.width}
              displayHeight={displayDimensions.height}
              {...(onAnnotationClick && { onAnnotationClick })}
              {...(onAnnotationHover && { onAnnotationHover })}
              {...(hoveredAnnotationId !== undefined && { hoveredAnnotationId })}
              {...(selectedAnnotationId !== undefined && { selectedAnnotationId })}
            />

            {/* Current drawing preview */}
            {isDrawing && startPoint && currentPoint && (() => {
              const colors = getMotivationColor(selectedMotivation || null);
              return (
                <svg
                  className="absolute top-0 left-0 w-full h-full pointer-events-none"
                  style={{ width: displayDimensions.width, height: displayDimensions.height }}
                >
                  {drawingMode === 'circle' && (() => {
                    const radius = Math.sqrt(
                      Math.pow(currentPoint.x - startPoint.x, 2) +
                      Math.pow(currentPoint.y - startPoint.y, 2)
                    );
                    return (
                      <circle
                        cx={startPoint.x}
                        cy={startPoint.y}
                        r={radius}
                        fill={colors.fill}
                        stroke={colors.stroke}
                        strokeWidth="2"
                        strokeDasharray="5,5"
                      />
                    );
                  })()}

                  {drawingMode === 'polygon' && (() => {
                    const centerX = (startPoint.x + currentPoint.x) / 2;
                    const centerY = (startPoint.y + currentPoint.y) / 2;
                    const halfWidth = Math.abs(currentPoint.x - startPoint.x) / 2;
                    const halfHeight = Math.abs(currentPoint.y - startPoint.y) / 2;

                    const points = [
                      { x: centerX, y: centerY - halfHeight },        // top
                      { x: centerX + halfWidth, y: centerY },         // right
                      { x: centerX, y: centerY + halfHeight },        // bottom
                      { x: centerX - halfWidth, y: centerY }          // left
                    ];

                    const pointsStr = points.map(p => `${p.x},${p.y}`).join(' ');

                    return (
                      <polygon
                        points={pointsStr}
                        fill={colors.fill}
                        stroke={colors.stroke}
                        strokeWidth="2"
                        strokeDasharray="5,5"
                      />
                    );
                  })()}

                  {drawingMode === 'rectangle' && (
                    <rect
                      x={Math.min(startPoint.x, currentPoint.x)}
                      y={Math.min(startPoint.y, currentPoint.y)}
                      width={Math.abs(currentPoint.x - startPoint.x)}
                      height={Math.abs(currentPoint.y - startPoint.y)}
                      fill={colors.fill}
                      stroke={colors.stroke}
                      strokeWidth="2"
                      strokeDasharray="5,5"
                    />
                  )}
                </svg>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
