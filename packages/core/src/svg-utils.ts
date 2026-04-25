/**
 * SVG Utility Functions
 *
 * Utilities for creating, parsing, and manipulating W3C-compliant SVG selectors
 * for image annotation.
 */

export interface Point {
  x: number;
  y: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Create W3C-compliant SVG rectangle selector
 */
export function createRectangleSvg(start: Point, end: Point): string {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);

  return `<svg xmlns="http://www.w3.org/2000/svg"><rect x="${x}" y="${y}" width="${width}" height="${height}"/></svg>`;
}

/**
 * Create W3C-compliant SVG polygon selector
 */
export function createPolygonSvg(points: Point[]): string {
  if (points.length < 3) {
    throw new Error('Polygon requires at least 3 points');
  }

  const pointsStr = points.map(p => `${p.x},${p.y}`).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg"><polygon points="${pointsStr}"/></svg>`;
}

/**
 * Create W3C-compliant SVG circle selector
 */
export function createCircleSvg(center: Point, radius: number): string {
  if (radius <= 0) {
    throw new Error('Circle radius must be positive');
  }

  return `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="${center.x}" cy="${center.y}" r="${radius}"/></svg>`;
}

/**
 * Parse SVG selector to extract shape type and data
 */
export function parseSvgSelector(svg: string): {
  type: 'rect' | 'polygon' | 'circle' | 'path';
  data: any;
} | null {
  // Extract rectangle
  const rectMatch = svg.match(/<rect\s+([^>]+)\/>/);
  if (rectMatch && rectMatch[1]) {
    const attrs = rectMatch[1];
    const x = parseFloat(attrs.match(/x="([^"]+)"/)?.[1] || '0');
    const y = parseFloat(attrs.match(/y="([^"]+)"/)?.[1] || '0');
    const width = parseFloat(attrs.match(/width="([^"]+)"/)?.[1] || '0');
    const height = parseFloat(attrs.match(/height="([^"]+)"/)?.[1] || '0');

    return {
      type: 'rect',
      data: { x, y, width, height }
    };
  }

  // Extract polygon
  const polygonMatch = svg.match(/<polygon\s+points="([^"]+)"/);
  if (polygonMatch && polygonMatch[1]) {
    const pointsStr = polygonMatch[1];
    const points = pointsStr.split(/\s+/).map(pair => {
      const [x, y] = pair.split(',').map(parseFloat);
      return { x, y };
    });

    return {
      type: 'polygon',
      data: { points }
    };
  }

  // Extract circle
  const circleMatch = svg.match(/<circle\s+([^>]+)\/>/);
  if (circleMatch && circleMatch[1]) {
    const attrs = circleMatch[1];
    const cx = parseFloat(attrs.match(/cx="([^"]+)"/)?.[1] || '0');
    const cy = parseFloat(attrs.match(/cy="([^"]+)"/)?.[1] || '0');
    const r = parseFloat(attrs.match(/r="([^"]+)"/)?.[1] || '0');

    return {
      type: 'circle',
      data: { cx, cy, r }
    };
  }

  return null;
}

/**
 * Normalize coordinates from display space to image native resolution
 */
export function normalizeCoordinates(
  point: Point,
  displayWidth: number,
  displayHeight: number,
  imageWidth: number,
  imageHeight: number
): Point {
  return {
    x: (point.x / displayWidth) * imageWidth,
    y: (point.y / displayHeight) * imageHeight
  };
}

/**
 * Scale entire SVG selector from display space to image native resolution
 */
export function scaleSvgToNative(
  svg: string,
  displayWidth: number,
  displayHeight: number,
  imageWidth: number,
  imageHeight: number
): string {
  const parsed = parseSvgSelector(svg);
  if (!parsed) return svg;

  const scaleX = imageWidth / displayWidth;
  const scaleY = imageHeight / displayHeight;

  switch (parsed.type) {
    case 'rect': {
      const { x, y, width, height } = parsed.data;
      return createRectangleSvg(
        { x: x * scaleX, y: y * scaleY },
        { x: (x + width) * scaleX, y: (y + height) * scaleY }
      );
    }

    case 'circle': {
      const { cx, cy, r } = parsed.data;
      return createCircleSvg(
        { x: cx * scaleX, y: cy * scaleY },
        r * Math.min(scaleX, scaleY)
      );
    }

    case 'polygon': {
      const points = parsed.data.points.map((p: Point) => ({
        x: p.x * scaleX,
        y: p.y * scaleY
      }));
      return createPolygonSvg(points);
    }
  }

  return svg;
}
