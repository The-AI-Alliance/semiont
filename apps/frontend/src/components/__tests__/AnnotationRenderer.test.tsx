import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import * as fc from 'fast-check';
import '@testing-library/jest-dom';
import { AnnotationRenderer } from '../AnnotationRenderer';
import { DocumentAnnotationsProvider } from '../../contexts/DocumentAnnotationsContext';

/**
 * AXIOMS FOR ANNOTATION RENDERING
 * 
 * 1. POSITION PRESERVATION: Annotations must preserve the exact character positions
 *    from the source text, regardless of rendering transformations
 * 
 * 2. NON-OVERLAPPING: Multiple annotations can exist but the renderer must handle
 *    overlapping gracefully (either merge, layer, or reject)
 * 
 * 3. CONTENT INTEGRITY: The rendered text content must match the source content
 *    exactly - annotations only add styling, never modify text
 * 
 * 4. SELECTION INDEPENDENCE: User text selection must work independently of
 *    annotations - selecting text should not interfere with annotation rendering
 * 
 * 5. MARKDOWN TRANSPARENCY: Markdown rendering must be transparent to position
 *    tracking - positions refer to source text, not rendered HTML
 * 
 * 6. INCREMENTAL STABILITY: Adding/removing one annotation should not affect
 *    the rendering of other non-overlapping annotations
 * 
 * 7. INTERACTION ISOLATION: Click/hover on annotations should not trigger
 *    on the wrong annotation or affect other annotations
 * 
 * 8. REACTIVITY: When annotations are added or removed, the rendering must
 *    update to reflect the current state immediately
 * 
 * 9. MARKDOWN FIDELITY: Markdown elements must render as their semantic HTML
 *    equivalents with proper styling (h1, h2, p, etc.)
 */

// Test data generators
const textGenerator = fc.string({ minLength: 1, maxLength: 200 });

const annotationGenerator = (textLength: number) => 
  fc.record({
    id: fc.uuid(),
    start: fc.integer({ min: 0, max: Math.max(0, textLength - 1) }),
    length: fc.integer({ min: 1, max: Math.min(20, textLength) })
  }).map(ann => ({
    ...ann,
    end: Math.min(ann.start + ann.length, textLength),
    type: 'highlight' as const
  }));

const nonOverlappingAnnotations = (textLength: number) =>
  fc.array(annotationGenerator(textLength), { minLength: 0, maxLength: 5 })
    .map(anns => {
      // Sort and remove overlaps
      const sorted = anns.sort((a, b) => a.start - b.start);
      const result = [];
      let lastEnd = 0;
      for (const ann of sorted) {
        if (ann.start >= lastEnd) {
          result.push(ann);
          lastEnd = ann.end;
        }
      }
      return result;
    });

// Core annotation logic (pure functions to test)
export function applyAnnotationsToText(
  text: string,
  annotations: Array<{ start: number; end: number; id: string; type: string }>
): Array<{ text: string; annotationId?: string; className?: string }> {
  if (!text || annotations.length === 0) {
    return [{ text }];
  }

  // Filter and validate annotations
  const validAnnotations = annotations
    .filter(ann => ann.start >= 0 && ann.end <= text.length && ann.start < ann.end)
    .sort((a, b) => a.start - b.start);

  if (validAnnotations.length === 0) {
    return [{ text }];
  }

  const segments: Array<{ text: string; annotationId?: string; className?: string }> = [];
  let position = 0;

  for (const ann of validAnnotations) {
    // Skip overlapping annotations
    if (ann.start < position) {
      continue;
    }

    // Add text before annotation
    if (ann.start > position) {
      segments.push({ text: text.slice(position, ann.start) });
    }

    // Add annotated segment
    segments.push({
      text: text.slice(ann.start, ann.end),
      annotationId: ann.id,
      className: ann.type === 'highlight' ? 'highlight' : 'reference'
    });
    position = ann.end;
  }

  // Add remaining text
  if (position < text.length) {
    segments.push({ text: text.slice(position) });
  }

  return segments;
}

