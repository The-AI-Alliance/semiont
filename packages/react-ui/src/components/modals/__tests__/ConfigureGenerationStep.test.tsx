/**
 * INFERENCE-LIMITS-EXPOSURE P3b — the max-length control is bounded by the
 * generation-serving agent's discovered output ceiling.
 *
 * The control was NOT previously unbounded: it shipped `min="100" max="4000"`.
 * So this phase replaces a hardcoded 4000 with the real ceiling, which for any
 * model above 4000 RAISES a cap users hit today, and for a smaller model
 * lowers it to something the provider will actually honour.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { CollaboratorEntry, GatheredContext } from '@semiont/core';
import { ConfigureGenerationStep } from '../ConfigureGenerationStep';

const translations = {
  resourceTitle: 'Title',
  resourceTitlePlaceholder: 'Title…',
  additionalInstructions: 'Instructions',
  additionalInstructionsPlaceholder: 'Instructions…',
  language: 'Language',
  languageHelp: 'Language help',
  creativity: 'Creativity',
  creativityFocused: 'Focused',
  creativityCreative: 'Creative',
  maxLength: 'Max length',
  maxLengthHelp: 'How long the generated resource may be.',
  // Named model + ceiling, so the bound is legible rather than mysterious (D6).
  maxLengthCeiling: 'Limited to {{maxOutputTokens}} tokens by {{model}}.',
  cancel: 'Cancel',
  back: 'Back',
  generate: 'Generate',
};

const context = { resources: [], annotations: [] } as unknown as GatheredContext;

const agentWithCeiling = (maxOutputTokens: number): CollaboratorEntry =>
  ({
    agent: {
      '@type': 'Software',
      name: 'Claude Sonnet 5',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    },
    servesJobTypes: ['generation'],
    limits: { contextTokens: 200_000, maxOutputTokens },
  }) as unknown as CollaboratorEntry;

function renderStep(generationAgent?: CollaboratorEntry) {
  const props = {
    defaultTitle: 'Untitled',
    locale: 'en',
    context,
    onBack: vi.fn(),
    onCancel: vi.fn(),
    onGenerate: vi.fn(),
    translations,
    ...(generationAgent ? { generationAgent } : {}),
  };
  const utils = render(<ConfigureGenerationStep {...props} />);
  const input = () => screen.getByLabelText('Max length') as HTMLInputElement;
  return { ...utils, input, props };
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText('Save location'), {
    target: { value: 'generated/out.md' },
  });
}

describe('ConfigureGenerationStep — ceiling awareness', () => {
  it('bounds the control by the agent ceiling and names it in help text', () => {
    const { input } = renderStep(agentWithCeiling(64_000));

    expect(input().max).toBe('64000');
    expect(screen.getByText(/Limited to 64000 tokens by claude-sonnet-5\./)).toBeInTheDocument();
  });

  it('will not commit a value above the ceiling', () => {
    // `max` on a number input does not prevent TYPING an over-value — it only
    // marks the field invalid. D6 says the value cannot be entered, so assert
    // the committed state, never the attribute alone.
    const { input } = renderStep(agentWithCeiling(2_000));

    fireEvent.change(input(), { target: { value: '9999' } });

    expect(input().value).toBe('2000');
  });

  it('clamps the 500 default down when the ceiling is smaller', () => {
    const { input } = renderStep(agentWithCeiling(300));

    expect(input().value).toBe('300');
  });

  it('re-bounds and clamps when the ceiling arrives AFTER mount', () => {
    // The case that decides whether this feature works in the app at all:
    // `browse.agents()` is asynchronous, so `generationAgent` is undefined on
    // first render and arrives later. An implementation that only consults the
    // ceiling in the `useState` initializer passes every test above and does
    // nothing in production.
    const { input, rerender } = renderStep(undefined);

    expect(input().max).toBe('4000');
    fireEvent.change(input(), { target: { value: '3000' } });
    expect(input().value).toBe('3000');

    rerender(
      <ConfigureGenerationStep
        defaultTitle="Untitled"
        locale="en"
        context={context}
        onBack={vi.fn()}
        onCancel={vi.fn()}
        onGenerate={vi.fn()}
        translations={translations}
        generationAgent={agentWithCeiling(1_000)}
      />,
    );

    expect(input().max).toBe('1000');
    // 3000 is now out of range and must not survive as a submittable value.
    expect(input().value).toBe('1000');
  });

  it('keeps a value that is still within a newly arrived ceiling', () => {
    const { input, rerender } = renderStep(undefined);
    fireEvent.change(input(), { target: { value: '800' } });

    rerender(
      <ConfigureGenerationStep
        defaultTitle="Untitled"
        locale="en"
        context={context}
        onBack={vi.fn()}
        onCancel={vi.fn()}
        onGenerate={vi.fn()}
        translations={translations}
        generationAgent={agentWithCeiling(4_000)}
      />,
    );

    expect(input().value).toBe('800');
  });

  it('falls back to today\'s bounds and copy without an agent (D3/D6 degradation)', () => {
    const { input } = renderStep(undefined);

    expect(input().min).toBe('100');
    expect(input().max).toBe('4000');
    expect(screen.getByText('How long the generated resource may be.')).toBeInTheDocument();
    expect(screen.queryByText(/Limited to/)).not.toBeInTheDocument();
  });

  it('falls back when the agent is present but discovery could not answer', () => {
    const noLimits = { ...agentWithCeiling(64_000) } as Record<string, unknown>;
    delete noLimits.limits;
    const { input } = renderStep(noLimits as unknown as CollaboratorEntry);

    expect(input().max).toBe('4000');
    expect(screen.queryByText(/Limited to/)).not.toBeInTheDocument();
  });

  it('submits the clamped value, not the typed one', () => {
    const onGenerate = vi.fn();
    render(
      <ConfigureGenerationStep
        defaultTitle="Untitled"
        locale="en"
        context={context}
        onBack={vi.fn()}
        onCancel={vi.fn()}
        onGenerate={onGenerate}
        translations={translations}
        generationAgent={agentWithCeiling(1_500)}
      />,
    );

    fillRequired();
    const input = screen.getByLabelText('Max length') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '8000' } });
    fireEvent.click(screen.getByText(/Generate/));

    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate.mock.calls[0]![0].maxTokens).toBe(1_500);
  });

  it('lets the field be cleared, and never submits NaN for it', () => {
    // Pre-existing hazard the clamp must not inherit: the handler was
    // `parseInt(e.target.value)` and `parseInt('')` is NaN, which React then
    // warns about and which would travel into the job config. Clearing must
    // stay possible (you cannot retype a number otherwise), so the contract is
    // about what SUBMITS, not about forbidding the empty state.
    const onGenerate = vi.fn();
    render(
      <ConfigureGenerationStep
        defaultTitle="Untitled"
        locale="en"
        context={context}
        onBack={vi.fn()}
        onCancel={vi.fn()}
        onGenerate={onGenerate}
        translations={translations}
        generationAgent={agentWithCeiling(4_000)}
      />,
    );
    const input = screen.getByLabelText('Max length') as HTMLInputElement;

    fillRequired();
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');

    fireEvent.click(screen.getByText(/Generate/));

    const submitted = onGenerate.mock.calls[0]![0].maxTokens;
    expect(Number.isFinite(submitted)).toBe(true);
    expect(submitted).toBeGreaterThanOrEqual(100);
    expect(submitted).toBeLessThanOrEqual(4_000);
  });
});
