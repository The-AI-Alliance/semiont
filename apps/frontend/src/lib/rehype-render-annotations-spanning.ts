import type { Root, Element, Text, ElementContent, Parent } from 'hast';

interface Annotation {
  id: string;
  text: string;
  offset: number;
  length: number;
  type: 'highlight' | 'reference';
}

interface TextNodeInfo {
  node: Text;
  startOffset: number;
  endOffset: number;
  parent: Element;
  indexInParent: number;
}

/**
 * Annotation renderer that handles annotations spanning multiple elements.
 *
 * Strategy:
 * 1. For each element with annotations, collect all descendant text nodes with positions
 * 2. For each annotation, find which child elements it spans
 * 3. Wrap sequences of children that share annotation coverage
 * 4. Handle overlapping annotations by processing longest-span first
 */
export function rehypeRenderAnnotations() {
  return (tree: Root) => {
    visitElements(tree, (element: Element) => {
      const annotationsJson = element.properties?.['data-annotations'];
      const originalSource = element.properties?.['data-source'];

      if (!annotationsJson || typeof annotationsJson !== 'string' || typeof originalSource !== 'string') {
        return;
      }

      const annotations: Annotation[] = JSON.parse(annotationsJson);

      // Apply annotations that span across this element's descendants
      applyAnnotationsToElement(element, annotations, originalSource);
    });
  };
}

function visitElements(node: Root | Element, visitor: (element: Element) => void) {
  if (node.type === 'element') {
    visitor(node);
  }

  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (child.type === 'element') {
        visitElements(child, visitor);
      }
    }
  }
}

function applyAnnotationsToElement(
  element: Element,
  annotations: Annotation[],
  originalSource: string
) {
  // First, recursively process nested elements
  for (let i = 0; i < element.children.length; i++) {
    const child = element.children[i];
    if (child.type === 'element') {
      applyAnnotationsToElement(child, annotations, originalSource);
    }
  }

  // Now handle annotations that span across this element's immediate children
  const childSpans = analyzeChildSpans(element, annotations);

  if (childSpans.length === 0) {
    return; // No annotations span multiple children
  }

  // Sort annotations by span length (longest first) to handle nesting
  const sortedSpans = childSpans.sort((a, b) => {
    const aLength = a.endChildIndex - a.startChildIndex;
    const bLength = b.endChildIndex - b.startChildIndex;
    return bLength - aLength;
  });

  // Apply each annotation span by wrapping the affected children
  for (const span of sortedSpans) {
    if (span.endChildIndex - span.startChildIndex > 0) {
      wrapChildRange(element, span);
    }
  }
}

interface ChildSpan {
  annotation: Annotation;
  startChildIndex: number;
  endChildIndex: number; // exclusive
}

function analyzeChildSpans(
  element: Element,
  annotations: Annotation[]
): ChildSpan[] {
  const spans: ChildSpan[] = [];

  for (const ann of annotations) {
    const annStart = ann.offset;
    const annEnd = ann.offset + ann.length;

    let startChildIndex = -1;
    let endChildIndex = -1;

    // Find which children this annotation spans
    for (let i = 0; i < element.children.length; i++) {
      const child = element.children[i];
      const childRange = getNodeOffsetRange(child);

      if (!childRange) continue;

      const [childStart, childEnd] = childRange;

      // Check if annotation overlaps this child
      if (annStart < childEnd && annEnd > childStart) {
        if (startChildIndex === -1) {
          startChildIndex = i;
        }
        endChildIndex = i + 1; // exclusive
      }
    }

    // Only track if annotation spans multiple children
    if (startChildIndex !== -1 && endChildIndex - startChildIndex > 1) {
      spans.push({
        annotation: ann,
        startChildIndex,
        endChildIndex
      });
    }
  }

  return spans;
}

function getNodeOffsetRange(node: ElementContent): [number, number] | null {
  if (node.type === 'text') {
    if (node.position?.start.offset !== undefined && node.position?.end.offset !== undefined) {
      return [node.position.start.offset, node.position.end.offset];
    }
  } else if (node.type === 'element') {
    if (node.position?.start.offset !== undefined && node.position?.end.offset !== undefined) {
      return [node.position.start.offset, node.position.end.offset];
    }
  }
  return null;
}

function wrapChildRange(element: Element, span: ChildSpan) {
  const { annotation, startChildIndex, endChildIndex } = span;

  // Extract the children to wrap
  const childrenToWrap = element.children.slice(startChildIndex, endChildIndex);

  // Create annotation wrapper
  const className = annotation.type === 'highlight'
    ? 'bg-yellow-200 dark:bg-yellow-800'
    : 'border-b-2 border-blue-500 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900';

  const wrapper: Element = {
    type: 'element',
    tagName: 'span',
    properties: {
      className,
      'data-annotation-id': annotation.id,
      'data-annotation-type': annotation.type
    },
    children: childrenToWrap
  };

  // Replace the range with the wrapper
  element.children.splice(startChildIndex, endChildIndex - startChildIndex, wrapper);
}
