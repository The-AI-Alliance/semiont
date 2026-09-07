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
export declare function createRectangleSvg(start: Point, end: Point): string;
/**
 * Create W3C-compliant SVG polygon selector
 */
export declare function createPolygonSvg(points: Point[]): string;
/**
 * Create W3C-compliant SVG circle selector
 */
export declare function createCircleSvg(center: Point, radius: number): string;
/**
 * Parse SVG selector to extract shape type and data
 */
export declare function parseSvgSelector(svg: string): {
    type: 'rect' | 'polygon' | 'circle' | 'path';
    data: any;
} | null;
/**
 * Normalize coordinates from display space to image native resolution
 */
export declare function normalizeCoordinates(point: Point, displayWidth: number, displayHeight: number, imageWidth: number, imageHeight: number): Point;
/**
 * Scale entire SVG selector from display space to image native resolution
 */
export declare function scaleSvgToNative(svg: string, displayWidth: number, displayHeight: number, imageWidth: number, imageHeight: number): string;
