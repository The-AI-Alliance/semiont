/**
 * GENERATE-FROM-BUTTON P2/P4 — the gather-options form.
 *
 * Pure presentational form (no providers): it owns the gather config in local
 * state and emits a `ResourceGatherConfig` on submit. The `children` slot hosts
 * the Phase-4 exclusion multi-select.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ConfigureGatherStep } from '../ConfigureGatherStep';

const t = {
  intro: 'Choose what to include.',
  includeContent: 'Include content',
  includeSummary: 'Include summary',
  depth: 'Depth',
  maxResources: 'Max resources',
  cancel: 'Cancel',
  gather: 'Gather',
};

describe('ConfigureGatherStep', () => {
  it('renders the intro and the default option values', () => {
    render(<ConfigureGatherStep onGather={vi.fn()} onCancel={vi.fn()} translations={t} />);
    expect(screen.getByText('Choose what to include.')).toBeInTheDocument();
    expect(screen.getByLabelText('Include content')).toBeChecked();
    expect(screen.getByLabelText('Include summary')).toBeChecked();
    expect(screen.getByLabelText('Depth')).toHaveValue(2);
    expect(screen.getByLabelText('Max resources')).toHaveValue(10);
  });

  it('emits the default config on submit', () => {
    const onGather = vi.fn();
    render(<ConfigureGatherStep onGather={onGather} onCancel={vi.fn()} translations={t} />);
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    expect(onGather).toHaveBeenCalledWith({ includeContent: true, includeSummary: true, depth: 2, maxResources: 10 });
  });

  it('reflects edits in the emitted config', () => {
    const onGather = vi.fn();
    render(<ConfigureGatherStep onGather={onGather} onCancel={vi.fn()} translations={t} />);
    fireEvent.click(screen.getByLabelText('Include content')); // uncheck
    fireEvent.click(screen.getByLabelText('Include summary')); // uncheck
    fireEvent.change(screen.getByLabelText('Depth'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Max resources'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    expect(onGather).toHaveBeenCalledWith({ includeContent: false, includeSummary: false, depth: 4, maxResources: 25 });
  });

  it('honors the defaults prop', () => {
    const onGather = vi.fn();
    render(
      <ConfigureGatherStep
        defaults={{ includeSummary: false, depth: 1, maxResources: 5 }}
        onGather={onGather}
        onCancel={vi.fn()}
        translations={t}
      />,
    );
    expect(screen.getByLabelText('Include summary')).not.toBeChecked();
    expect(screen.getByLabelText('Depth')).toHaveValue(1);
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    expect(onGather).toHaveBeenCalledWith({ includeContent: true, includeSummary: false, depth: 1, maxResources: 5 });
  });

  it('calls onCancel from the cancel button', () => {
    const onCancel = vi.fn();
    render(<ConfigureGatherStep onGather={vi.fn()} onCancel={onCancel} translations={t} />);
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders the children slot (exclusion picker)', () => {
    render(
      <ConfigureGatherStep onGather={vi.fn()} onCancel={vi.fn()} translations={t}>
        <div>EXCLUDE-SLOT</div>
      </ConfigureGatherStep>,
    );
    expect(screen.getByText('EXCLUDE-SLOT')).toBeInTheDocument();
  });
});
