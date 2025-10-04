import type { Root, Element, Text, ElementContent } from 'hast';

interface Annotation {
  id: string;
  text: string;
  offset: number;
  length: number;
  type: 'highlight' | 'reference';
}

/**
 * Stack-based annotation renderer that handles annotations spanning multiple elements.
 *
 * Key idea: Process the LCA's children sequentially, tracking which annotations are "open"
 * at each point. Wrap consecutive nodes that share the same set of active annotations.
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

      // Process this element's children with annotation wrapping
      wrapAnnotationsInElement(element, annotations, originalSource);
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

function wrapAnnotationsInElement(
  element: Element,
  annotations: Annotation[],
  originalSource: string
) {
  // First, recursively process any nested elements
  for (const child of element.children) {
    if (child.type === 'element') {
      wrapAnnotationsInElement(child, annotations, originalSource);
    }
  }

  // Now process this element's immediate children to wrap annotations that span across them
  const newChildren: ElementContent[] = [];

  for (const child of element.children) {
    if (child.type === 'text' && child.position) {
      const processed = processTextWithAnnotations(child, annotations, originalSource);
      if (Array.isArray(processed)) {
        newChildren.push(...processed);
      } else {
        newChildren.push(processed);
      }
    } else {
      newChildren.push(child);
    }
  }

  element.children = newChildren;
}

function processTextWithAnnotations(
  textNode: Text,
  annotations: Annotation[],
  originalSource: string
): ElementContent | ElementContent[] {
  const textStart = textNode.position!.start.offset!;
  const textEnd = textNode.position!.end.offset!;
  const textContent = textNode.value;

  // Find overlapping annotations
  const applicable = annotations.filter(ann => {
    const annStart = ann.offset;
    const annEnd = ann.offset + ann.length;
    return annStart < textEnd && annEnd > textStart;
  });

  if (applicable.length === 0) {
    return textNode;
  }

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

  if (segments.length === 0) return textNode;
  if (segments.length === 1) return segments[0];

  return {
    type: 'element',
    tagName: 'span',
    properties: {},
    children: segments
  };
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
