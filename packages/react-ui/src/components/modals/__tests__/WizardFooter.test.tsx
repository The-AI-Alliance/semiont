/**
 * WIZARD-NAVIGATION P1 — one dismissal, one retreat, one advance.
 *
 * The wizard used to offer four ways out of one step (corner ✕, Esc, backdrop, and a
 * footer `✕ Cancel`) and none at all on the step that starts the flow. D1 settled it:
 * the corner control plus Esc and backdrop are the dismissal, and the footer is purely
 * flow — where you came from, where you are going.
 *
 * These assert STRUCTURE, never copy: labels arrive as props and will be revised.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { WizardFooter } from '../WizardFooter';
import { ConfigureSearchStep } from '../ConfigureSearchStep';
import { ConfigureGenerationStep } from '../ConfigureGenerationStep';
import { SearchResultsStep } from '../SearchResultsStep';
import type { GatheredContext } from '@semiont/core';

/** Anything that reads as "get me out of here" belongs in the corner, not the footer. */
const DISMISSAL = /cancel|close|dismiss|✕|✖|×/i;

const footerOf = (container: HTMLElement) =>
  container.querySelector('.semiont-modal__actions') as HTMLElement | null;

const buttonsIn = (footer: HTMLElement) => Array.from(footer.querySelectorAll('button'));

