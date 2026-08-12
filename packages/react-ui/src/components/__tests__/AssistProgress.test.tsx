/**
 * AssistProgress (#7) — the ONE job-progress renderer, unifying the three
 * previous shapes (AssistSection's inline block, AnnotateReferencesProgressWidget,
 * TaggingPanel's inline block) plus the resource-generate flow.
 *
 * Contract: presentational and provider-free — no SemiontProvider, no session;
 * cancel/dismiss arrive as callbacks the caller wires (job.cancelRequest /
 * mark.dismissProgress). Feature blocks are data-presence-driven so each call
 * site keeps its current visuals by passing what it always had.
 *
 * i18n contract (ASSIST-SURFACE-WARTS Lane A): every string this component
 * renders comes from `translations`. There are NO English fallbacks — a
 * missing key must be a type error at the call site, not a silent English
 * leak in a Japanese UI. Tests use key-echo strings ('tr.complete') so an
 * assertion failing means "rendered something other than what was passed".
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import type { components } from '@semiont/core';
import { AssistProgress, type AssistProgressTranslations } from '../AssistProgress';

type JobProgress = components['schemas']['JobProgress'];

const running = (over: Partial<JobProgress> = {}): JobProgress => ({
  stage: 'analyzing', percentage: 40, ...over,
});

/** Every required key, echoing its own name; override per test. */
const T = (over: Partial<AssistProgressTranslations> = {}): AssistProgressTranslations => ({
  cancel: 'tr.cancel',
  inProgress: 'tr.inProgress',
  complete: 'tr.complete',
  failed: 'tr.failed',
  close: 'tr.close',
  paramsTitle: 'tr.paramsTitle',
  processing: (label: string) => `tr.processing(${label})`,
  ...over,
});

