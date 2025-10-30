import { visit, SKIP } from 'unist-util-visit';
import type { Root, Element, Text, ElementContent } from 'hast';

/**
 * PreparedAnnotation - Simplified annotation format for rehype rendering
 * This is NOT the W3C Annotation from the API - it's a pre-processed format
 * created by remark-annotations plugin with offset/length for text processing
 */
interface PreparedAnnotation {
  id: string;
  exact: string;
  offset: number;
  length: number;
  type: string; // Internal type like 'highlight', 'comment', 'assessment', 'reference'
  source?: string;
}

interface ChildSpan {
  annotation: PreparedAnnotation;
  startChildIndex: number;
  endChildIndex: number; // exclusive
}

/**
 * Build annotation span element with styling
 * Determines className and data attributes based on annotation type and source
 */
function buildAnnotationSpan(annotation: PreparedAnnotation, children: ElementContent[]): Element {
  let className: string;
  const annotationType = annotation.type;

  if (annotation.type === 'highlight') {
    className = 'bg-yellow-200 dark:bg-yellow-800';
  } else if (annotation.type === 'assessment') {
    // Red squiggly underline for assessments (errors, warnings)
    className = 'red-underline cursor-pointer transition-all duration-200 hover:opacity-80';
  } else if (annotation.type === 'comment') {
    // Gray dashed outline for comments, no background
    className = 'rounded px-0.5 cursor-pointer transition-all duration-200 hover:bg-gray-100 dark:hover:bg-gray-800 outline outline-2 outline-dashed outline-gray-900 dark:outline-gray-100 outline-offset-1';
  } else if (annotation.type === 'reference') {
    // Stub reference (no target document) - red text with !important-like specificity
    if (!annotation.source) {
      className = 'cursor-pointer transition-all duration-200 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 font-inherit';
    } else {
      // Resolved reference - blue text with !important-like specificity
      className = 'cursor-pointer transition-all duration-200 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 font-inherit';
    }
  } else {
    className = 'cursor-pointer transition-all duration-200 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 font-inherit';
  }

  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className,
      'data-annotation-id': annotation.id,
      'data-annotation-type': annotationType
    },
    children
  };
}

export function rehypeRenderAnnotations() {
  return (tree: Root, file: any) => {
    // Get source from VFile instead of storing in DOM
    const originalSource = String(file);

    visit(tree, 'element', (element: Element) => {
      const annotationsJson = element.properties?.['data-annotations'];

      if (!annotationsJson || typeof annotationsJson !== 'string') {
        return;
      }

      const annotations: PreparedAnnotation[] = JSON.parse(annotationsJson);

      // Handle annotations that span across multiple immediate children
      wrapCrossElementAnnotations(element, annotations);

      // Handle annotations within individual text nodes
      applyWithinTextNodeAnnotations(element, annotations, originalSource);

      // CLEANUP: Remove temporary annotation metadata from the DOM
      delete element.properties['data-annotations'];
    });
  };
}

/**
 * Wrap annotations that span multiple child elements.
 * Example: <strong>Zeus</strong> and <strong>Hera</strong>
 * If annotation spans both, wrap them: <span class="annotation"><strong>Zeus</strong> and <strong>Hera</strong></span>
 */
function wrapCrossElementAnnotations(element: Element, annotations: PreparedAnnotation[]) {
  const spans = analyzeChildSpans(element, annotations);

  if (spans.length === 0) return;

  // Sort by span length (longest first) to handle nested annotations
  const sortedSpans = spans.sort((a, b) => {
    const aLength = a.endChildIndex - a.startChildIndex;
    const bLength = b.endChildIndex - b.startChildIndex;
    return bLength - aLength;
  });

  // Apply wrapping (need to apply in reverse order after sorting to avoid index shifts)
  for (const span of sortedSpans) {
    wrapChildRange(element, span);
  }
}

function analyzeChildSpans(element: Element, annotations: PreparedAnnotation[]): ChildSpan[] {
  const spans: ChildSpan[] = [];

  for (const ann of annotations) {
    const annStart = ann.offset;
    const annEnd = ann.offset + ann.length;

    let startChildIndex = -1;
    let endChildIndex = -1;

    for (let i = 0; i < element.children.length; i++) {
      const child = element.children[i];
      const childRange = getNodeOffsetRange(child);

      if (!childRange) continue;

      const [childStart, childEnd] = childRange;

      // Annotation overlaps this child
      if (annStart < childEnd && annEnd > childStart) {
        if (startChildIndex === -1) {
          startChildIndex = i;
        }
        endChildIndex = i + 1;
      }
    }

    // Only wrap if annotation spans multiple children
    if (startChildIndex !== -1 && endChildIndex - startChildIndex > 1) {
      spans.push({ annotation: ann, startChildIndex, endChildIndex });
    }
  }

  return spans;
}