describe('WizardFooter', () => {
  it('renders retreat and advance, and nothing that dismisses', () => {
    const { container } = render(
      <WizardFooter
        backLabel="Back"
        onBack={vi.fn()}
        primary={{ label: 'Search', type: 'submit' }}
      />,
    );
    const footer = footerOf(container)!;
    const labels = buttonsIn(footer).map((b) => b.textContent ?? '');
    expect(labels).toHaveLength(2);
    expect(labels.filter((l) => DISMISSAL.test(l))).toEqual([]);
  });

  it('omits Back entirely when there is nowhere to go back to', () => {
    const { container } = render(
      <WizardFooter primary={{ label: 'Search', type: 'submit' }} />,
    );
    expect(buttonsIn(footerOf(container)!)).toHaveLength(1);
  });

  it('renders Back alone when the step has no footer-level action', () => {
    // Search results: the action is per row, so the footer carries retreat only.
    const { container } = render(<WizardFooter backLabel="Back" onBack={vi.fn()} />);
    const labels = buttonsIn(footerOf(container)!).map((b) => b.textContent);
    expect(labels).toEqual(['◀ Back']);
  });

  it('does not stretch its buttons to equal width', () => {
    // `--flex` made retreat and advance read as peers. Retreat is chrome.
    const { container } = render(
      <WizardFooter backLabel="Back" onBack={vi.fn()} primary={{ label: 'Go', type: 'button', onClick: vi.fn() }} />,
    );
    for (const button of buttonsIn(footerOf(container)!)) {
      expect(button.className).not.toContain('semiont-button--flex');
    }
  });

  it('a pending primary disables itself and Back, and says so', async () => {
    const onBack = vi.fn();
    render(
      <WizardFooter
        backLabel="Back"
        onBack={onBack}
        primary={{ label: 'Search', pendingLabel: 'Searching…', pending: true, type: 'submit' }}
      />,
    );
    expect(screen.getByText(/Searching…/)).toBeInTheDocument();
    await userEvent.click(screen.getByText(/Back/));
    expect(onBack).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// The same rule, asserted against the real steps — a footer component is
// only worth having if every step actually uses it.
// ─────────────────────────────────────────────────────────────────────
const SEARCH_T = {
  maxResults: 'Max Results', semanticScoring: 'Semantic Scoring',
  semanticScoringHelp: 'help', back: 'Back', search: 'Search', searching: 'Searching…',
};

const GEN_T = {
  resourceTitle: 'Title', resourceTitlePlaceholder: '', additionalInstructions: 'Instructions',
  additionalInstructionsPlaceholder: '', language: 'Language', languageHelp: '',
  creativity: 'Creativity', creativityFocused: 'Focused', creativityCreative: 'Creative',
  maxLength: 'Max Length', maxLengthHelp: '', maxLengthCeiling: 'Limited to {{max}} by {{model}}.',
  back: 'Back', generate: 'Generate',
};

const CONTEXT_T = {
  sourceContextLabel: 'Source', connectionsLabel: 'Connections', citedByLabel: 'Cited by',
  userHintLabel: 'Hint', userHintPlaceholder: '',
};

const RESULTS_T = { noResults: 'None', score: 'Score', link: 'Link', back: 'Back', ...CONTEXT_T };

const CONTEXT = {
  focus: { kind: 'annotation', annotation: { id: 'a1' }, sourceResource: { id: 'r1', name: 'Src' } },
  // `graph` is not optional in practice: ContextSummary hands it straight to
  // `deriveViews`, which dereferences `.nodes`.
  graph: { nodes: [], edges: [] },
} as unknown as GatheredContext;

describe('every step footer follows the grammar (A1, A2)', () => {
  it('ConfigureSearchStep', () => {
    const { container } = render(
      <ConfigureSearchStep
        config={{ limit: 10, useSemanticScoring: true }}
        onConfigChange={vi.fn()}
        onBack={vi.fn()}
        onSearch={vi.fn()}
        translations={SEARCH_T}
      />,
    );
    const labels = buttonsIn(footerOf(container)!).map((b) => b.textContent ?? '');
    expect(labels).toHaveLength(2);
    expect(labels.filter((l) => DISMISSAL.test(l))).toEqual([]);
  });

  it('SearchResultsStep — footer is retreat only; Link lives on the rows', () => {
    const { container } = render(
      <SearchResultsStep
        context={CONTEXT}
        results={[{ id: 'r1', name: 'Black Sea', score: 54.22 } as never]}
        onBack={vi.fn()}
        onLink={vi.fn()}
        translations={RESULTS_T}
      />,
    );
    const labels = buttonsIn(footerOf(container)!).map((b) => b.textContent ?? '');
    expect(labels).toHaveLength(1);
    expect(labels.filter((l) => DISMISSAL.test(l))).toEqual([]);
    expect(screen.getByText(/Link/)).toBeInTheDocument();
  });

  it('ConfigureGenerationStep', () => {
    const { container } = render(
      <ConfigureGenerationStep
        context={CONTEXT}
        config={{
          title: 'Caspian Sea', storagePath: '', prompt: '', language: 'en',
          temperature: 0.7, maxTokensText: '500',
        }}
        onConfigChange={vi.fn()}
        onBack={vi.fn()}
        onGenerate={vi.fn()}
        translations={GEN_T}
      />,
    );
    const labels = buttonsIn(footerOf(container)!).map((b) => b.textContent ?? '');
    expect(labels).toHaveLength(2);
    expect(labels.filter((l) => DISMISSAL.test(l))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// WIZARD-NAVIGATION P3 — the exits, pinned.
//
// HeadlessUI already wires Esc and the backdrop to `onClose`; these are the
// guard, not the fix. What they prevent is a later change that "improves" Esc
// into a step-back, or that disables the way out while a request is in flight.
// ─────────────────────────────────────────────────────────────────────
describe('the way out (A4, A5)', () => {
  it('a pending step never disables the corner control — only the footer', () => {
    // D5: dismissal must survive a search that never returns. The footer's own
    // buttons DO disable (pressing Search twice is not a feature); the corner is
    // not the footer's to disable, which is why it does not live there.
    const { container } = render(
      <ConfigureSearchStep
        config={{ limit: 10, useSemanticScoring: true }}
        onConfigChange={vi.fn()}
        isSearching
        onBack={vi.fn()}
        onSearch={vi.fn()}
        translations={SEARCH_T}
      />,
    );
    const footer = footerOf(container)!;
    for (const button of buttonsIn(footer)) expect(button).toBeDisabled();
    // …and the step renders no dismissal of its own to be disabled with them.
    expect(buttonsIn(footer).map((b) => b.textContent ?? '').filter((l) => DISMISSAL.test(l))).toEqual([]);
  });

  it('Back does not fire while the step is pending', async () => {
    const onBack = vi.fn();
    render(
      <ConfigureSearchStep
        config={{ limit: 10, useSemanticScoring: true }}
        onConfigChange={vi.fn()}
        isSearching
        onBack={onBack}
        onSearch={vi.fn()}
        translations={SEARCH_T}
      />,
    );
    await userEvent.click(screen.getByText(/Back/));
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe('Back is lossless (A3)', () => {
  it('the step reflects the wizard-owned draft, so remounting restores it', () => {
    // The regression this replaces: `useState` inside the step meant stepping
    // back unmounted it and every choice reverted to the default.
    const config = { limit: 20, useSemanticScoring: false };
    const { unmount } = render(
      <ConfigureSearchStep
        config={config} onConfigChange={vi.fn()} onBack={vi.fn()} onSearch={vi.fn()}
        translations={SEARCH_T}
      />,
    );
    expect((screen.getByLabelText('Max Results') as HTMLSelectElement).value).toBe('20');
    unmount();

    // Same draft, fresh mount — what "Back then forward" does.
    render(
      <ConfigureSearchStep
        config={config} onConfigChange={vi.fn()} onBack={vi.fn()} onSearch={vi.fn()}
        translations={SEARCH_T}
      />,
    );
    expect((screen.getByLabelText('Max Results') as HTMLSelectElement).value).toBe('20');
    expect((screen.getByLabelText(/Semantic Scoring/) as HTMLInputElement).checked).toBe(false);
  });
});
