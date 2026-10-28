/**
 * Annotation overlay: decouples annotation highlighting from markdown rendering.
 *
 * Instead of weaving annotations into the markdown AST via remark/rehype plugins
 * (which forces O(ASTnodes × annotations) work on every render), this module:
 *
 * 1. Builds a source→rendered position map once after the markdown DOM paints
 * 2. Resolves W3C TextPositionSelector offsets to stretches of the rendered text
 * 3. Rebuilds each annotated text node ONCE, off-DOM, into segments wrapped by
 *    <span> elements carrying data-annotation-* attributes
 *
 * Two counts meet here. A selector's offsets count the source's Unicode code
 * points. The source string and the rendered DOM text are both indexed in
 * UTF-16 code units, where a character outside the Basic Multilingual Plane
 * is two: the map and every stretch of the rendered text are in those. An
 * offset is converted where it is looked up in the map, and nowhere else.
 *
 * Markdown renders once (cached by React.memo). Annotation changes only touch
 * the overlay spans — no markdown re-parse, no AST walk.
 *
 * The application step deliberately never uses live DOM Ranges. Resolving
 * every annotation to a Range up front and wrapping them one `surroundContents`
 * at a time fails on overlap: each wrap is a DOM mutation, and DOM mutations
 * re-target every OTHER still-live Range, so overlapping annotations — the
 * normal result of repeated annotation on the same passage — have their
 * ranges collapsed or inflated by earlier wraps, painting whole paragraphs and
 * fragmenting text nodes so hard that 36 annotations produce 2,554 wraps and
 * a 10-second main-thread freeze. Working in positions of the rendered text
 * against the pristine text-node index makes overlap geometry exact, and costs
 * one `replaceChild` per annotated text node.
 */

import { getTextPositionSelector, getTargetSelector, getExactText, getBodySource } from '@semiont/core';
import { ANNOTATORS } from './annotation-registry';

import type { Annotation, TextOffsets } from '@semiont/core';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OverlayAnnotation {
  id: string;
  exact: string;
  /** The offset into the source the annotation starts at, in code points. */
  offset: number;
  /** How many code points of the source it is. */
  length: number;
  type: string;
  source: string | null;
}

export interface TextNodeEntry {
  node: Text;
  start: number; // where the node starts in the rendered text, in UTF-16 code units
  end: number;
}

/** An annotation resolved to a stretch of the rendered text: `[start, end)`, in UTF-16 code units. */
export interface ResolvedAnnotationSpan {
  annotation: OverlayAnnotation;
  start: number;
  end: number;
}

// ─── Source → Rendered Position Map ──────────────────────────────────────────

/**
 * Build a map from positions in the markdown source string to positions in
 * the rendered text, both in UTF-16 code units.
 * Unit-by-unit alignment: walks source and rendered text in parallel,
 * matching code units and skipping markdown syntax in the source.
 *
 * Complexity: O(sourceLength) — runs once per content change.
 */
export function buildSourceToRenderedMap(
  markdownSource: string,
  container: HTMLElement
): Map<number, number> {
  // Extract all rendered text by walking DOM text nodes
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let renderedText = '';
  while (walker.nextNode()) {
    renderedText += walker.currentNode.textContent ?? '';
  }

  // Unit-by-unit alignment
  const map = new Map<number, number>();
  let renderedPos = 0;
  let sourcePos = 0;

  while (sourcePos < markdownSource.length && renderedPos < renderedText.length) {
    if (markdownSource[sourcePos] === renderedText[renderedPos]) {
      map.set(sourcePos, renderedPos);
      renderedPos++;
      sourcePos++;
    } else {
      // Markdown syntax character — skip in source, no rendered counterpart
      sourcePos++;
    }
  }

  // Map remaining source positions to end of rendered text
  while (sourcePos < markdownSource.length) {
    map.set(sourcePos, renderedPos);
    sourcePos++;
  }

  return map;
}

// ─── Text Node Index ─────────────────────────────────────────────────────────

/**
 * Build a sorted array of text nodes, each with where it starts and ends in
 * the rendered text.
 *
 * Complexity: O(textNodes) — runs once per overlay application.
 */
export function buildTextNodeIndex(container: HTMLElement): TextNodeEntry[] {
  const entries: TextNodeEntry[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let position = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const length = node.textContent?.length ?? 0;
    entries.push({ node, start: position, end: position + length });
    position += length;
  }

  return entries;
}

// ─── Resolve Annotations to Stretches of the Rendered Text ───────────────────

