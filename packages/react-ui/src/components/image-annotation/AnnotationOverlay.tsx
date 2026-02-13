'use client';

import { useRef } from 'react';
import type { components } from '@semiont/api-client';
import { getSvgSelector, isHighlight, isReference, isAssessment, isComment, isTag, isBodyResolved, isResolvedReference } from '@semiont/api-client';
import { parseSvgSelector } from '@semiont/api-client';
import type { EventBus } from '../../contexts/EventBusContext';

type Annotation = components['schemas']['Annotation'];

interface AnnotationOverlayProps {
  annotations: Annotation[];
  imageWidth: number;
  imageHeight: number;
  displayWidth: number;
  displayHeight: number;
  eventBus?: EventBus;
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
  } else if (isTag(annotation)) {
    return { stroke: 'rgb(234, 88, 12)', fill: 'rgba(234, 88, 12, 0.2)' }; // orange (orange-600)
  }
  return { stroke: 'rgb(156, 163, 175)', fill: 'rgba(156, 163, 175, 0.2)' }; // gray default
}

/**
 * Get tooltip text for annotation based on type/motivation
 */
function getAnnotationTooltip(annotation: Annotation): string {
  if (isComment(annotation)) {
    return 'Comment';
  } else if (isHighlight(annotation)) {
    return 'Highlight';
  } else if (isAssessment(annotation)) {
    return 'Assessment';
  } else if (isTag(annotation)) {
    return 'Tag';
  } else if (isResolvedReference(annotation)) {
    return 'Resolved Reference';
  } else if (isReference(annotation)) {
    return 'Unresolved Reference';
  }
  return 'Annotation';
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
  eventBus,
  hoveredAnnotationId,
  selectedAnnotationId
}: AnnotationOverlayProps) {
  const scaleX = displayWidth / imageWidth;
  const scaleY = displayHeight / imageHeight;

  // Track current hover state to prevent redundant emissions
  const currentHover = useRef<string | null>(null);

  const handleMouseEnter = (annotationId: string) => {
    if (currentHover.current !== annotationId) {
      currentHover.current = annotationId;
      eventBus?.emit('annotation:hover', { annotationId });
    }
  };

  const handleMouseLeave = () => {
    if (currentHover.current !== null) {
      currentHover.current = null;
      eventBus?.emit('annotation:hover', { annotationId: null });
    }
  };

  return (
    <svg
      className="semiont-annotation-overlay"
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

        // Check if this is a reference and get its resolution status
        const isRef = isReference(annotation);
        const isResolved = isRef && isBodyResolved(annotation.body);
        const statusEmoji = isRef ? (isResolved ? '🔗' : '❓') : null;

        // Render based on shape type
        switch (parsed.type) {
          case 'rect': {
            const { x, y, width, height } = parsed.data;
            const indicatorX = (x + width) * scaleX + 8;
            const indicatorY = (y + height) * scaleY + 4;

            return (
              <g key={annotation.id}>
                <title>{getAnnotationTooltip(annotation)}</title>
                <rect
                  x={x * scaleX}
                  y={y * scaleY}
                  width={width * scaleX}
                  height={height * scaleY}
                  fill={isHovered || isSelected ? colors.fill : 'transparent'}
                  stroke={colors.stroke}
                  strokeWidth={isHovered || isSelected ? 3 : 2}
                  opacity={isHovered || isSelected ? 1 : 0.7}
                  className="semiont-annotation-overlay__shape"
                  data-hovered={isHovered ? 'true' : 'false'}
                  data-selected={isSelected ? 'true' : 'false'}
                  onClick={() => eventBus?.emit('annotation:click', { annotationId: annotation.id })}
                  onMouseEnter={() => handleMouseEnter(annotation.id)}
                  onMouseLeave={handleMouseLeave}
                />
                {statusEmoji && (
                  <text
                    x={indicatorX}
                    y={indicatorY}
                    fontSize="16"
                    className="semiont-annotation-overlay__status-indicator"
                    style={{ userSelect: 'none' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      eventBus?.emit('annotation:click', { annotationId: annotation.id });
                    }}
                    onMouseEnter={() => handleMouseEnter(annotation.id)}
                    onMouseLeave={handleMouseLeave}
                  >
                    {statusEmoji}
                  </text>
                )}
              </g>
            );
          }

          case 'circle': {
            const { cx, cy, r } = parsed.data;
            const scaledR = r * Math.min(scaleX, scaleY);
            // Place on circumference at 45 degrees (bottom-right direction)
            const angle45 = Math.PI / 4; // 45 degrees in radians
            const indicatorX = cx * scaleX + scaledR * Math.cos(angle45) + 8;
            const indicatorY = cy * scaleY + scaledR * Math.sin(angle45) + 4;

            return (
              <g key={annotation.id}>
                <title>{getAnnotationTooltip(annotation)}</title>
                <circle
                  cx={cx * scaleX}
                  cy={cy * scaleY}
                  r={scaledR}
                  fill={isHovered || isSelected ? colors.fill : 'transparent'}
                  stroke={colors.stroke}
                  strokeWidth={isHovered || isSelected ? 3 : 2}
                  opacity={isHovered || isSelected ? 1 : 0.7}
                  className="semiont-annotation-overlay__shape"
                  data-hovered={isHovered ? 'true' : 'false'}
                  data-selected={isSelected ? 'true' : 'false'}
                  onClick={() => eventBus?.emit('annotation:click', { annotationId: annotation.id })}
                  onMouseEnter={() => handleMouseEnter(annotation.id)}
                  onMouseLeave={handleMouseLeave}
                />
                {statusEmoji && (
                  <text
                    x={indicatorX}
                    y={indicatorY}
                    fontSize="16"
                    className="semiont-annotation-overlay__status-indicator"
                    style={{ userSelect: 'none' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      eventBus?.emit('annotation:click', { annotationId: annotation.id });
                    }}
                    onMouseEnter={() => handleMouseEnter(annotation.id)}
                    onMouseLeave={handleMouseLeave}
                  >
                    {statusEmoji}
                  </text>
                )}
              </g>
            );
          }

          case 'polygon': {
            const points = parsed.data.points
              .map((p: { x: number; y: number }) => `${p.x * scaleX},${p.y * scaleY}`)
              .join(' ');

            // Find the lower-right edge by finding the two vertices with highest (x + y) values
            const scaledPoints = parsed.data.points.map((p: { x: number; y: number }) => ({
              x: p.x * scaleX,
              y: p.y * scaleY,
              sum: p.x * scaleX + p.y * scaleY
            }));

            // Sort by sum (x + y) descending to get bottom-right points first
            const sortedByBottomRight = [...scaledPoints].sort((a, b) => b.sum - a.sum);

            // Take the top 2 points (most bottom-right)
            const point1 = sortedByBottomRight[0];
            const point2 = sortedByBottomRight[1];

            // Place indicator at midpoint of these two points (center of bottom-right edge)
            const indicatorX = (point1.x + point2.x) / 2 + 8;
            const indicatorY = (point1.y + point2.y) / 2 + 4;

            return (
              <g key={annotation.id}>
                <title>{getAnnotationTooltip(annotation)}</title>
                <polygon
                  points={points}
                  fill={isHovered || isSelected ? colors.fill : 'transparent'}
                  stroke={colors.stroke}
                  strokeWidth={isHovered || isSelected ? 3 : 2}
                  opacity={isHovered || isSelected ? 1 : 0.7}
                  className="semiont-annotation-overlay__shape"
                  data-hovered={isHovered ? 'true' : 'false'}
                  data-selected={isSelected ? 'true' : 'false'}
                  onClick={() => eventBus?.emit('annotation:click', { annotationId: annotation.id })}
                  onMouseEnter={() => handleMouseEnter(annotation.id)}
                  onMouseLeave={handleMouseLeave}
                />
                {statusEmoji && (
                  <text
                    x={indicatorX}
                    y={indicatorY}
                    fontSize="16"
                    className="semiont-annotation-overlay__status-indicator"
                    style={{ userSelect: 'none' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      eventBus?.emit('annotation:click', { annotationId: annotation.id });
                    }}
                    onMouseEnter={() => handleMouseEnter(annotation.id)}
                    onMouseLeave={handleMouseLeave}
                  >
                    {statusEmoji}
                  </text>
                )}
              </g>
            );
          }

          default:
            return null;
        }
      })}
    </svg>
  );
}
