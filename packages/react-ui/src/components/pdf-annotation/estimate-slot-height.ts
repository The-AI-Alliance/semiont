/**
 * The height a page will occupy once rendered, computed BEFORE rendering it.
 *
 * The scrolling column reserves space for pages it has not mounted. If the
 * reserved height differs from the height the page actually takes, every mount
 * and unmount changes the column's total height and the scrollbar jumps under
 * the reader's cursor — the defect S1 shipped by reserving the *raster* height
 * (`getViewport({ scale }).height`) instead of the *displayed* one.
 *
 * This models the CSS the image is under exactly:
 *
 *   .semiont-pdf-annotation-canvas__image { max-width: 100%; height: auto; }
 *
 * `max-width` shrinks but never upscales, so the displayed width is
 * `min(columnWidth, rasterWidth)` and the height follows the page's aspect
 * ratio. Aspect is scale-invariant, so it can come from any viewport.
 *
 * @param columnWidth  Measured inner width of the scroll column, in CSS px.
 * @param rasterWidth  Width of the rendered raster, in px (`viewport(scale).width`).
 * @param aspect       Page height ÷ width, from any viewport scale.
 * @returns Reserved height in CSS px, or null when a measurement is not in yet.
 */
export function estimateSlotHeight(
  columnWidth: number | null,
  rasterWidth: number | null,
  aspect: number | null,
): number | null {
  if (!columnWidth || !rasterWidth || !aspect) return null;
  if (columnWidth <= 0 || rasterWidth <= 0 || aspect <= 0) return null;
  return Math.round(Math.min(columnWidth, rasterWidth) * aspect);
}