describe('AssistProgress', () => {
  it('renders provider-free: status line, params, and data hooks', () => {
    const { container } = render(
      <AssistProgress
        progress={running({ requestParams: [{ label: 'Density', value: '5' }] })}
        dataType="comment"
        translations={T()}
      />,
    );
    expect(screen.getByText('tr.inProgress')).toBeInTheDocument();
    expect(screen.getByText(/Density/)).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    const root = container.querySelector('.semiont-annotation-progress');
    expect(root).toHaveAttribute('data-type', 'comment');
    expect(root).toHaveAttribute('data-status', 'analyzing');
  });

  it('renders the request-parameters title from translations, never a literal', () => {
    render(
      <AssistProgress
        progress={running({ requestParams: [{ label: 'Density', value: '5' }] })}
        dataType="comment"
        translations={T()}
      />,
    );
    expect(screen.getByText('tr.paramsTitle')).toBeInTheDocument();
    expect(screen.queryByText('Request Parameters:')).not.toBeInTheDocument();
  });

  it('renders a title header only when given one', () => {
    const { rerender } = render(
      <AssistProgress progress={running()} dataType="reference" translations={T({ title: 'Annotating Entity References' })} />,
    );
    expect(screen.getByText('Annotating Entity References')).toBeInTheDocument();
    rerender(<AssistProgress progress={running()} dataType="comment" translations={T()} />);
    expect(screen.queryByText('Annotating Entity References')).not.toBeInTheDocument();
  });

  it('shows cancel in the header while running, hides it once complete', async () => {
    // Cancel lives in the title header — both flows that offer cancel
    // (reference detection, generation) render the titled profile.
    const onCancel = vi.fn();
    const tr = T({ title: 'Generating Resource', cancel: 'Cancel Job' });
    const { rerender } = render(
      <AssistProgress progress={running()} dataType="generation" onCancel={onCancel} translations={tr} />,
    );
    await userEvent.click(screen.getByTitle('Cancel Job'));
    expect(onCancel).toHaveBeenCalledOnce();
    rerender(
      <AssistProgress progress={running({ stage: 'complete' })} dataType="generation" onCancel={onCancel} translations={tr} />,
    );
    expect(screen.queryByTitle('Cancel Job')).not.toBeInTheDocument();
    // Error is terminal too — offering cancel on a dead job is misleading and
    // invites redundant cancel requests.
    rerender(
      <AssistProgress progress={running({ stage: 'error' })} dataType="generation" onCancel={onCancel} translations={tr} />,
    );
    expect(screen.queryByTitle('Cancel Job')).not.toBeInTheDocument();
  });

  it('stage branching: terminal stages render the translated copy, never wire prose', () => {
    // The wire no longer carries a sentence — `message` is a code + typed
    // params, and rendering it is P3's work. Until then both terminal stages
    // render the client's own translated copy, unconditionally.
    const { rerender } = render(
      <AssistProgress progress={running({ stage: 'complete' })} dataType="reference" translations={T({ complete: 'All done!' })} />,
    );
    expect(screen.getByText('All done!')).toBeInTheDocument();
    rerender(
      <AssistProgress progress={running({ stage: 'error' })} dataType="reference" translations={T({ failed: 'Failed' })} />,
    );
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('renders the completed entity-type log when data + formatter are present', () => {
    render(
      <AssistProgress
        progress={running({ completedEntityTypes: [{ entityType: 'Person', foundCount: 3 }] })}
        dataType="reference" translations={T({ found: (n) => `Found ${n}` })}
      />,
    );
    expect(screen.getByText('Person:')).toBeInTheDocument();
    expect(screen.getByText('Found 3')).toBeInTheDocument();
  });

  it('renders the current-work detail line: entity type via formatter, category with counts', () => {
    const { rerender } = render(
      <AssistProgress
        progress={running({ currentEntityType: 'Location' })}
        dataType="reference" translations={T({ current: (l) => `Current: ${l}` })}
      />,
    );
    // getAllByText: with no wire prose, the status line falls back to the
    // same currentLabel the detail line renders — defect 1's duplicate,
    // visible in tests now that fixtures carry no message. P3 deletes it
    // (ASSIST-PROGRESS-CONSOLIDATION A1).
    expect(screen.getAllByText('Current: Location').length).toBeGreaterThan(0);
    rerender(
      <AssistProgress
        progress={running({ currentCategory: 'Rule', processedCategories: 2, totalCategories: 5 })}
        dataType="tag" translations={T()}
      />,
    );
    expect(screen.getByText(/Rule/)).toBeInTheDocument();
    expect(screen.getByText(/2\/5/)).toBeInTheDocument();
  });

  it('falls back to the generic processing formatter — never the English literal', () => {
    // The reference flow passes its own `current` wording; every other flow
    // (tag categories, and any flow without one) uses `processing`. Neither
    // path may render a hardcoded "Processing: ".
    const { rerender } = render(
      <AssistProgress progress={running({ currentEntityType: 'Location' })} dataType="reference" translations={T()} />,
    );
    // getAllByText: same defect-1 duplicate as above; A1 (P3) collapses it.
    expect(screen.getAllByText('tr.processing(Location)').length).toBeGreaterThan(0);
    rerender(
      <AssistProgress progress={running({ currentCategory: 'Rule' })} dataType="tag" translations={T()} />,
    );
    expect(screen.getByText(/tr\.processing\(Rule\)/)).toBeInTheDocument();
    expect(screen.queryByText(/^Processing: /)).not.toBeInTheDocument();
  });

  it('renders the percentage bar only when opted in', () => {
    const { container, rerender } = render(
      <AssistProgress progress={running({ percentage: 40 })} dataType="tag" showPercentBar translations={T()} />,
    );
    const fill = container.querySelector('.semiont-progress-bar__fill');
    expect(fill).toBeInTheDocument();
    expect(fill).toHaveStyle({ width: '40%' });
    rerender(
      <AssistProgress progress={running({ percentage: 40 })} dataType="reference" translations={T()} />,
    );
    expect(container.querySelector('.semiont-progress-bar__fill')).not.toBeInTheDocument();
  });

  it('cancel and dismiss take their accessible names from translations', () => {
    // ✕ / × glyphs alone are meaningless to screen readers, and an English
    // fallback is meaningless to a non-English reader. The labels are
    // required keys, so there is nothing to fall back TO.
    render(
      <AssistProgress progress={running()} dataType="generation"
        onCancel={vi.fn()} onDismiss={vi.fn()}
        translations={T({ title: 'Generating' })} />,
    );
    expect(screen.getByLabelText('tr.cancel')).toBeInTheDocument();
    expect(screen.getByLabelText('tr.close')).toBeInTheDocument();
    expect(screen.queryByLabelText('Cancel')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Dismiss')).not.toBeInTheDocument();
  });


  it('renders dismiss whenever the caller offers it (WHEN is the caller\'s policy)', async () => {
    // AssistShell withholds onDismiss while the assist is running — that
    // gate is pinned in AssistShell.test; here the contract is just
    // "callback present → affordance rendered".
    const onDismiss = vi.fn();
    const { rerender } = render(
      <AssistProgress progress={running()} dataType="highlight" translations={T({ close: 'Close' })} />,
    );
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
    rerender(
      <AssistProgress progress={running()} dataType="highlight"
        onDismiss={onDismiss} translations={T({ close: 'Close' })} />,
    );
    await userEvent.click(screen.getByLabelText('Close'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
