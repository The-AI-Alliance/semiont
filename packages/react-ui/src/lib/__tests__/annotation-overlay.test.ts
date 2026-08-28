/**
 * Tests for annotation-overlay.ts — the DOM-based annotation rendering layer.
 *
 * These tests use jsdom's TreeWalker API to verify:
 * - Source→rendered offset mapping (markdown syntax stripping)
 * - Text node index construction
 * - Annotation offset-span resolution from W3C offsets
 * - Highlight span application (including overlap geometry) and cleanup
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildSourceToRenderedMap,
  buildTextNodeIndex,
  resolveAnnotationSpans,
  applyHighlights,
  clearHighlights,
  type OverlayAnnotation,
} from '../annotation-overlay';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a container element with the given HTML and attach it to the document
 * so that TreeWalker works in jsdom.
 */
function createContainer(html: string): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

function cleanup(container: HTMLDivElement): void {
  document.body.removeChild(container);
}

function makeAnnotation(overrides: Partial<OverlayAnnotation> & { id: string; offset: number; length: number }): OverlayAnnotation {
  return {
    exact: '',
    type: 'highlight',
    source: null,
    ...overrides,
  };
}

/** Resolve + apply against a container in one step (the BrowseView pipeline). */
function overlay(source: string, container: HTMLElement, annotations: OverlayAnnotation[]): void {
  const offsetMap = buildSourceToRenderedMap(source, container);
  const textNodeIndex = buildTextNodeIndex(container);
  applyHighlights(resolveAnnotationSpans(annotations, offsetMap), textNodeIndex);
}

// ─── buildSourceToRenderedMap ────────────────────────────────────────────────

describe('buildSourceToRenderedMap', () => {
  it('maps plain text 1:1 (no markdown syntax)', () => {
    const source = 'Hello world';
    const container = createContainer('<p>Hello world</p>');

    const map = buildSourceToRenderedMap(source, container);

    // Every source position maps to the same rendered position
    for (let i = 0; i < source.length; i++) {
      expect(map.get(i)).toBe(i);
    }

    cleanup(container);
  });

  it('skips bold markdown syntax (**)', () => {
    const source = 'The **Zeus** ruled.';
    // Rendered: "The Zeus ruled." (** stripped)
    const container = createContainer('<p>The <strong>Zeus</strong> ruled.</p>');

    const map = buildSourceToRenderedMap(source, container);

    // "The " at source 0-3 → rendered 0-3
    expect(map.get(0)).toBe(0); // T
    expect(map.get(1)).toBe(1); // h
    expect(map.get(2)).toBe(2); // e
    expect(map.get(3)).toBe(3); // (space)

    // source 4,5 are "**" → skipped, no entry pointing to rendered 4
    // "Zeus" at source 6-9 → rendered 4-7
    expect(map.get(6)).toBe(4); // Z
    expect(map.get(7)).toBe(5); // e
    expect(map.get(8)).toBe(6); // u
    expect(map.get(9)).toBe(7); // s

    // source 10,11 are "**" → skipped
    // " ruled." at source 12-18 → rendered 8-14
    expect(map.get(12)).toBe(8); // (space)

    cleanup(container);
  });

  it('skips italic markdown syntax (*)', () => {
    const source = 'The *Athena* was wise.';
    const container = createContainer('<p>The <em>Athena</em> was wise.</p>');

    const map = buildSourceToRenderedMap(source, container);

    // "Athena" at source 5-10 → rendered 4-9
    expect(map.get(5)).toBe(4);  // A
    expect(map.get(10)).toBe(9); // a

    cleanup(container);
  });

  it('handles link markdown syntax', () => {
    const source = 'See [Zeus](http://example.com) here.';
    // Rendered: "See Zeus here." (link syntax stripped, only link text remains)
    const container = createContainer('<p>See <a href="http://example.com">Zeus</a> here.</p>');

    const map = buildSourceToRenderedMap(source, container);

    // "Zeus" at source 5-8 → rendered 4-7
    expect(map.get(5)).toBe(4); // Z
    expect(map.get(8)).toBe(7); // s

    cleanup(container);
  });

  it('maps remaining source positions to end of rendered text', () => {
    // If source has trailing content that doesn't appear rendered
    const source = 'Hello\n\n---';
    const container = createContainer('<p>Hello</p><hr>');

    const map = buildSourceToRenderedMap(source, container);

    // "Hello" maps normally
    expect(map.get(0)).toBe(0);
    expect(map.get(4)).toBe(4);

    // Remaining source positions (newlines, ---) map to end of rendered text
    expect(map.get(5)).toBeDefined();

    cleanup(container);
  });
});

