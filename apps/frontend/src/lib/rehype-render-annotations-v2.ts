import type { Root, Element, Text, ElementContent, Parent } from 'hast';

interface Annotation {
  id: string;
  text: string;
  offset: number;
  length: number;
  type: 'highlight' | 'reference';
}

interface AnnotationState {
  annotation: Annotation;
  startOffset: number;
  endOffset: number;
}

/**
 * Stack-based annotation renderer that can handle annotations spanning multiple elements.
 *
 * Algorithm:
 * 1. Find the lowest common ancestor (LCA) that contains all overlapping annotations
 * 2. Walk the LCA's descendants, maintaining a stack of "active" annotations
 * 3. When entering a text node, check which annotations start/end/continue
 * 4. Wrap text segments with annotation spans based on active stack
 */
export function rehypeRenderAnnotations() {
  return (tree: Root) => {
    // Visit each element that has annotations
    visitElement(tree, (element: Element) => {
      const annotationsJson = element.properties?.['data-annotations'];
      const originalSource = element.properties?.['data-source'];

      if (!annotationsJson || typeof annotationsJson !== 'string' || typeof originalSource !== 'string') {
        return;
      }

      const annotations: Annotation[] = JSON.parse(annotationsJson);

      // Process this element's subtree with the annotation stack
      processElementWithAnnotations(element, annotations, originalSource);
    });
  };
}

function visitElement(node: Root | Element, visitor: (element: Element) => void) {
  if (node.type === 'element') {
    visitor(node);
  }

  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (child.type === 'element') {
        visitElement(child, visitor);
      }
    }
  }
}

function processElementWithAnnotations(
  element: Element,
  annotations: Annotation[],
  originalSource: string
) {
  // Build a new children array with annotations applied
  const newChildren: ElementContent[] = [];
  const annotationStack: AnnotationState[] = [];

  // Recursive function to process nodes
  function processNode(node: ElementContent): ElementContent | ElementContent[] {
    if (node.type === 'text') {
      return processTextNode(node, annotationStack, annotations, originalSource);
    } else if (node.type === 'element') {
      // Process element's children recursively
      const processedChildren: ElementContent[] = [];

      for (const child of node.children) {
        const result = processNode(child);
        if (Array.isArray(result)) {
          processedChildren.push(...result);
        } else {
          processedChildren.push(result);
        }
      }

      return {
        ...node,
        children: processedChildren
      };
    }

    return node;
  }

  // Process all children
  for (const child of element.children) {
    const result = processNode(child);
    if (Array.isArray(result)) {
      newChildren.push(...result);
    } else {
      newChildren.push(result);
    }
  }

  element.children = newChildren;
}

function processTextNode(
  textNode: Text,
  annotationStack: AnnotationState[],
  allAnnotations: Annotation[],
  originalSource: string
): ElementContent | ElementContent[] {
  // Get position - try text node first, then we'd need parent (but we don't have it here)
  if (!textNode.position) {
    return textNode;
  }

  const textStart = textNode.position.start.offset;
  const textEnd = textNode.position.end.offset;

  if (textStart === undefined || textEnd === undefined) {
    return textNode;
  }

  const textContent = textNode.value;

  // Find annotations that overlap with this text node
  const applicable = allAnnotations.filter(ann => {
    const annStart = ann.offset;
    const annEnd = ann.offset + ann.length;
    return annStart < textEnd && annEnd > textStart;
  });

  if (applicable.length === 0) {
    return textNode;
  }

  // Build position mapping from source to rendered
  const sourceTextInNode = originalSource.substring(textStart, textEnd);
  const sourceToRendered = buildPositionMap(sourceTextInNode, textContent, textStart);

  // Build segments with annotations
  const segments: ElementContent[] = [];
  let lastPos = 0;

  // Sort annotations by position
  const sortedAnnotations = applicable.sort((a, b) => a.offset - b.offset);

  for (const ann of sortedAnnotations) {
    // Find where this annotation starts and ends in rendered text
    let relStart = sourceToRendered.get(ann.offset);
    let relEnd = sourceToRendered.get(ann.offset + ann.length - 1);

    if (relStart === undefined || relEnd === undefined) {
      continue;
    }

    relEnd = relEnd + 1; // Convert to exclusive end

    // Clamp to text bounds
    relStart = Math.max(0, Math.min(relStart, textContent.length));
    relEnd = Math.max(0, Math.min(relEnd, textContent.length));

    if (relStart >= relEnd) continue;
    if (relStart < lastPos) continue; // Skip overlapping

    // Add text before annotation
    if (relStart > lastPos) {
      segments.push({
        type: 'text',
        value: textContent.substring(lastPos, relStart)
      });
    }

    // Add annotation span
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
      children: [{
        type: 'text',
        value: textContent.substring(relStart, relEnd)
      }]
    });

    lastPos = relEnd;
  }

  // Add remaining text
  if (lastPos < textContent.length) {
    segments.push({
      type: 'text',
      value: textContent.substring(lastPos)
    });
  }

  // Return segments or wrapper
  if (segments.length === 0) {
    return textNode;
  } else if (segments.length === 1) {
    return segments[0];
  } else {
    return {
      type: 'element',
      tagName: 'span',
      properties: {},
      children: segments
    };
  }
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
    const sourceChar = sourceText[sourcePos];
    const renderedChar = renderedText[renderedPos];

    if (sourceChar === renderedChar) {
      map.set(baseOffset + sourcePos, renderedPos);
      renderedPos++;
      sourcePos++;
    } else {
      // Source has markdown syntax that was stripped
      sourcePos++;
    }
  }

  // Map any remaining source positions
  while (sourcePos < sourceText.length) {
    map.set(baseOffset + sourcePos, renderedPos);
    sourcePos++;
  }

  return map;
}
