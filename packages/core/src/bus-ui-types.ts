// Hand-written companion to the GENERATED bus-protocol.ts.
//
// Runtime-only types that ride UI channels and cannot live in the bus
// registry: they are TypeScript shapes (DOM geometry, callbacks), not wire
// vocabulary, so no OpenAPI schema describes them and no other language
// needs them. bus-protocol.ts imports and re-exports these, so consumers
// keep importing from @semiont/core exactly as before.

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
