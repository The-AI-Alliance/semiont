import type { Annotation, PdfCoordinate } from '@semiont/core';
import { getTargetSelector, parseFragmentSelector } from '@semiont/core';

/** One FragmentSelector rectangle to paint on a PDF page. */
export interface PageRect {
  /** Owning annotation id — shared by every rect of a multi-line annotation (hover/click routing). */
  annId: Annotation['id'];
  /** Index within the annotation's FragmentSelectors — the stable half of the React key. */
  selectorIndex: number;
  /** PDF-point geometry for this rect. */
  coord: PdfCoordinate;
  /** Owning annotation (motivation colour, etc.). */
  annotation: Annotation;
}

/** Every FragmentSelector on a target, in order (`target.selector` may be one or an array). */
function fragmentSelectors(target: Annotation['target']): { value: string }[] {
  const selector = getTargetSelector(target);
  if (!selector) return [];
  const selectors = Array.isArray(selector) ? selector : [selector];
  return selectors
    .filter(s => s.type === 'FragmentSelector')
    .map(s => s as { type: 'FragmentSelector'; value: string });
}

/**
 * The rectangles to paint on `pageNumber`: one entry per FragmentSelector whose
 * viewrect page matches. A multi-line (multi-selector) annotation therefore yields
 * one rect per line; a single-selector (manual) annotation yields exactly one.
 *
 * Pure — no React/DOM. `PdfAnnotationCanvas` maps this to `<rect>` keyed
 * `${annId}:${selectorIndex}`, and the rects-for-page axioms exercise it directly.
 * Geometry stays deferred: each `coord` still goes through `pdfToCanvasCoordinates`
 * at paint time (itself covered by the coordinate-transform axioms).
 */
export function rectsForPage(annotations: Annotation[], pageNumber: number): PageRect[] {
  const rects: PageRect[] = [];
  for (const annotation of annotations) {
    fragmentSelectors(annotation.target).forEach((sel, selectorIndex) => {
      const coord = parseFragmentSelector(sel.value);
      if (coord && coord.page === pageNumber) {
        rects.push({ annId: annotation.id, selectorIndex, coord, annotation });
      }
    });
  }
  return rects;
}
