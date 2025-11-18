'use client';

import React from 'react';
import type { components } from '@semiont/api-client';
import { getSvgSelector, isHighlight, isReference, isAssessment, isComment } from '@semiont/api-client';
import { parseSvgSelector } from '@/lib/svg-utils';

type Annotation = components['schemas']['Annotation'];

interface AnnotationOverlayProps {
  annotations: Annotation[];
  imageWidth: number;
  imageHeight: number;
  displayWidth: number;
  displayHeight: number;
  onAnnotationClick?: (annotation: Annotation) => void;
  onAnnotationHover?: (annotationId: string | null) => void;
  hoveredAnnotationId?: string | null;
  selectedAnnotationId?: string | null;
}

/**
 * Get color for annotation based on type/motivation
 * Returns object with stroke color and fill color (with alpha)
 */
function getAnnotationColor(annotation: Annotation): { stroke: string; fill: string } {
  if (isHighlight(annotation)) {
    return { stroke: 'rgb(250, 204, 21)', fill: 'rgba(250, 204, 21, 0.2)' }; // yellow
  } else if (isReference(annotation)) {
    return { stroke: 'rgb(59, 130, 246)', fill: 'rgba(59, 130, 246, 0.2)' }; // blue
  } else if (isAssessment(annotation)) {
    return { stroke: 'rgb(239, 68, 68)', fill: 'rgba(239, 68, 68, 0.2)' }; // red
  } else if (isComment(annotation)) {
    return { stroke: 'rgb(255, 255, 255)', fill: 'rgba(255, 255, 255, 0.2)' }; // white
  }
  return { stroke: 'rgb(156, 163, 175)', fill: 'rgba(156, 163, 175, 0.2)' }; // gray default
}

/**
 * Render annotation overlay - displays existing annotations as SVG shapes
 */
export function AnnotationOverlay({
  annotations,
  imageWidth,
  imageHeight,
  displayWidth,
  displayHeight,
  onAnnotationClick,
  onAnnotationHover,
  hoveredAnnotationId,
  selectedAnnotationId
}: AnnotationOverlayProps) {
  const scaleX = displayWidth / imageWidth;
  const scaleY = displayHeight / imageHeight;

  return (
    <svg
      className="absolute top-0 left-0 w-full h-full"
      style={{ width: displayWidth, height: displayHeight }}
    >
      {annotations.map(annotation => {
        // Handle both string and object targets
        if (typeof annotation.target === 'string') return null;

        const svgSelector = getSvgSelector(annotation.target.selector);
        if (!svgSelector) return null;

        const parsed = parseSvgSelector(svgSelector.value);
        if (!parsed) return null;

        const isHovered = annotation.id === hoveredAnnotationId;
        const isSelected = annotation.id === selectedAnnotationId;
        const colors = getAnnotationColor(annotation);

        // Render based on shape type
        switch (parsed.type) {
          case 'rect': {
            const { x, y, width, height } = parsed.data;
            return (
              <rect
                key={annotation.id}
                x={x * scaleX}
                y={y * scaleY}
                width={width * scaleX}
                height={height * scaleY}
                fill={isHovered || isSelected ? colors.fill : 'transparent'}
                stroke={colors.stroke}
                strokeWidth={isHovered || isSelected ? 3 : 2}
                opacity={isHovered || isSelected ? 1 : 0.7}
                className="pointer-events-auto cursor-pointer transition-all"
                onClick={() => onAnnotationClick?.(annotation)}
                onMouseEnter={() => onAnnotationHover?.(annotation.id)}
                onMouseLeave={() => onAnnotationHover?.(null)}
              />
            );
          }

          case 'circle': {
            const { cx, cy, r } = parsed.data;
            return (
              <circle
                key={annotation.id}
                cx={cx * scaleX}
                cy={cy * scaleY}
                r={r * Math.min(scaleX, scaleY)}
                fill={isHovered || isSelected ? colors.fill : 'transparent'}
                stroke={colors.stroke}
                strokeWidth={isHovered || isSelected ? 3 : 2}
                opacity={isHovered || isSelected ? 1 : 0.7}
                className="pointer-events-auto cursor-pointer transition-all"
                onClick={() => onAnnotationClick?.(annotation)}
                onMouseEnter={() => onAnnotationHover?.(annotation.id)}
                onMouseLeave={() => onAnnotationHover?.(null)}
              />
            );
          }

          case 'polygon': {
            const points = parsed.data.points
              .map((p: { x: number; y: number }) => `${p.x * scaleX},${p.y * scaleY}`)
              .join(' ');

            return (
              <polygon
                key={annotation.id}
                points={points}
                fill={isHovered || isSelected ? colors.fill : 'transparent'}
                stroke={colors.stroke}
                strokeWidth={isHovered || isSelected ? 3 : 2}
                opacity={isHovered || isSelected ? 1 : 0.7}
                className="pointer-events-auto cursor-pointer transition-all"
                onClick={() => onAnnotationClick?.(annotation)}
                onMouseEnter={() => onAnnotationHover?.(annotation.id)}
                onMouseLeave={() => onAnnotationHover?.(null)}
              />
            );
          }

          default:
            return null;
        }
      })}
    </svg>
  );
}
