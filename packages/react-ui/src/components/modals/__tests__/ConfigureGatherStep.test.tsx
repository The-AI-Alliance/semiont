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
  gather: 'Gather',
};

describe('ConfigureGatherStep', () => {
  it('renders the intro and the default option values', () => {
    render(<ConfigureGatherStep onGather={vi.fn()} translations={t} />);
    expect(screen.getByText('Choose what to include.')).toBeInTheDocument();
    expect(screen.getByLabelText('Include content')).toBeChecked();
    expect(screen.getByLabelText('Include summary')).toBeChecked();
    expect(screen.getByLabelText('Depth')).toHaveValue(2);
    expect(screen.getByLabelText('Max resources')).toHaveValue(10);
  });

  it('emits the default config on submit', () => {
    const onGather = vi.fn();
    render(<ConfigureGatherStep onGather={onGather} translations={t} />);
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    expect(onGather).toHaveBeenCalledWith({ includeContent: true, includeSummary: true, depth: 2, maxResources: 10 });
  });

  it('reflects edits in the emitted config', () => {
    const onGather = vi.fn();
    render(<ConfigureGatherStep onGather={onGather} translations={t} />);
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
       
        translations={t}
      />,
    );
    expect(screen.getByLabelText('Include summary')).not.toBeChecked();
    expect(screen.getByLabelText('Depth')).toHaveValue(1);
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    expect(onGather).toHaveBeenCalledWith({ includeContent: true, includeSummary: false, depth: 1, maxResources: 5 });
  });

  it('the footer is the wizard footer: advance only, no dismissal, no flex (GFR A5)', () => {
    // Dismissal lives on the modal's corner ✕/Esc/backdrop, never in a step
    // footer (WIZARD-NAVIGATION D1); this is the first step, so no retreat either.
    const { container } = render(<ConfigureGatherStep onGather={vi.fn()} translations={t} />);
    const footer = container.querySelector('.semiont-modal__actions--wizard');
    expect(footer).not.toBeNull();
    const buttons = Array.from(footer!.querySelectorAll('button'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).not.toMatch(/cancel|✕/i);
    expect(buttons[0]!.className).not.toContain('semiont-button--flex');
  });

  it('renders the children slot (exclusion picker)', () => {
    render(
      <ConfigureGatherStep onGather={vi.fn()} translations={t}>
        <div>EXCLUDE-SLOT</div>
      </ConfigureGatherStep>,
    );
    expect(screen.getByText('EXCLUDE-SLOT')).toBeInTheDocument();
  });
});
