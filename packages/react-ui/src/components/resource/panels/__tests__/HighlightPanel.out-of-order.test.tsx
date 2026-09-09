/**
 * DETECTION-RESULT-STREAMING P3: out-of-order arrival renders correctly.
 *
 * P1 made detection commit per chunk, and units run concurrently — so the
 * annotations array now grows in bursts whose document positions interleave:
 * chunk 2's finds can arrive before chunk 1's. The panel's contract is that
 * LIST ORDER IS DOCUMENT ORDER (sort by TextPositionSelector.start), so
 * arrival order must be invisible in the rendered list — both for a scrambled
 * initial load and for a late-arriving EARLIER-position insert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderWithProviders, createTestSemiontWrapper } from '../../../../test-utils';
import { HighlightPanel } from '../HighlightPanel';
import type { SemiontSession } from '@semiont/sdk';
import type { Annotation, AnnotationId } from '@semiont/core';

const mockT = vi.fn((key: string) => key);
vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: () => mockT,
  TranslationProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../../../contexts/useEventSubscription', () => ({
  useEventSubscriptions: vi.fn(),
}));

function highlightAt(id: string, start: number, exact: string): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: id as AnnotationId,
    motivation: 'highlighting',
    target: {
      source: 'resource-1',
      selector: [
        { type: 'TextPositionSelector', start, end: start + exact.length },
        { type: 'TextQuoteSelector', exact },
      ],
    },
    created: '2024-01-01T00:00:00Z',
  };
}

function renderedQuotes(): string[] {
  return Array.from(document.querySelectorAll('.semiont-annotation-entry__quote'))
    .map((el) => el.textContent?.replace(/^"|"$/g, '').trim() ?? '');
}

describe('HighlightPanel — arrival order is invisible; list order is document order', () => {
  let session: SemiontSession;
  beforeEach(() => {
    vi.clearAllMocks();
    ({ session } = createTestSemiontWrapper());
  });

  it('a scrambled initial load (concurrent units) renders in document order', () => {
    renderWithProviders(
      <HighlightPanel session={session} resourceId="res-1"
        annotations={[
          highlightAt('h-chunk3', 900, 'gamma'),
          highlightAt('h-chunk1', 100, 'alpha'),
          highlightAt('h-chunk2', 500, 'beta'),
        ]}
        pendingAnnotation={null}
        isAssisting={false}
        progress={null}
        annotateMode={true}
      />,
    );

    expect(renderedQuotes()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('an earlier-position annotation arriving LATE slots into place, not onto the end', () => {
    const { rerender } = renderWithProviders(
      <HighlightPanel session={session} resourceId="res-1"
        annotations={[highlightAt('h-late-chunk', 700, 'omega')]}
        pendingAnnotation={null}
        isAssisting={false}
        progress={null}
        annotateMode={true}
      />,
    );
    expect(renderedQuotes()).toEqual(['omega']);

    // Chunk 1's find lands after chunk 2's — the out-of-order insert.
    rerender(
      <HighlightPanel session={session} resourceId="res-1"
        annotations={[highlightAt('h-late-chunk', 700, 'omega'), highlightAt('h-early-chunk', 50, 'alpha')]}
        pendingAnnotation={null}
        isAssisting={false}
        progress={null}
        annotateMode={true}
      />,
    );

    expect(renderedQuotes()).toEqual(['alpha', 'omega']);
  });
});