// ─── buildTextNodeIndex ─────────────────────────────────────────────────────

describe('buildTextNodeIndex', () => {
  it('builds index for single text node', () => {
    const container = createContainer('<p>Hello world</p>');

    const index = buildTextNodeIndex(container);

    expect(index.length).toBe(1);
    expect(index[0]!.start).toBe(0);
    expect(index[0]!.end).toBe(11);
    expect(index[0]!.node.textContent).toBe('Hello world');

    cleanup(container);
  });

  it('builds cumulative offsets across multiple text nodes', () => {
    const container = createContainer('<p>Hello <strong>Zeus</strong> world</p>');

    const index = buildTextNodeIndex(container);

    // Three text nodes: "Hello ", "Zeus", " world"
    expect(index.length).toBe(3);
    expect(index[0]!.start).toBe(0);
    expect(index[0]!.end).toBe(6);   // "Hello " = 6 chars
    expect(index[1]!.start).toBe(6);
    expect(index[1]!.end).toBe(10);  // "Zeus" = 4 chars
    expect(index[2]!.start).toBe(10);
    expect(index[2]!.end).toBe(16);  // " world" = 6 chars

    cleanup(container);
  });

  it('handles multiple paragraphs', () => {
    const container = createContainer('<p>First</p><p>Second</p>');

    const index = buildTextNodeIndex(container);

    expect(index.length).toBe(2);
    expect(index[0]!.start).toBe(0);
    expect(index[0]!.end).toBe(5);  // "First"
    expect(index[1]!.start).toBe(5);
    expect(index[1]!.end).toBe(11); // "Second"

    cleanup(container);
  });

  it('returns empty array for empty container', () => {
    const container = createContainer('');

    const index = buildTextNodeIndex(container);

    expect(index.length).toBe(0);

    cleanup(container);
  });
});

// ─── resolveAnnotationSpans ─────────────────────────────────────────────────

describe('resolveAnnotationSpans', () => {
  it('resolves a plain text annotation to rendered offsets', () => {
    const source = 'Zeus was the king of the gods.';
    const container = createContainer('<p>Zeus was the king of the gods.</p>');
    const offsetMap = buildSourceToRenderedMap(source, container);

    const annotations: OverlayAnnotation[] = [
      makeAnnotation({ id: 'ann-1', offset: 0, length: 4, exact: 'Zeus' }),
    ];

    const spans = resolveAnnotationSpans(annotations, offsetMap);

    expect(spans.length).toBe(1);
    expect(spans[0]!.start).toBe(0);
    expect(spans[0]!.end).toBe(4);
    expect(spans[0]!.annotation.id).toBe('ann-1');

    cleanup(container);
  });

  it('resolves annotation inside bold text to syntax-stripped offsets', () => {
    const source = 'The **Zeus** ruled.';
    const container = createContainer('<p>The <strong>Zeus</strong> ruled.</p>');
    const offsetMap = buildSourceToRenderedMap(source, container);

    const annotations: OverlayAnnotation[] = [
      makeAnnotation({ id: 'ann-1', offset: 6, length: 4, exact: 'Zeus' }),
    ];

    const spans = resolveAnnotationSpans(annotations, offsetMap);

    expect(spans.length).toBe(1);
    // Rendered: "The Zeus ruled." — "Zeus" at 4-8
    expect(spans[0]!.start).toBe(4);
    expect(spans[0]!.end).toBe(8);

    cleanup(container);
  });

  it('resolves multiple annotations in same paragraph', () => {
    const source = 'Zeus and Hera ruled.';
    const container = createContainer('<p>Zeus and Hera ruled.</p>');
    const offsetMap = buildSourceToRenderedMap(source, container);

    const annotations: OverlayAnnotation[] = [
      makeAnnotation({ id: 'ann-1', offset: 0, length: 4, exact: 'Zeus' }),
      makeAnnotation({ id: 'ann-2', offset: 9, length: 4, exact: 'Hera' }),
    ];

    const spans = resolveAnnotationSpans(annotations, offsetMap);

    expect(spans.length).toBe(2);
    expect(spans[0]!.start).toBe(0);
    expect(spans[0]!.end).toBe(4);
    expect(spans[1]!.start).toBe(9);
    expect(spans[1]!.end).toBe(13);

    cleanup(container);
  });

  it('skips annotations with unmapped offsets', () => {
    const source = 'Hello';
    const container = createContainer('<p>Hello</p>');
    const offsetMap = buildSourceToRenderedMap(source, container);

    const annotations: OverlayAnnotation[] = [
      makeAnnotation({ id: 'ann-1', offset: 100, length: 4, exact: 'nope' }),
    ];

    const spans = resolveAnnotationSpans(annotations, offsetMap);

    expect(spans.length).toBe(0);

    cleanup(container);
  });

  it('skips empty annotations', () => {
    const source = 'Hello';
    const container = createContainer('<p>Hello</p>');
    const offsetMap = buildSourceToRenderedMap(source, container);

    const spans = resolveAnnotationSpans(
      [makeAnnotation({ id: 'ann-1', offset: 2, length: 0 })],
      offsetMap,
    );

    expect(spans.length).toBe(0);

    cleanup(container);
  });
});

