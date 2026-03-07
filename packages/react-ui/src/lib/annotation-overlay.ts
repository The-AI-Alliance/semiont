/**
 * Annotation overlay: decouples annotation highlighting from markdown rendering.
 *
 * Instead of weaving annotations into the markdown AST via remark/rehype plugins
 * (which forces O(ASTnodes × annotations) work on every render), this module:
 *
 * 1. Builds a source→rendered offset map once after the markdown DOM paints
 * 2. Resolves W3C TextPositionSelector offsets to DOM Ranges via binary search
 * 3. Wraps matched ranges with <span> elements carrying data-annotation-* attributes
 *
 * Markdown renders once (cached by React.memo). Annotation changes only touch
 * the overlay spans — no markdown re-parse, no AST walk.
 */

import type { components } from '@semiont/core';
import { getTextPositionSelector, getTargetSelector, getExactText, getBodySource } from '@semiont/api-client';
import { ANNOTATORS } from './annotation-registry';

type Annotation = components['schemas']['Annotation'];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OverlayAnnotation {
  id: string;
  exact: string;
  offset: number;
  length: number;
  type: string;
  source: string | null;
}

interface TextNodeEntry {
  node: Text;
  start: number; // cumulative rendered offset
  end: number;
}

// ─── Source → Rendered Offset Map ────────────────────────────────────────────

/**
 * Build a map from markdown source offsets to rendered text offsets.
 * Character-by-character alignment: walks source and rendered text in parallel,
 * matching characters and skipping markdown syntax in the source.
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

  // Character-by-character alignment
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
 * Build a sorted array of text nodes with cumulative rendered offsets
 * for efficient offset→node lookups via binary search.
 *
 * Complexity: O(textNodes) — runs once per overlay application.
 */
export function buildTextNodeIndex(container: HTMLElement): TextNodeEntry[] {
  const entries: TextNodeEntry[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const length = node.textContent?.length ?? 0;
    entries.push({ node, start: offset, end: offset + length });
    offset += length;
  }

  return entries;
}

/**
 * Binary search for the text node containing a rendered offset.
 *
 * Complexity: O(log(textNodes)) per lookup.
 */
function findTextNode(
  entries: TextNodeEntry[],
  renderedOffset: number
): { node: Text; localOffset: number } | null {
  let lo = 0;
  let hi = entries.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const entry = entries[mid]!;
    if (renderedOffset < entry.start) {
      hi = mid - 1;
    } else if (renderedOffset >= entry.end) {
      lo = mid + 1;
    } else {
      return { node: entry.node, localOffset: renderedOffset - entry.start };
    }
  }

  return null;
}

// ─── Resolve Annotations to DOM Ranges ───────────────────────────────────────

/**
 * Resolve annotations to DOM Ranges using the cached offset map.
 *
 * Complexity: O(annotations × log(textNodes)).
 */
export function resolveAnnotationRanges(
  annotations: OverlayAnnotation[],
  offsetMap: Map<number, number>,
  textNodeIndex: TextNodeEntry[]
): Map<string, { range: Range; annotation: OverlayAnnotation }> {
  const ranges = new Map<string, { range: Range; annotation: OverlayAnnotation }>();

  for (const ann of annotations) {
    const renderedStart = offsetMap.get(ann.offset);
    const renderedEnd = offsetMap.get(ann.offset + ann.length - 1);
    if (renderedStart === undefined || renderedEnd === undefined) continue;

    const startInfo = findTextNode(textNodeIndex, renderedStart);
    const endInfo = findTextNode(textNodeIndex, renderedEnd + 1);
    if (!startInfo || !endInfo) continue;

    const range = document.createRange();
    range.setStart(startInfo.node, startInfo.localOffset);
    range.setEnd(endInfo.node, endInfo.localOffset);
    ranges.set(ann.id, { range, annotation: ann });
  }

  return ranges;
}

// ─── Apply / Clear Highlights ────────────────────────────────────────────────

/**
 * Wrap annotation Ranges with styled <span> elements.
 * Handles cross-element ranges by splitting into per-text-node segments.
 */
export function applyHighlights(
  ranges: Map<string, { range: Range; annotation: OverlayAnnotation }>
): void {
  for (const [id, { range, annotation }] of ranges) {
    const className = `annotation-${annotation.type}`;

    // For ranges within a single text node, surroundContents works directly
    if (range.startContainer === range.endContainer) {
      const span = document.createElement('span');
      span.className = className;
      span.dataset.annotationId = id;
      span.dataset.annotationType = annotation.type;
      try {
        range.surroundContents(span);
      } catch {
        // surroundContents can fail if range partially selects a non-text node
        wrapRangeTextNodes(range, id, annotation);
      }
      continue;
    }

    // For cross-element ranges, wrap each text node segment individually
    wrapRangeTextNodes(range, id, annotation);
  }
}

/**
 * Wrap individual text node segments within a range (for cross-element ranges).
 * Same approach as Hypothesis web annotator.
 */
function wrapRangeTextNodes(
  range: Range,
  id: string,
  annotation: OverlayAnnotation
): void {
  const className = `annotation-${annotation.type}`;

  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT
  );

  // Collect text nodes first (avoid modifying DOM while walking)
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (range.intersectsNode(node)) {
      textNodes.push(node);
    }
  }

  for (const textNode of textNodes) {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(textNode);

    // Clip to annotation boundaries
    if (textNode === range.startContainer) {
      nodeRange.setStart(textNode, range.startOffset);
    }
    if (textNode === range.endContainer) {
      nodeRange.setEnd(textNode, range.endOffset);
    }

    const span = document.createElement('span');
    span.className = className;
    span.dataset.annotationId = id;
    span.dataset.annotationType = annotation.type;
    try {
      nodeRange.surroundContents(span);
    } catch {
      // Skip nodes that can't be wrapped (e.g., empty text nodes)
    }
  }
}

/**
 * Remove all annotation highlight spans, restoring the original DOM.
 * Unwraps spans and merges adjacent text nodes.
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
    parent.normalize(); // merge adjacent text nodes
  }
}

// ─── Convert W3C Annotations to Overlay Format ──────────────────────────────

/**
 * Convert W3C Annotations to the simplified overlay format.
 * Extracts TextPositionSelector offsets and annotation type.
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