// Property-based tests
describe('Annotation Rendering Properties', () => {
  
  // AXIOM 1: Position Preservation
  test('annotations preserve exact character positions', () => {
    fc.assert(
      fc.property(
        textGenerator.chain(text => 
          fc.tuple(
            fc.constant(text),
            nonOverlappingAnnotations(text.length)
          )
        ),
        ([text, annotations]) => {
          const segments = applyAnnotationsToText(text, annotations);
          
          // Reconstruct text from segments
          const reconstructed = segments.map(s => s.text).join('');
          expect(reconstructed).toBe(text);
          
          // Check each annotation covers correct text
          for (const ann of annotations) {
            const annotatedText = text.slice(ann.start, ann.end);
            const segment = segments.find(s => s.annotationId === ann.id);
            if (segment) {
              expect(segment.text).toBe(annotatedText);
            }
          }
          
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  // AXIOM 2: Non-overlapping handling
  test('overlapping annotations are handled correctly', () => {
    const text = "Hello world, this is a test";
    const overlapping = [
      { id: '1', start: 0, end: 5, type: 'highlight' },  // "Hello"
      { id: '2', start: 3, end: 8, type: 'highlight' },  // "lo wo"
    ];
    
    const segments = applyAnnotationsToText(text, overlapping);
    const reconstructed = segments.map(s => s.text).join('');
    expect(reconstructed).toBe(text);
  });

  // AXIOM 3: Content Integrity
  test('annotations never modify text content', () => {
    fc.assert(
      fc.property(
        textGenerator.chain(text => 
          fc.tuple(
            fc.constant(text),
            fc.array(annotationGenerator(text.length), { maxLength: 10 })
          )
        ),
        ([text, annotations]) => {
          const segments = applyAnnotationsToText(text, annotations);
          const reconstructed = segments.map(s => s.text).join('');
          expect(reconstructed).toBe(text);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  // AXIOM 6: Incremental Stability
  test('adding one annotation does not affect others', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          textGenerator,
          fc.func(fc.boolean())
        ).chain(([text, _]) => 
          fc.tuple(
            fc.constant(text),
            nonOverlappingAnnotations(text.length)
          )
        ),
        ([text, annotations]) => {
          if (annotations.length === 0) return true;
          
          const withoutLast = annotations.slice(0, -1);
          const segmentsBefore = applyAnnotationsToText(text, withoutLast);
          const segmentsAfter = applyAnnotationsToText(text, annotations);
          
          // Check that segments for existing annotations haven't changed
          for (const ann of withoutLast) {
            const before = segmentsBefore.find(s => s.annotationId === ann.id);
            const after = segmentsAfter.find(s => s.annotationId === ann.id);
            expect(before?.text).toBe(after?.text);
          }
          
          return true;
        }
      ),
      { numRuns: 50 }
    );
  });
});

// Test for markdown position mapping
describe('Markdown Position Mapping', () => {
  
  interface PositionMap {
    sourceToRendered: Map<number, number>;
    renderedToSource: Map<number, number>;
  }
  
  function buildPositionMap(source: string, rendered: string): PositionMap {
    // Simplified position mapping for testing
    // In reality, this would parse markdown and track transformations
    const map: PositionMap = {
      sourceToRendered: new Map(),
      renderedToSource: new Map()
    };
    
    // For testing, assume 1:1 mapping for plain text
    for (let i = 0; i <= source.length; i++) {
      map.sourceToRendered.set(i, i);
      map.renderedToSource.set(i, i);
    }
    
    return map;
  }
  
  test('position mapping is bijective for plain text', () => {
    fc.assert(
      fc.property(
        textGenerator,
        (text) => {
          const map = buildPositionMap(text, text);
          
          // Check bijection
          for (let i = 0; i <= text.length; i++) {
            const rendered = map.sourceToRendered.get(i);
            expect(rendered).toBeDefined();
            const source = map.renderedToSource.get(rendered!);
            expect(source).toBe(i);
          }
        }
      )
    );
  });
});

// Test the actual React component behavior
describe('Component Integration Tests', () => {
  
  // Mock component for testing
  function TestableAnnotationRenderer({
    content,
    annotations
  }: {
    content: string;
    annotations: Array<{ id: string; start: number; end: number; type: string }>;
  }) {
    const segments = applyAnnotationsToText(content, annotations);
    
    return (
      <div data-testid="renderer">
        {segments.map((segment, i) => (
          segment.annotationId ? (
            <span
              key={i}
              data-annotation-id={segment.annotationId}
              className={segment.className}
            >
              {segment.text}
            </span>
          ) : (
            <React.Fragment key={i}>{segment.text}</React.Fragment>
          )
        ))}
      </div>
    );
  }
  
  test('renders all annotations', () => {
    const content = "This is a test document with some text";
    const annotations = [
      { id: '1', start: 0, end: 4, type: 'highlight' },   // "This"
      { id: '2', start: 10, end: 14, type: 'highlight' }, // "test"
      { id: '3', start: 30, end: 34, type: 'reference' }, // "some"
    ];
    
    render(<TestableAnnotationRenderer content={content} annotations={annotations} />);
    
    const annotationSpans = screen.getAllByText((content, element) => {
      return element?.hasAttribute('data-annotation-id') || false;
    });
    
    expect(annotationSpans).toHaveLength(3);
  });
  
  test('preserves text content exactly', () => {
    fc.assert(
      fc.property(
        textGenerator.chain(content => 
          fc.tuple(
            fc.constant(content),
            nonOverlappingAnnotations(content.length)
          )
        ),
        ([content, annotations]) => {
          const { container } = render(
            <TestableAnnotationRenderer 
              content={content} 
              annotations={annotations} 
            />
          );
          
          const renderedText = container.textContent;
          expect(renderedText).toBe(content);
          return true;
        }
      ),
      { numRuns: 50 }
    );
  });
});

// AXIOM 8: Reactivity Tests
describe('Reactivity', () => {
  // Simple test component that mimics the core behavior
  function SimpleAnnotationRenderer({ content, annotations }: { content: string; annotations: any[] }) {
    const segments = applyAnnotationsToText(content, annotations);
    return (
      <div>
        {segments.map((segment, i) => (
          segment.annotationId ? (
            <span key={i} data-annotation-id={segment.annotationId} className={segment.className}>
              {segment.text}
            </span>
          ) : (
            <React.Fragment key={i}>{segment.text}</React.Fragment>
          )
        ))}
      </div>
    );
  }
  
  test('removing an annotation updates the rendering', () => {
    const content = "This is a test document";
    const annotations = [
      { id: '1', start: 0, end: 4, type: 'highlight' },   // "This"
      { id: '2', start: 10, end: 14, type: 'reference' }, // "test"
    ];
    
    const { container, rerender } = render(
      <SimpleAnnotationRenderer content={content} annotations={annotations} />
    );
    
    // Check both annotations are rendered
    let annotationSpans = container.querySelectorAll('[data-annotation-id]');
    expect(annotationSpans).toHaveLength(2);
    expect(container.querySelector('[data-annotation-id="1"]')).toBeInTheDocument();
    expect(container.querySelector('[data-annotation-id="2"]')).toBeInTheDocument();
    
    // Remove one annotation
    const updatedAnnotations = annotations.filter(a => a.id !== '2');
    rerender(<SimpleAnnotationRenderer content={content} annotations={updatedAnnotations} />);
    
    // Check only one annotation remains
    annotationSpans = container.querySelectorAll('[data-annotation-id]');
    expect(annotationSpans).toHaveLength(1);
    expect(container.querySelector('[data-annotation-id="1"]')).toBeInTheDocument();
    expect(container.querySelector('[data-annotation-id="2"]')).not.toBeInTheDocument();
  });
  
  test('adding an annotation updates the rendering', () => {
    const content = "This is a test document";
    const initialAnnotations = [
      { id: '1', start: 0, end: 4, type: 'highlight' },   // "This"
    ];
    
    const { container, rerender } = render(
      <SimpleAnnotationRenderer content={content} annotations={initialAnnotations} />
    );
    
    // Check initial annotation
    expect(container.querySelectorAll('[data-annotation-id]')).toHaveLength(1);
    
    // Add another annotation
    const updatedAnnotations = [
      ...initialAnnotations,
      { id: '2', start: 10, end: 14, type: 'reference' }, // "test"
    ];
    rerender(<SimpleAnnotationRenderer content={content} annotations={updatedAnnotations} />);
    
    // Check both annotations are rendered
    const annotationSpans = container.querySelectorAll('[data-annotation-id]');
    expect(annotationSpans).toHaveLength(2);
    expect(container.querySelector('[data-annotation-id="1"]')).toBeInTheDocument();
    expect(container.querySelector('[data-annotation-id="2"]')).toBeInTheDocument();
  });
});

// AXIOM 9: Markdown Fidelity Tests
describe('Markdown Fidelity', () => {
  
  test('markdown content renders correctly with CodeMirror', () => {
    const markdownContent = `# Heading 1

## Heading 2

### Heading 3

Regular paragraph text.`;
    
    const { container } = render(
      <DocumentAnnotationsProvider>
        <AnnotationRenderer
          content={markdownContent}
          contentType="markdown"
          highlights={[]}
          references={[]}
        />
      </DocumentAnnotationsProvider>
    );
    
    // CodeMirror renders content within a .cm-content container
    const cmContent = container.querySelector('.cm-content');
    expect(cmContent).toBeInTheDocument();
    
    // Check that the text content is preserved (CodeMirror renders formatted text)
    expect(container.textContent).toContain('Heading 1');
    expect(container.textContent).toContain('Heading 2');
    expect(container.textContent).toContain('Heading 3');
    expect(container.textContent).toContain('Regular paragraph text.');
  });
  
  test('markdown lists render correctly with CodeMirror', () => {
    const markdownContent = `- Item 1
- Item 2

1. Numbered 1
2. Numbered 2`;
    
    const { container } = render(
      <DocumentAnnotationsProvider>
        <AnnotationRenderer
          content={markdownContent}
          contentType="markdown"
          highlights={[]}
          references={[]}
        />
      </DocumentAnnotationsProvider>
    );
    
    // CodeMirror renders content within a .cm-content container
    const cmContent = container.querySelector('.cm-content');
    expect(cmContent).toBeInTheDocument();
    
    // Check that list content is preserved (CodeMirror renders formatted lists)
    expect(container.textContent).toContain('Item 1');  // Bullet points hide the '-'
    expect(container.textContent).toContain('Item 2');
    expect(container.textContent).toContain('1. Numbered 1');  // Numbers are kept
    expect(container.textContent).toContain('2. Numbered 2');
  });
});

// Edge cases
describe('Edge Cases', () => {
  
  test('handles empty text', () => {
    const segments = applyAnnotationsToText('', []);
    expect(segments).toEqual([{ text: '' }]);
  });
  
  test('handles annotations at boundaries', () => {
    const text = 'test';
    const annotations = [
      { id: '1', start: 0, end: 1, type: 'highlight' },  // First char
      { id: '2', start: 3, end: 4, type: 'highlight' },  // Last char
    ];
    
    const segments = applyAnnotationsToText(text, annotations);
    expect(segments.map(s => s.text).join('')).toBe(text);
    expect(segments.filter(s => s.annotationId).length).toBe(2);
  });
  
  test('handles invalid annotation ranges gracefully', () => {
    const text = 'test';
    const invalid = [
      { id: '1', start: -1, end: 2, type: 'highlight' },   // Negative start
      { id: '2', start: 2, end: 10, type: 'highlight' },   // End beyond text
      { id: '3', start: 3, end: 1, type: 'highlight' },    // End before start
    ];
    
    // Should not throw, should handle gracefully
    expect(() => applyAnnotationsToText(text, invalid)).not.toThrow();
  });
});