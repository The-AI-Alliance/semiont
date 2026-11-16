/**
 * GATHER-EVIDENCE-PANES D10 (amended 2026-08-19) — `SearchResultsStep` is pure
 * RESULTS: ranked rows with scores and Link buttons, nothing else.
 *
 * The evidence lives with the HOST: the wizard stacks the full display-only
 * `GatherContextStep` (quotation, graph pane, corpus pane, collapsed strategy
 * band) above this step, exactly as on the configure steps. The original D10
 * concern — corpus matches beside real results reading as a second, staler
 * ranking — dissolved with the stacking: evidence sits above the strategy
 * band, results below it, no competing side-by-side columns. This step
 * therefore renders NO context of its own; a gather pane appearing here means
 * someone re-embedded the minimal context redux this amendment deleted.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SearchResultsStep } from '../SearchResultsStep';

const T = { noResults: 'None', score: 'Score', link: 'Link', back: 'Back' };

const RESULTS = [
  { '@id': 'r1', name: 'Martin Pauls', score: 57.46, matchReason: 'connected; semantic match' },
  { '@id': 'r2', name: 'Arthur Fisher', score: 25.46, description: 'a citing resource' },
] as never[];

describe('SearchResultsStep — pure results (D10 amended)', () => {
  it('renders ranked rows: name, score, reason, and a Link button each', () => {
    render(
      <SearchResultsStep results={RESULTS} onBack={vi.fn()} onLink={vi.fn()} translations={T} />,
    );
    expect(screen.getByText('Martin Pauls')).toBeInTheDocument();
    expect(screen.getByText(`${T.score}: 57.46`)).toBeInTheDocument();
    expect(screen.getByText('connected; semantic match')).toBeInTheDocument();
    expect(screen.getByText('a citing resource')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: `🔗 ${T.link}` })).toHaveLength(2);
  });

  it('links the row that was clicked, by @id', () => {
    const onLink = vi.fn();
    render(
      <SearchResultsStep results={RESULTS} onBack={vi.fn()} onLink={onLink} translations={T} />,
    );
    screen.getAllByRole('button', { name: `🔗 ${T.link}` })[1]!.click();
    expect(onLink).toHaveBeenCalledWith('r2');
  });

  it('shows the empty state when nothing matched', () => {
    render(
      <SearchResultsStep results={[]} onBack={vi.fn()} onLink={vi.fn()} translations={T} />,
    );
    expect(screen.getByText(T.noResults)).toBeInTheDocument();
  });

  it('renders no context of its own — the host owns the evidence', () => {
    const { container } = render(
      <SearchResultsStep results={RESULTS} onBack={vi.fn()} onLink={vi.fn()} translations={T} />,
    );
    expect(container.querySelector('.semiont-gather-pane')).toBeNull();
    expect(container.querySelector('.semiont-search-results__two-pane')).toBeNull();
  });
});