// ─── applyHighlights / clearHighlights ──────────────────────────────────────

describe('applyHighlights', () => {
  it('wraps a single-text-node span', () => {
    const container = createContainer('<p>Zeus was king.</p>');

    overlay('Zeus was king.', container, [
      makeAnnotation({ id: 'ann-1', offset: 0, length: 4, exact: 'Zeus', type: 'reference' }),
    ]);

    const span = container.querySelector('[data-annotation-id="ann-1"]');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('Zeus');
    expect(span!.className).toBe('annotation-reference');
    expect(span!.getAttribute('data-annotation-type')).toBe('reference');
    expect(container.textContent).toBe('Zeus was king.');

    cleanup(container);
  });

  it('applies correct CSS class per annotation type', () => {
    const container = createContainer('<p>Zeus Hera</p>');

    overlay('Zeus Hera', container, [
      makeAnnotation({ id: 'ann-1', offset: 0, length: 4, type: 'highlight' }),
      makeAnnotation({ id: 'ann-2', offset: 5, length: 4, type: 'assessment' }),
    ]);

    expect(container.querySelector('.annotation-highlight')!.textContent).toBe('Zeus');
    expect(container.querySelector('.annotation-assessment')!.textContent).toBe('Hera');
    expect(container.textContent).toBe('Zeus Hera');

    cleanup(container);
  });

  it('wraps an annotation crossing element boundaries as sibling spans', () => {
    const source = 'The **Zeus** ruled.';
    const container = createContainer('<p>The <strong>Zeus</strong> ruled.</p>');

    // "e Zeus ru" in rendered text: crosses into and out of the <strong>.
    overlay(source, container, [
      makeAnnotation({ id: 'ann-1', offset: 2, length: 13, exact: 'e **Zeus** ru' }),
    ]);

    const segments = container.querySelectorAll('[data-annotation-id="ann-1"]');
    expect(segments.length).toBe(3); // "e ", "Zeus", " ru"
    const joined = [...segments].map((s) => s.textContent).join('');
    expect(joined).toBe('e Zeus ru');
    expect(container.textContent).toBe('The Zeus ruled.');

    cleanup(container);
  });

  it('renders exact geometry for identical stacked annotations', () => {
    // The regression shape: repeated annotation of the same passage. The
    // Range-based predecessor let the first wrap corrupt the ranges of the
    // rest — later annotations collapsed to empty spans or swallowed whole
    // paragraphs. Offsets cannot be corrupted by DOM mutation.
    const container = createContainer('<p>Zeus was the king of the gods.</p>');

    overlay('Zeus was the king of the gods.', container, [
      makeAnnotation({ id: 'ann-1', offset: 0, length: 4, type: 'highlight' }),
      makeAnnotation({ id: 'ann-2', offset: 0, length: 4, type: 'highlight' }),
      makeAnnotation({ id: 'ann-3', offset: 0, length: 4, type: 'highlight' }),
    ]);

    for (const id of ['ann-1', 'ann-2', 'ann-3']) {
      const span = container.querySelector(`[data-annotation-id="${id}"]`);
      expect(span, id).not.toBeNull();
      expect(span!.textContent, id).toBe('Zeus');
    }
    expect(container.textContent).toBe('Zeus was the king of the gods.');

    cleanup(container);
  });

  it('renders partial overlap with per-region nesting, later annotation innermost', () => {
    const container = createContainer('<p>Zeus and Hera</p>');

    // ann-1 covers "Zeus and", ann-2 covers "and Hera" — overlap on "and".
    overlay('Zeus and Hera', container, [
      makeAnnotation({ id: 'ann-1', offset: 0, length: 8, type: 'highlight' }),
      makeAnnotation({ id: 'ann-2', offset: 5, length: 8, type: 'reference' }),
    ]);

    const ann1 = [...container.querySelectorAll('[data-annotation-id="ann-1"]')];
    const ann2 = [...container.querySelectorAll('[data-annotation-id="ann-2"]')];
    expect(ann1.map((s) => s.textContent).join('')).toBe('Zeus and');
    expect(ann2.map((s) => s.textContent).join('')).toBe('and Hera');

    // In the overlap region, the later-listed annotation is innermost: walking
    // up from "and" hits ann-2 (the reference) before ann-1.
    const overlapText = [...container.querySelectorAll('span')]
      .find((s) => s.textContent === 'and' && s.childNodes.length === 1 && s.firstChild!.nodeType === Node.TEXT_NODE)!;
    expect(overlapText.closest('[data-annotation-id]')!.getAttribute('data-annotation-id')).toBe('ann-2');
    expect(container.textContent).toBe('Zeus and Hera');

    cleanup(container);
  });

  it('mutates each annotated text node once, not once per annotation', () => {
    const container = createContainer('<p>Zeus was the king of the gods.</p>');
    const p = container.querySelector('p')!;
    let replaceCalls = 0;
    const origReplace = p.replaceChild.bind(p);
    p.replaceChild = ((n: Node, o: Node) => {
      replaceCalls++;
      return origReplace(n, o);
    }) as typeof p.replaceChild;

    overlay('Zeus was the king of the gods.', container, [
      makeAnnotation({ id: 'ann-1', offset: 0, length: 4 }),
      makeAnnotation({ id: 'ann-2', offset: 0, length: 4 }),
      makeAnnotation({ id: 'ann-3', offset: 9, length: 4 }),
    ]);

    expect(replaceCalls).toBe(1);

    cleanup(container);
  });
});

