/**
 * GATHER-EVIDENCE-PANES D10 — `SearchResultsStep` inherits whatever
 * `ContextSummary` becomes, and the boundary is structural:
 *
 * - the GRAPH pane travels with the component (richer context reminder), but
 * - the CORPUS pane must never appear here — on search-results the user has
 *   already chosen Search, and a pane of semantic matches beside the actual
 *   results would be a second, staler ranking of nearly the same question.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { GatheredContext } from '@semiont/core';
import { SearchResultsStep } from '../SearchResultsStep';

const T = {
  noResults: 'None', score: 'Score', link: 'Link', back: 'Back',
  sourceContextLabel: 'Source', connectionsLabel: 'Connections', citedByLabel: 'Cited by',
  graphPaneTitle: 'In the graph',
  graphEmpty: 'No links yet — resolving this reference creates the first.',
};

const CONTEXT = {
  focus: {
    kind: 'annotation',
    annotation: { id: 'a1' },
    sourceResource: { id: 'r1', name: 'Src' },
  },
  graph: { nodes: [], edges: [] },
  // The corpus data is PRESENT in the context — the pin is that this step
  // deliberately does not render it.
  semanticContext: {
    similar: [{ text: 'p', resourceId: 'r2', resourceName: 'Elsewhere', score: 0.9 }],
  },
} as unknown as GatheredContext;

describe('SearchResultsStep — the D10 boundary', () => {
  it('renders the enriched graph pane, and NO corpus pane', () => {
    const { container } = render(
      <SearchResultsStep
        context={CONTEXT}
        results={[]}
        onBack={vi.fn()}
        onLink={vi.fn()}
        translations={T}
      />,
    );
    expect(container.querySelector('.semiont-gather-pane--graph')).not.toBeNull();
    expect(container.querySelector('.semiont-gather-pane--corpus')).toBeNull();
    expect(container.querySelector('.semiont-corpus__card')).toBeNull();
  });
});
