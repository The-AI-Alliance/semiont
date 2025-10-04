import { visit, SKIP } from 'unist-util-visit';
import type { Root, Element, Text, ElementContent } from 'hast';

interface Annotation {
  id: string;
  text: string;
  offset: number;
  length: number;
  type: 'highlight' | 'reference';
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

      visit(element, 'text', (textNode: Text, index: number | undefined, parent: Element | Root | undefined) => {
        if (!textNode.position || index === undefined || !parent || parent.type !== 'element') {
          return SKIP;
        }

        const textStart = textNode.position.start.offset;
        const textEnd = textNode.position.end.offset;

        if (textStart === undefined || textEnd === undefined) {
          return SKIP;
        }

        const textContent = textNode.value;

        // Find overlapping annotations using range intersection
        const applicable = annotations.filter(ann => {
          const annStart = ann.offset;
          const annEnd = ann.offset + ann.length;
          return annStart < textEnd && annEnd > textStart;
        });

        if (applicable.length === 0) {
          return SKIP;
        }

        // Build position mapping from source to rendered
        const sourceTextInNode = originalSource.substring(textStart, textEnd);

        // Build a map: source offset → rendered offset
        // This handles cases where markdown syntax is stripped
        const sourceToRendered = new Map<number, number>();
        let renderedPos = 0;

        for (let sourcePos = 0; sourcePos < sourceTextInNode.length; sourcePos++) {
          const sourceChar = sourceTextInNode[sourcePos];
          const renderedChar = textContent[renderedPos];

          if (sourceChar === renderedChar) {
            // Character matches - record the mapping
            sourceToRendered.set(textStart + sourcePos, renderedPos);
            renderedPos++;
          } else {
            // Character doesn't match - this is markdown syntax being stripped
            // Map this source position to the current rendered position
            sourceToRendered.set(textStart + sourcePos, renderedPos);
          }
        }

        // Now map annotations using the position map
        const segments: ElementContent[] = [];
        let lastPos = 0;

        // Sort annotations by position
        const sortedAnnotations = applicable.sort((a, b) => a.offset - b.offset);

        for (const ann of sortedAnnotations) {
          // Find where this annotation starts and ends in rendered text
          let relStart = sourceToRendered.get(ann.offset);
          let relEnd = sourceToRendered.get(ann.offset + ann.length - 1);

          // If we couldn't find exact mappings, skip this annotation
          if (relStart === undefined || relEnd === undefined) {
            continue;
          }

          // relEnd should point to the last character, so we need to add 1 for substring
          relEnd = relEnd + 1;

          // Clamp to text bounds
          relStart = Math.max(0, Math.min(relStart, textContent.length));
          relEnd = Math.max(0, Math.min(relEnd, textContent.length));

          // Skip if range is invalid
          if (relStart >= relEnd) continue;

          // Skip overlapping annotations
          if (relStart < lastPos) continue;

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

        // Add remaining text after last annotation
        if (lastPos < textContent.length) {
          segments.push({
            type: 'text',
            value: textContent.substring(lastPos)
          });
        }

        // Replace text node with wrapper containing segments
        if (segments.length > 1) {
          (parent as Element).children[index] = {
            type: 'element',
            tagName: 'span',
            properties: {},
            children: segments
          };
        }

        return SKIP;
      });
    });
  };
}
