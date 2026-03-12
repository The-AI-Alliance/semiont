import { describe, test, expect } from 'vitest';
import {
  createRectangleSvg,
  createPolygonSvg,
  createCircleSvg,
  parseSvgSelector,
  normalizeCoordinates,
  scaleSvgToNative,
} from '../../utils/svg-utils';

describe('createRectangleSvg', () => {
  test('creates SVG rect from two points', () => {
    const svg = createRectangleSvg({ x: 10, y: 20 }, { x: 50, y: 80 });
    expect(svg).toContain('<rect');
    expect(svg).toContain('x="10"');
    expect(svg).toContain('y="20"');
    expect(svg).toContain('width="40"');
    expect(svg).toContain('height="60"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  test('normalizes when start > end', () => {
    const svg = createRectangleSvg({ x: 50, y: 80 }, { x: 10, y: 20 });
    expect(svg).toContain('x="10"');
    expect(svg).toContain('y="20"');
  });
});

describe('createPolygonSvg', () => {
  test('creates SVG polygon from points', () => {
    const svg = createPolygonSvg([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }]);
    expect(svg).toContain('<polygon');
    expect(svg).toContain('points="0,0 100,0 50,100"');
  });

  test('throws for fewer than 3 points', () => {
    expect(() => createPolygonSvg([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toThrow('at least 3 points');
  });
});

describe('createCircleSvg', () => {
  test('creates SVG circle', () => {
    const svg = createCircleSvg({ x: 50, y: 50 }, 25);
    expect(svg).toContain('<circle');
    expect(svg).toContain('cx="50"');
    expect(svg).toContain('cy="50"');
    expect(svg).toContain('r="25"');
  });

  test('throws for non-positive radius', () => {
    expect(() => createCircleSvg({ x: 0, y: 0 }, 0)).toThrow('radius must be positive');
    expect(() => createCircleSvg({ x: 0, y: 0 }, -5)).toThrow('radius must be positive');
  });
});

describe('parseSvgSelector', () => {
  test('parses rect', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="30" height="40"/></svg>';
    const result = parseSvgSelector(svg);
    expect(result).toEqual({ type: 'rect', data: { x: 10, y: 20, width: 30, height: 40 } });
  });

  test('parses polygon', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><polygon points="0,0 100,0 50,100"/></svg>';
    const result = parseSvgSelector(svg);
    expect(result?.type).toBe('polygon');
    expect(result?.data.points).toHaveLength(3);
    expect(result?.data.points[0]).toEqual({ x: 0, y: 0 });
  });

  test('parses circle', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="25"/></svg>';
    const result = parseSvgSelector(svg);
    expect(result).toEqual({ type: 'circle', data: { cx: 50, cy: 50, r: 25 } });
  });

  test('returns null for unknown shape', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Hello</text></svg>';
    expect(parseSvgSelector(svg)).toBeNull();
  });
});

describe('normalizeCoordinates', () => {
  test('scales point from display to image space', () => {
    const result = normalizeCoordinates({ x: 50, y: 50 }, 100, 100, 200, 200);
    expect(result).toEqual({ x: 100, y: 100 });
  });

  test('handles non-uniform scaling', () => {
    const result = normalizeCoordinates({ x: 50, y: 25 }, 100, 50, 400, 200);
    expect(result).toEqual({ x: 200, y: 100 });
  });
});

describe('scaleSvgToNative', () => {
  test('scales rect SVG', () => {
    const svg = createRectangleSvg({ x: 10, y: 20 }, { x: 50, y: 60 });
    const scaled = scaleSvgToNative(svg, 100, 100, 200, 200);
    const parsed = parseSvgSelector(scaled);
    expect(parsed?.type).toBe('rect');
    expect(parsed?.data.x).toBe(20);
    expect(parsed?.data.y).toBe(40);
    expect(parsed?.data.width).toBe(80);
    expect(parsed?.data.height).toBe(80);
  });

  test('scales circle SVG', () => {
    const svg = createCircleSvg({ x: 50, y: 50 }, 10);
    const scaled = scaleSvgToNative(svg, 100, 100, 200, 200);
    const parsed = parseSvgSelector(scaled);
    expect(parsed?.type).toBe('circle');
    expect(parsed?.data.cx).toBe(100);
    expect(parsed?.data.cy).toBe(100);
    expect(parsed?.data.r).toBe(20);
  });

  test('scales polygon SVG', () => {
    const svg = createPolygonSvg([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }]);
    const scaled = scaleSvgToNative(svg, 100, 100, 200, 200);
    const parsed = parseSvgSelector(scaled);
    expect(parsed?.type).toBe('polygon');
    expect(parsed?.data.points[1]).toEqual({ x: 200, y: 0 });
  });

  test('returns original for unparseable SVG', () => {
    expect(scaleSvgToNative('<invalid>', 100, 100, 200, 200)).toBe('<invalid>');
  });
});
