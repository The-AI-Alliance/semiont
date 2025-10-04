import { visit, SKIP } from 'unist-util-visit';
import type { Root, Element, Text, ElementContent } from 'hast';

interface Annotation {
  id: string;
  text: string;
  offset: number;
  length: number;
  type: 'highlight' | 'reference';
}

interface ChildSpan {
  annotation: Annotation;
  startChildIndex: number;
  endChildIndex: number; // exclusive
}

export function rehypeRenderAnnotations() {
  return (tree: Root) => {
    visit(tree, 'element', (element: Element) => {
      const annotationsJson = element.properties?.['data-annotations'];
      const originalSource = element.properties?.['data-source'];

      if (!annotationsJson || typeof annotationsJson !== 'string' || typeof originalSource !== 'string') {
        return;
      }

      const annotations: Annotation[] = JSON.parse(annotationsJson);

      // PHASE 1: Handle annotations that span across multiple immediate children
      wrapCrossElementAnnotations(element, annotations);

      // PHASE 2: Handle annotations within individual text nodes
      applyWithinTextNodeAnnotations(element, annotations, originalSource);
    });
  };
}

/**
 * Phase 1: Wrap annotations that span multiple child elements.
 * Example: <strong>Zeus</strong> and <strong>Hera</strong>
 * If annotation spans both, wrap them: <span class="annotation"><strong>Zeus</strong> and <strong>Hera</strong></span>
 */
function wrapCrossElementAnnotations(element: Element, annotations: Annotation[]) {
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

function analyzeChildSpans(element: Element, annotations: Annotation[]): ChildSpan[] {
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

  const className = annotation.type === 'highlight'
    ? 'bg-yellow-200 dark:bg-yellow-800'
    : 'border-b-2 border-blue-500 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900';

  const wrapper: Element = {
    type: 'element',
    tagName: 'span',
    properties: {
      className,
      'data-annotation-id': annotation.id,
      'data-annotation-type': annotation.type,
      'data-annotation-cross-element': 'true'
    },
    children: childrenToWrap
  };

  element.children.splice(startChildIndex, endChildIndex - startChildIndex, wrapper);
}

/**
 * Phase 2: Apply annotations within individual text nodes.
 * This handles the normal case where an annotation is entirely within a text node.
 */
function applyWithinTextNodeAnnotations(
  element: Element,
  annotations: Annotation[],
  originalSource: string
) {
  visit(element, 'text', (textNode: Text, index: number | undefined, parent: Element | Root | undefined) => {
    if (index === undefined || !parent || parent.type !== 'element') {
      return SKIP;
    }

    // Skip text nodes that are already inside cross-element annotation wrappers
    if ((parent as Element).properties?.['data-annotation-cross-element']) {
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

      // Annotation span
      const className = ann.type === 'highlight'
        ? 'bg-yellow-200 dark:bg-yellow-800'
        : 'border-b-2 border-blue-500 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900';

      segments.push({
        type: 'element',
        tagName: 'span',
        properties: {
          className,
          'data-annotation-id': ann.id,
          'data-annotation-type': ann.type
        },
        children: [{ type: 'text', value: textContent.substring(relStart, relEnd) }]
      });

      lastPos = relEnd;
    }

    // Remaining text
    if (lastPos < textContent.length) {
      segments.push({ type: 'text', value: textContent.substring(lastPos) });
    }

    if (segments.length > 0) {
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
