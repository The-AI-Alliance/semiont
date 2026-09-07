/**
 * Viewport-space rectangle of a clicked annotation element — runtime-only
 * view geometry riding UI events (never wire vocabulary; deliberately not in
 * the OpenAPI schemas). Structurally satisfied by a DOM `DOMRect`, spelled
 * out here because this package compiles without the DOM lib.
 */
export interface AnchorRect {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
}