describe('clearHighlights', () => {
  it('removes annotation spans and restores original text', () => {
    const container = createContainer('<p>Zeus was king.</p>');

    overlay('Zeus was king.', container, [
      makeAnnotation({ id: 'ann-1', offset: 0, length: 4, exact: 'Zeus' }),
    ]);

    // Verify span exists
    expect(container.querySelector('[data-annotation-id]')).not.toBeNull();

    clearHighlights(container);

    // Span removed
    expect(container.querySelector('[data-annotation-id]')).toBeNull();
    // Text restored
    expect(container.textContent).toBe('Zeus was king.');

    cleanup(container);
  });

  it('handles multiple annotation spans', () => {
    const container = createContainer(
      '<p><span data-annotation-id="a1" data-annotation-type="highlight" class="annotation-highlight">Zeus</span> and <span data-annotation-id="a2" data-annotation-type="reference" class="annotation-reference">Hera</span></p>'
    );

    clearHighlights(container);

    expect(container.querySelectorAll('[data-annotation-id]').length).toBe(0);
    expect(container.textContent).toBe('Zeus and Hera');

    cleanup(container);
  });

  it('unwraps nested overlap spans', () => {
    const container = createContainer('<p>Zeus was king.</p>');

    overlay('Zeus was king.', container, [
      makeAnnotation({ id: 'ann-1', offset: 0, length: 8 }),
      makeAnnotation({ id: 'ann-2', offset: 5, length: 8 }),
    ]);

    clearHighlights(container);

    expect(container.querySelectorAll('[data-annotation-id]').length).toBe(0);
    expect(container.textContent).toBe('Zeus was king.');

    cleanup(container);
  });

  it('merges adjacent text nodes after clearing', () => {
    const container = createContainer('<p>Hello <span data-annotation-id="a1">world</span> end</p>');

    clearHighlights(container);

    // After normalize(), "Hello ", "world", and " end" should merge into one text node
    const p = container.querySelector('p')!;
    expect(p.childNodes.length).toBe(1);
    expect(p.firstChild!.textContent).toBe('Hello world end');

    cleanup(container);
  });
});

