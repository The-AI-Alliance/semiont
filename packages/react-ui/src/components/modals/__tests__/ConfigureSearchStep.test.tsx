/**
 * The search step is CONTROLLED (WIZARD-NAVIGATION D3) — the wizard owns
 * `limit` and `useSemanticScoring` so stepping Back cannot discard them.
 *
 * That makes these tests about the contract rather than the widget: every edit
 * must reach `onConfigChange` (an uncontrolled field would appear to work and
 * silently revert on Back), and submit must send the CURRENT config rather than
 * a stale copy.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { ConfigureSearchStep, type SearchConfig } from '../ConfigureSearchStep';

const T = {
  maxResults: 'Max Results', semanticScoring: 'Semantic Scoring',
  semanticScoringHelp: 'Use AI to score results by semantic relevance',
  back: 'Back', search: 'Search', searching: 'Searching…',
};

const CONFIG: SearchConfig = { limit: 10, useSemanticScoring: true };

function renderStep(config: SearchConfig = CONFIG) {
  const onConfigChange = vi.fn();
  const onSearch = vi.fn();
  const onBack = vi.fn();
  render(
    <ConfigureSearchStep
      config={config}
      onConfigChange={onConfigChange}
      onBack={onBack}
      onSearch={onSearch}
      translations={T}
    />,
  );
  return { onConfigChange, onSearch, onBack };
}

describe('ConfigureSearchStep', () => {
  it('reports a new result limit to the owner rather than keeping it', async () => {
    const { onConfigChange } = renderStep();
    await userEvent.selectOptions(screen.getByLabelText(T.maxResults), '20');
    expect(onConfigChange).toHaveBeenCalledWith({ limit: 20, useSemanticScoring: true });
  });

  it('reports the semantic-scoring toggle the same way', async () => {
    const { onConfigChange } = renderStep();
    await userEvent.click(screen.getByLabelText(new RegExp(T.semanticScoring)));
    expect(onConfigChange).toHaveBeenCalledWith({ limit: 10, useSemanticScoring: false });
  });

  it('submits whatever the owner currently holds, not a default', async () => {
    // The point of controlled state: a step that kept its own copy could submit
    // something the wizard never saw.
    const { onSearch } = renderStep({ limit: 5, useSemanticScoring: false });
    await userEvent.click(screen.getByRole('button', { name: T.search }));
    expect(onSearch).toHaveBeenCalledWith({ limit: 5, useSemanticScoring: false });
  });

  it('renders the owner\'s values, so Back-then-forward shows them again', () => {
    renderStep({ limit: 20, useSemanticScoring: false });
    expect((screen.getByLabelText(T.maxResults) as HTMLSelectElement).value).toBe('20');
    expect((screen.getByLabelText(new RegExp(T.semanticScoring)) as HTMLInputElement).checked).toBe(false);
  });

  it('retreats when Back is pressed', async () => {
    const { onBack } = renderStep();
    await userEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
