/**
 * BUG: browse-view-overlay-misses-async-content — the overlay effect must be
 * keyed on everything it reads: the rendered content DOM AND the annotations.
 *
 * When annotations arrive BEFORE content (any host loading content async —
 * useResourceContent), the overlay resolved ranges against the empty document
 * and never re-ran when content landed: rendered text, ZERO spans, healed only
 * by a remount. When content arrives first (sync-content hosts), it worked by
 * accident of ordering. Both orders are pinned here, plus shrink-to-zero.
 *
 * REAL overlay pipeline (no annotation-overlay mocks) — react-markdown is
 * mocked to identity, so the source→rendered offset map is 1:1 and spans
 * paint in jsdom via the actual Range/surroundContents path.
 *
 * Started RED (async order → 0 spans) → GREEN with the single keyed effect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { Annotation, AnnotationId } from '@semiont/core';
import { BrowseView } from '../BrowseView';

vi.mock('../../annotation/AnnotateToolbar', () => ({ AnnotateToolbar: () => null }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));

const CONTENT = 'hello world selectme end';

function fakeSession(): SemiontSession {
  return {
    client: { browse: { click: vi.fn() }, beckon: { hover: vi.fn() } },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

/** A resolved reference over "world" (offsets 6..11) — real W3C shape. */
function referenceOnWorld(): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    id: 'ref-world' as AnnotationId,
    type: 'Annotation',
    motivation: 'linking',
    creator: { '@type': 'Person', name: 'user@example.com' },
    created: '2026-07-10T00:00:00Z',
    target: {
      source: 'res-1',
      selector: { type: 'TextPositionSelector', start: 6, end: 11 },
    },
  } as unknown as Annotation;
}

const emptyAnnotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };
const withReference = { ...emptyAnnotations, references: [referenceOnWorld()] };

const baseProps = {
  mimeType: 'text/plain',
  resourceUri: 'res-1',
  annotateMode: false,
};

const spans = (c: HTMLElement) => c.querySelectorAll('[data-annotation-id]');

describe('BrowseView — overlay vs async content arrival', () => {
  beforeEach(() => vi.clearAllMocks());

  it('paints spans when content arrives AFTER annotations (the async-content bug)', () => {
    const session = fakeSession();
    const { container, rerender } = render(
      <BrowseView {...baseProps} content="" annotations={withReference} session={session} />,
    );
    expect(spans(container)).toHaveLength(0); // nothing to anchor on yet

    // Content lands (useResourceContent resolved) — annotations unchanged.
    rerender(
      <BrowseView {...baseProps} content={CONTENT} annotations={withReference} session={session} />,
    );

    expect(spans(container)).toHaveLength(1);
    expect(spans(container)[0]!.textContent).toBe('world');
    expect(spans(container)[0]!.getAttribute('data-annotation-type')).toBe('reference');
  });

  it('paints spans when annotations arrive AFTER content (the always-working order — pinned)', () => {
    const session = fakeSession();
    const { container, rerender } = render(
      <BrowseView {...baseProps} content={CONTENT} annotations={emptyAnnotations} session={session} />,
    );
    expect(spans(container)).toHaveLength(0);

    rerender(
      <BrowseView {...baseProps} content={CONTENT} annotations={withReference} session={session} />,
    );

    expect(spans(container)).toHaveLength(1);
    expect(spans(container)[0]!.textContent).toBe('world');
  });

  it('clears spans when annotations shrink to zero', () => {
    const session = fakeSession();
    const { container, rerender } = render(
      <BrowseView {...baseProps} content={CONTENT} annotations={withReference} session={session} />,
    );
    expect(spans(container)).toHaveLength(1);

    rerender(
      <BrowseView {...baseProps} content={CONTENT} annotations={emptyAnnotations} session={session} />,
    );

    expect(spans(container)).toHaveLength(0);
    expect(container.textContent).toContain(CONTENT); // text restored intact
  });
});