// ─── End-to-end: offset map → resolve → apply → clear ──────────────────────

describe('end-to-end overlay pipeline', () => {
  beforeEach(() => {
    // Clean up any leftover containers
    document.body.innerHTML = '';
  });

  it('annotates plain text and cleans up', () => {
    const source = 'Zeus was the king of the gods.';
    const container = createContainer('<p>Zeus was the king of the gods.</p>');

    overlay(source, container, [
      makeAnnotation({ id: 'ann-1', offset: 0, length: 4, exact: 'Zeus', type: 'reference' }),
    ]);

    // Verify annotation applied
    const span = container.querySelector('[data-annotation-id="ann-1"]');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('Zeus');
    expect(span!.className).toBe('annotation-reference');

    // Clear and verify restoration
    clearHighlights(container);
    expect(container.querySelector('[data-annotation-id]')).toBeNull();
    expect(container.textContent).toBe('Zeus was the king of the gods.');

    cleanup(container);
  });

  it('annotates text inside bold markdown', () => {
    const source = 'The **Zeus** ruled.';
    const container = createContainer('<p>The <strong>Zeus</strong> ruled.</p>');

    overlay(source, container, [
      makeAnnotation({ id: 'ann-1', offset: 6, length: 4, exact: 'Zeus', type: 'highlight' }),
    ]);

    const span = container.querySelector('[data-annotation-id="ann-1"]');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('Zeus');

    cleanup(container);
  });

  it('handles multiple annotations across paragraphs', () => {
    const source = 'Zeus ruled.\n\nHera was queen.';
    const container = createContainer('<p>Zeus ruled.</p><p>Hera was queen.</p>');

    overlay(source, container, [
      makeAnnotation({ id: 'ann-1', offset: 0, length: 4, exact: 'Zeus', type: 'reference' }),
      makeAnnotation({ id: 'ann-2', offset: 13, length: 4, exact: 'Hera', type: 'highlight' }),
    ]);

    expect(container.querySelector('[data-annotation-id="ann-1"]')!.textContent).toBe('Zeus');
    expect(container.querySelector('[data-annotation-id="ann-2"]')!.textContent).toBe('Hera');

    clearHighlights(container);
    expect(container.querySelectorAll('[data-annotation-id]').length).toBe(0);

    cleanup(container);
  });

  it('handles multiple occurrences of the same word', () => {
    const source = 'Zeus loved Zeus.';
    const container = createContainer('<p>Zeus loved Zeus.</p>');

    overlay(source, container, [
      makeAnnotation({ id: 'ann-1', offset: 0, length: 4, exact: 'Zeus', type: 'reference' }),
      makeAnnotation({ id: 'ann-2', offset: 11, length: 4, exact: 'Zeus', type: 'highlight' }),
    ]);

    const spans = container.querySelectorAll('[data-annotation-id]');
    expect(spans.length).toBe(2);
    expect(spans[0]!.textContent).toBe('Zeus');
    expect(spans[1]!.textContent).toBe('Zeus');
    expect(spans[0]!.getAttribute('data-annotation-id')).toBe('ann-1');
    expect(spans[1]!.getAttribute('data-annotation-id')).toBe('ann-2');

    cleanup(container);
  });
});
