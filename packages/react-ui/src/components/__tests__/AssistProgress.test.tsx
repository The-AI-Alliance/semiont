/**
 * AssistProgress (#7) — the ONE job-progress renderer, unifying the three
 * previous shapes (AssistSection's inline block, AnnotateReferencesProgressWidget,
 * TaggingPanel's inline block) plus the resource-generate flow.
 *
 * Contract: presentational and provider-free — no SemiontProvider, no session;
 * cancel/dismiss arrive as callbacks the caller wires (job.cancelRequest /
 * mark.dismissProgress). Feature blocks are data-presence-driven so each call
 * site keeps its current visuals by passing what it always had.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import type { components } from '@semiont/core';
import { AssistProgress } from '../AssistProgress';

type JobProgress = components['schemas']['JobProgress'];

const running = (over: Partial<JobProgress> = {}): JobProgress => ({
  stage: 'analyzing', percentage: 40, message: 'working on it', ...over,
});

describe('AssistProgress', () => {
  it('renders provider-free: message, params, and data hooks', () => {
    const { container } = render(
      <AssistProgress
        progress={running({ requestParams: [{ label: 'Density', value: '5' }] })}
        dataType="comment"
             />,
    );
    expect(screen.getByText('working on it')).toBeInTheDocument();
    expect(screen.getByText(/Density/)).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    const root = container.querySelector('.semiont-annotation-progress');
    expect(root).toHaveAttribute('data-type', 'comment');
    expect(root).toHaveAttribute('data-status', 'analyzing');
  });

  it('renders a title header only when given one', () => {
    const { rerender } = render(
      <AssistProgress progress={running()} dataType="reference" translations={{ title: 'Annotating Entity References' }} />,
    );
    expect(screen.getByText('Annotating Entity References')).toBeInTheDocument();
    rerender(<AssistProgress progress={running()} dataType="comment" />);
    expect(screen.queryByText('Annotating Entity References')).not.toBeInTheDocument();
  });

  it('shows cancel in the header while running, hides it once complete', async () => {
    // Cancel lives in the title header — both flows that offer cancel
    // (reference detection, generation) render the titled profile.
    const onCancel = vi.fn();
    const tr = { title: 'Generating Resource', cancel: 'Cancel Job' };
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
      <AssistProgress progress={running({ stage: 'error', message: 'it broke' })} dataType="generation" onCancel={onCancel} translations={tr} />,
    );
    expect(screen.queryByTitle('Cancel Job')).not.toBeInTheDocument();
  });

  it('stage branching: complete shows ✅ + complete copy, error shows ❌ + message', () => {
    const { rerender } = render(
      <AssistProgress progress={running({ stage: 'complete' })} dataType="reference" translations={{ complete: 'All done!' }} />,
    );
    expect(screen.getByText('All done!')).toBeInTheDocument();
    rerender(
      <AssistProgress progress={running({ stage: 'error', message: 'it broke' })} dataType="reference" translations={{ failed: 'Failed' }} />,
    );
    expect(screen.getByText('it broke')).toBeInTheDocument();
  });

  it('renders the completed entity-type log when data + formatter are present', () => {
    render(
      <AssistProgress
        progress={running({ completedEntityTypes: [{ entityType: 'Person', foundCount: 3 }] })}
        dataType="reference" translations={{ found: (n) => `Found ${n}` }}
      />,
    );
    expect(screen.getByText('Person:')).toBeInTheDocument();
    expect(screen.getByText('Found 3')).toBeInTheDocument();
  });

  it('renders the current-work detail line: entity type via formatter, category with counts', () => {
    const { rerender } = render(
      <AssistProgress
        progress={running({ currentEntityType: 'Location' })}
        dataType="reference" translations={{ current: (l) => `Processing: ${l}` }}
      />,
    );
    expect(screen.getByText('Processing: Location')).toBeInTheDocument();
    rerender(
      <AssistProgress
        progress={running({ currentCategory: 'Rule', processedCategories: 2, totalCategories: 5 })}
        dataType="tag"      />,
    );
    expect(screen.getByText(/Rule/)).toBeInTheDocument();
    expect(screen.getByText(/2\/5/)).toBeInTheDocument();
  });

  it('renders the percentage bar only when opted in', () => {
    const { container, rerender } = render(
      <AssistProgress progress={running({ percentage: 40 })} dataType="tag" showPercentBar />,
    );
    const fill = container.querySelector('.semiont-progress-bar__fill');
    expect(fill).toBeInTheDocument();
    expect(fill).toHaveStyle({ width: '40%' });
    rerender(
      <AssistProgress progress={running({ percentage: 40 })} dataType="reference" />,
    );
    expect(container.querySelector('.semiont-progress-bar__fill')).not.toBeInTheDocument();
  });

  it('renders dismiss whenever the caller offers it (WHEN is the caller\'s policy)', async () => {
    // AssistShell withholds onDismiss while the assist is running — that
    // gate is pinned in AssistShell.test; here the contract is just
    // "callback present → affordance rendered".
    const onDismiss = vi.fn();
    const { rerender } = render(
      <AssistProgress progress={running()} dataType="highlight" translations={{ close: 'Close' }} />,
    );
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
    rerender(
      <AssistProgress progress={running()} dataType="highlight"
        onDismiss={onDismiss} translations={{ close: 'Close' }} />,
    );
    await userEvent.click(screen.getByLabelText('Close'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