/**
 * Resolve annotations to stretches of the rendered text. `offsets` is the
 * source's own conversions (`textOffsets(source)`) and `sourceToRendered` the
 * map `buildSourceToRenderedMap` made of the same source.
 *
 * An annotation's two offsets are taken to positions in the source string,
 * and its first and last code units are looked up in the map. Annotations
 * that are not at offsets of the source (content changed under them) or whose
 * ends don't map are skipped, as are empty ones.
 *
 * Complexity: O(annotations).
 */
export function resolveAnnotationSpans(
  annotations: OverlayAnnotation[],
  offsets: TextOffsets,
  sourceToRendered: Map<number, number>
): ResolvedAnnotationSpan[] {
  const spans: ResolvedAnnotationSpan[] = [];

  for (const annotation of annotations) {
    if (annotation.length <= 0) continue;
    const startOffset = annotation.offset;
    const endOffset = annotation.offset + annotation.length;
    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || startOffset < 0 || endOffset > offsets.length) continue;
    const start = sourceToRendered.get(offsets.indexAt(startOffset));
    const last = sourceToRendered.get(offsets.indexAt(endOffset) - 1);
    if (start === undefined || last === undefined || last < start) continue;
    spans.push({ annotation, start, end: last + 1 });
  }

  return spans;
}

// ─── Apply / Clear Highlights ────────────────────────────────────────────────

/**
 * Wrap annotated stretches of text with styled <span> elements.
 *
 * Each text node the spans touch is rebuilt off-DOM as a run of segments —
 * one per distinct overlap region — and swapped in with a single
 * `replaceChild`. A segment covered by several annotations gets nested spans,
 * one per annotation; the later annotation in the input order ends up
 * innermost, so `closest('[data-annotation-id]')` resolves to it (interactive
 * types — references, comments, tags — are listed after plain highlights).
 * An annotation cut by segment or node boundaries yields sibling spans
 * sharing its data-annotation-id.
 *
 * Complexity: O(textNodes × spans) comparisons, O(annotated nodes) mutations.
 */
export function applyHighlights(
  spans: ResolvedAnnotationSpan[],
  textNodeIndex: TextNodeEntry[]
): void {
  if (spans.length === 0) return;

  for (const entry of textNodeIndex) {
    const covering = spans.filter((s) => s.start < entry.end && s.end > entry.start);
    if (covering.length === 0) continue;

    // Segment boundaries inside this node: node edges plus every covering
    // annotation edge, clamped to the node.
    const cuts = new Set<number>([entry.start, entry.end]);
    for (const s of covering) {
      cuts.add(Math.max(s.start, entry.start));
      cuts.add(Math.min(s.end, entry.end));
    }
    const bounds = [...cuts].sort((a, b) => a - b);

    const text = entry.node.textContent ?? '';
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < bounds.length - 1; i++) {
      const segStart = bounds[i]!;
      const segEnd = bounds[i + 1]!;
      let segment: Node = document.createTextNode(text.slice(segStart - entry.start, segEnd - entry.start));

      // Wrap back-to-front so the last-listed covering annotation is innermost.
      for (let k = covering.length - 1; k >= 0; k--) {
        const s = covering[k]!;
        if (s.start > segStart || s.end < segEnd) continue;
        const span = document.createElement('span');
        span.className = `annotation-${s.annotation.type}`;
        span.dataset.annotationId = s.annotation.id;
        span.dataset.annotationType = s.annotation.type;
        span.appendChild(segment);
        segment = span;
      }

      fragment.appendChild(segment);
    }

    entry.node.parentNode?.replaceChild(fragment, entry.node);
  }
}

/**
 * Remove all annotation highlight spans, restoring the original DOM.
 * Unwraps every span, then merges adjacent text nodes in one pass.
 */
export function clearHighlights(container: HTMLElement): void {
  const spans = container.querySelectorAll('[data-annotation-id]');
  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) {
      parent.insertBefore(span.firstChild, span);
    }
    parent.removeChild(span);
  }
  container.normalize(); // merge adjacent text nodes across the whole subtree
}

// ─── Convert W3C Annotations to Overlay Format ──────────────────────────────

/**
 * Convert W3C Annotations to the simplified overlay format.
 * Extracts TextPositionSelector offsets, in code points as the selector has
 * them, and annotation type.
 */
export function toOverlayAnnotations(annotations: Annotation[]): OverlayAnnotation[] {
  return annotations
    .map(ann => {
      const targetSelector = getTargetSelector(ann.target);
      const posSelector = getTextPositionSelector(targetSelector);
      const start = posSelector?.start ?? 0;
      const end = posSelector?.end ?? 0;

      const type = Object.values(ANNOTATORS).find(a => a.matchesAnnotation(ann))?.internalType || 'highlight';

      return {
        id: ann.id,
        exact: getExactText(targetSelector),
        offset: start,
        length: end - start,
        type,
        source: getBodySource(ann.body)
      };
    });
}