function getNodeOffsetRange(node: ElementContent | undefined): [number, number] | null {
  if (!node) return null;
  if ('position' in node && node.position?.start.offset !== undefined && node.position?.end.offset !== undefined) {
    return [node.position.start.offset, node.position.end.offset];
  }
  return null;
}

function wrapChildRange(element: Element, span: ChildSpan) {
  const { annotation, startChildIndex, endChildIndex } = span;

  const childrenToWrap = element.children.slice(startChildIndex, endChildIndex);
  const wrapper = buildAnnotationSpan(annotation, childrenToWrap);

  element.children.splice(startChildIndex, endChildIndex - startChildIndex, wrapper);
}

/**
 * Apply annotations within individual text nodes.
 * This handles the normal case where an annotation is entirely within a text node.
 */
function applyWithinTextNodeAnnotations(
  element: Element,
  annotations: PreparedAnnotation[],
  originalSource: string
) {
  visit(element, 'text', (textNode: Text, index: number | undefined, parent: Element | Root | undefined) => {
    if (index === undefined || !parent || parent.type !== 'element') {
      return SKIP;
    }

    // Skip text nodes that are already inside annotation wrappers
    if ((parent as Element).properties?.['data-annotation-id']) {
      return SKIP;
    }

    const position = textNode.position || (parent as Element).position;
    if (!position) return SKIP;

    const textStart = position.start.offset;
    const textEnd = position.end.offset;

    if (textStart === undefined || textEnd === undefined) return SKIP;

    const textContent = textNode.value;

    // Find overlapping annotations
    const applicable = annotations.filter(ann => {
      const annStart = ann.offset;
      const annEnd = ann.offset + ann.length;
      // Handle annotations that overlap with this text node
      // Use range intersection, not full containment
      return annStart < textEnd && annEnd > textStart;
    });

    if (applicable.length === 0) return SKIP;

    // Build position mapping
    const sourceTextInNode = originalSource.substring(textStart, textEnd);
    const sourceToRendered = buildPositionMap(sourceTextInNode, textContent, textStart);

    // Build segments
    const segments: ElementContent[] = [];
    let lastPos = 0;

    for (const ann of applicable.sort((a, b) => a.offset - b.offset)) {
      let relStart = sourceToRendered.get(ann.offset);
      let relEnd = sourceToRendered.get(ann.offset + ann.length - 1);

      if (relStart === undefined || relEnd === undefined) continue;

      relEnd = relEnd + 1;
      relStart = Math.max(0, Math.min(relStart, textContent.length));
      relEnd = Math.max(0, Math.min(relEnd, textContent.length));

      if (relStart >= relEnd || relStart < lastPos) continue;

      // Text before annotation
      if (relStart > lastPos) {
        segments.push({ type: 'text', value: textContent.substring(lastPos, relStart) });
      }

      // Annotation span - use centralized styling function
      const annotationSpan = buildAnnotationSpan(ann, [
        { type: 'text', value: textContent.substring(relStart, relEnd) }
      ]);
      segments.push(annotationSpan);

      lastPos = relEnd;
    }

    // Remaining text
    if (lastPos < textContent.length) {
      segments.push({ type: 'text', value: textContent.substring(lastPos) });
    }

    // Replace the text node with segments
    if (segments.length === 0) {
      return SKIP; // No changes needed
    } else if (segments.length === 1 && segments[0]) {
      // Single segment - replace directly without wrapper
      (parent as Element).children[index] = segments[0];
    } else {
      // Multiple segments - need wrapper
      (parent as Element).children[index] = {
        type: 'element',
        tagName: 'span',
        properties: {},
        children: segments
      };
    }

    return SKIP;
  });
}

function buildPositionMap(
  sourceText: string,
  renderedText: string,
  baseOffset: number
): Map<number, number> {
  const map = new Map<number, number>();
  let renderedPos = 0;
  let sourcePos = 0;

  while (sourcePos < sourceText.length && renderedPos < renderedText.length) {
    if (sourceText[sourcePos] === renderedText[renderedPos]) {
      map.set(baseOffset + sourcePos, renderedPos);
      renderedPos++;
      sourcePos++;
    } else {
      sourcePos++;
    }
  }

  while (sourcePos < sourceText.length) {
    map.set(baseOffset + sourcePos, renderedPos);
    sourcePos++;
  }

  return map;
}
